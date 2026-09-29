/**
 * A real local HTTP stand-in for S3 (plus STS) that `scripts/rename-archives.ts`
 * is run against as a subprocess, through `AWS_ENDPOINT_URL_S3` /
 * `AWS_ENDPOINT_URL_STS`, so `test/rename-archives-tagging.test.ts` exercises
 * the real `aws` CLI end to end rather than a mock of it.
 *
 * Implements just the calls the script actually makes (verified empirically
 * against aws-cli 2.36.47 by watching its real requests hit a logging probe
 * before this was written):
 *
 *  - `GET /<bucket>?list-type=2&prefix=...` (ListObjectsV2, used to list a
 *    dataset's current archive objects)
 *  - `HEAD /<bucket>/<key>` (HeadObject -- both the script's own destination
 *    checks and `aws s3 cp`'s own preflight HEAD of the copy source)
 *  - `PUT /<bucket>/<key>` with an `x-amz-copy-source: <bucket>/<key>` header
 *    (the single-call CopyObject a small object's `aws s3 cp` issues)
 *  - `PUT /<bucket>/<key>?tagging` (PutObjectTagging, body is the real
 *    `<Tagging><TagSet><Tag>...` XML the CLI sends)
 *  - `GET /<bucket>/<key>?tagging` (GetObjectTagging)
 *  - `GET /<bucket>?versions&prefix=<key>` (ListObjectVersions, used to
 *    resolve the exact version id to delete)
 *  - `DELETE /<bucket>/<key>?versionId=<id>` (DeleteObject by version id)
 *  - `POST /` on a separate origin (STS GetCallerIdentity, for
 *    `scripts/lib/aws-creds-guard.sh`)
 *
 * Every request is logged, structured by operation, so a test asserts on
 * what the real CLI actually sent rather than on what the code under test
 * says it did.
 */

import type { Server } from "bun";

interface StoredObject {
  size: number;
  etag: string;
  lastModified: string;
  versionId: string;
  tags: Record<string, string>;
}

export type StandinLogEntry =
  | { op: "ListObjectsV2"; bucket: string; prefix: string }
  | { op: "ListObjectVersions"; bucket: string; prefix: string }
  | { op: "HeadObject"; bucket: string; key: string; status: number }
  | { op: "CopyObject"; bucket: string; sourceKey: string; destKey: string; status: number }
  | { op: "PutObjectTagging"; bucket: string; key: string; body: string; status: number }
  | { op: "GetObjectTagging"; bucket: string; key: string; status: number }
  | { op: "DeleteObject"; bucket: string; key: string; versionId: string | null; status: number }
  | { op: "GetCallerIdentity" }
  | { op: "Unknown"; method: string; path: string; search: string };

let versionCounter = 0;
function nextVersionId(): string {
  versionCounter += 1;
  return `standin-v${versionCounter}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Pull every `<Tag><Key>k</Key><Value>v</Value></Tag>` pair out of a
 *  PutObjectTagging request body. The CLI's body shape was confirmed by
 *  watching a real `aws s3api put-object-tagging` request. */
function parseTaggingBody(body: string): Record<string, string> {
  const tags: Record<string, string> = {};
  const tagRe = /<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g;
  for (const match of body.matchAll(tagRe)) {
    tags[match[1]] = match[2];
  }
  return tags;
}

export interface RenameS3Standin {
  /** Value for AWS_ENDPOINT_URL_S3. */
  s3Url: string;
  /** Value for AWS_ENDPOINT_URL_STS. */
  stsUrl: string;
  log: StandinLogEntry[];
  /** Seed (or overwrite) an object. `tags` defaults to untagged. */
  putObject(
    bucket: string,
    key: string,
    opts: { size: number; etag: string; lastModified: string; tags?: Record<string, string> },
  ): void;
  getObject(bucket: string, key: string): StoredObject | undefined;
  /** True if `bucket/key` still exists. */
  has(bucket: string, key: string): boolean;
  /** Make the NEXT PutObjectTagging on this bucket/key fail with a
   *  non-retryable 403 AccessDenied (one-shot; consumed on use). */
  failNextPutTagging(bucket: string, key: string): void;
  stop(): void;
}

export function startRenameS3Standin(): RenameS3Standin {
  const objects = new Map<string, StoredObject>();
  const log: StandinLogEntry[] = [];
  const taggingFailures = new Set<string>();
  const objKey = (bucket: string, key: string) => `${bucket}/${key}`;

  const s3Server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      const segments = path.slice(1).split("/");
      const bucket = segments[0] ?? "";
      const key = segments.slice(1).join("/");
      const search = url.searchParams;

      // Bucket-root operations (no key segment): ListObjectsV2 / ListObjectVersions.
      if (key === "") {
        if (search.get("list-type") === "2") {
          const prefix = search.get("prefix") ?? "";
          log.push({ op: "ListObjectsV2", bucket, prefix });
          const contents = [...objects.entries()]
            .filter(
              ([k, v]) =>
                k.startsWith(`${bucket}/`) && k.slice(bucket.length + 1).startsWith(prefix),
            )
            .map(([k, v]) => {
              const objectKey = k.slice(bucket.length + 1);
              return `<Contents><Key>${xmlEscape(objectKey)}</Key><LastModified>${v.lastModified}</LastModified><ETag>${xmlEscape(v.etag)}</ETag><Size>${v.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
            })
            .join("");
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
            { status: 200, headers: { "Content-Type": "application/xml" } },
          );
        }
        if (search.has("versions")) {
          const prefix = search.get("prefix") ?? "";
          log.push({ op: "ListObjectVersions", bucket, prefix });
          const versions = [...objects.entries()]
            .filter(([k]) => k === `${bucket}/${prefix}`)
            .map(([k, v]) => {
              const objectKey = k.slice(bucket.length + 1);
              return `<Version><Key>${xmlEscape(objectKey)}</Key><VersionId>${v.versionId}</VersionId><IsLatest>true</IsLatest><LastModified>${v.lastModified}</LastModified><ETag>${xmlEscape(v.etag)}</ETag><Size>${v.size}</Size><StorageClass>STANDARD</StorageClass></Version>`;
            })
            .join("");
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>false</IsTruncated>${versions}</ListVersionsResult>`,
            { status: 200, headers: { "Content-Type": "application/xml" } },
          );
        }
        log.push({ op: "Unknown", method: req.method, path, search: url.search });
        return new Response("<Error><Code>NotImplemented</Code></Error>", { status: 501 });
      }

      // Keyed operations.
      if (req.method === "HEAD") {
        const obj = objects.get(objKey(bucket, key));
        const status = obj ? 200 : 404;
        log.push({ op: "HeadObject", bucket, key, status });
        if (!obj) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Length": String(obj.size),
            ETag: obj.etag,
            "Last-Modified": new Date(obj.lastModified).toUTCString(),
          },
        });
      }

      if (req.method === "PUT" && req.headers.has("x-amz-copy-source")) {
        // Real shape (no leading slash): "<bucket>/<key>".
        const source = req.headers.get("x-amz-copy-source") ?? "";
        const slash = source.indexOf("/");
        const sourceBucket = slash === -1 ? source : source.slice(0, slash);
        const sourceKey = slash === -1 ? "" : source.slice(slash + 1);
        const src = objects.get(objKey(sourceBucket, sourceKey));
        if (!src) {
          log.push({ op: "CopyObject", bucket, sourceKey, destKey: key, status: 404 });
          return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        }
        const dest: StoredObject = {
          size: src.size,
          etag: src.etag,
          lastModified: src.lastModified,
          versionId: nextVersionId(),
          tags: {},
        };
        objects.set(objKey(bucket, key), dest);
        log.push({ op: "CopyObject", bucket, sourceKey, destKey: key, status: 200 });
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${dest.lastModified}</LastModified><ETag>${xmlEscape(dest.etag)}</ETag></CopyObjectResult>`,
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }

      if (req.method === "PUT" && search.has("tagging")) {
        const fk = objKey(bucket, key);
        if (taggingFailures.has(fk)) {
          taggingFailures.delete(fk);
          log.push({ op: "PutObjectTagging", bucket, key, body: "", status: 403 });
          return new Response(
            "<Error><Code>AccessDenied</Code><Message>induced failure (test)</Message></Error>",
            { status: 403, headers: { "Content-Type": "application/xml" } },
          );
        }
        const body = await req.text();
        const obj = objects.get(fk);
        if (!obj) {
          log.push({ op: "PutObjectTagging", bucket, key, body, status: 404 });
          return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        }
        obj.tags = parseTaggingBody(body);
        log.push({ op: "PutObjectTagging", bucket, key, body, status: 200 });
        return new Response(null, { status: 200 });
      }

      if (req.method === "GET" && search.has("tagging")) {
        const obj = objects.get(objKey(bucket, key));
        if (!obj) {
          log.push({ op: "GetObjectTagging", bucket, key, status: 404 });
          return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        }
        log.push({ op: "GetObjectTagging", bucket, key, status: 200 });
        const tagXml = Object.entries(obj.tags)
          .map(([k, v]) => `<Tag><Key>${xmlEscape(k)}</Key><Value>${xmlEscape(v)}</Value></Tag>`)
          .join("");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${tagXml}</TagSet></Tagging>`,
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }

      if (req.method === "DELETE") {
        const versionId = search.get("versionId");
        const fk = objKey(bucket, key);
        const obj = objects.get(fk);
        if (obj && versionId && obj.versionId === versionId) {
          objects.delete(fk);
          log.push({ op: "DeleteObject", bucket, key, versionId, status: 204 });
          return new Response(null, { status: 204, headers: { "x-amz-version-id": versionId } });
        }
        log.push({ op: "DeleteObject", bucket, key, versionId, status: 404 });
        return new Response("<Error><Code>NoSuchVersion</Code></Error>", { status: 404 });
      }

      log.push({ op: "Unknown", method: req.method, path, search: url.search });
      return new Response("<Error><Code>NotImplemented</Code></Error>", { status: 501 });
    },
  });

  const stsServer: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.text();
      log.push({ op: "GetCallerIdentity" });
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/rename-archives-standin</Arn><UserId>AIDASTANDIN00000000</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>standin-request-id</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    },
  });

  return {
    s3Url: `http://127.0.0.1:${s3Server.port}`,
    stsUrl: `http://127.0.0.1:${stsServer.port}`,
    log,
    putObject(bucket, key, opts) {
      objects.set(objKey(bucket, key), {
        size: opts.size,
        etag: opts.etag,
        lastModified: opts.lastModified,
        versionId: nextVersionId(),
        tags: opts.tags ? { ...opts.tags } : {},
      });
    },
    getObject(bucket, key) {
      return objects.get(objKey(bucket, key));
    },
    has(bucket, key) {
      return objects.has(objKey(bucket, key));
    },
    failNextPutTagging(bucket, key) {
      taggingFailures.add(objKey(bucket, key));
    },
    stop() {
      s3Server.stop(true);
      stsServer.stop(true);
    },
  };
}
