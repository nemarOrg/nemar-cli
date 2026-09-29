/**
 * A real local HTTP stand-in for S3 (plus STS) that `scripts/rename-archives.ts`
 * is run against as a subprocess, through `AWS_ENDPOINT_URL_S3` /
 * `AWS_ENDPOINT_URL_STS`, so the rename-archives entry-point tests exercise
 * the real `aws` CLI end to end rather than a mock of it.
 *
 * Implements just the calls the script actually makes (every request shape
 * below was confirmed against aws-cli 2.36.47 by watching its real requests
 * hit a logging probe before this was written):
 *
 *  - `GET /<bucket>?list-type=2&prefix=...` (ListObjectsV2)
 *  - `HEAD /<bucket>/<key>` (HeadObject -- the script's own checks AND
 *    `aws s3 cp`'s own preflight HEAD of the copy source)
 *  - `PUT /<bucket>/<key>` with `x-amz-copy-source: <bucket>/<key>` (the
 *    single-call CopyObject a small object's `aws s3 cp` issues)
 *  - the multipart copy `aws s3 cp` switches to at 8 MiB and above:
 *    `POST ?uploads` (CreateMultipartUpload), `PUT ?partNumber&uploadId`
 *    with `x-amz-copy-source-range` (UploadPartCopy), `POST ?uploadId`
 *    (CompleteMultipartUpload) and `DELETE ?uploadId` (AbortMultipartUpload).
 *    No object bytes ever move, so an "archive" of 20 MiB or 600 GiB costs the
 *    same: sizes come from the copy-range headers.
 *  - `PUT /<bucket>/<key>?tagging` / `GET /<bucket>/<key>?tagging`
 *  - `GET /<bucket>?versions&prefix=<key>` (ListObjectVersions). Like real S3
 *    this is a PREFIX match across keys, lists every version and delete marker
 *    per key newest first, and flags exactly one entry per key IsLatest.
 *  - `DELETE /<bucket>/<key>?versionId=<id>` (removes exactly that version;
 *    a DELETE with no versionId adds a delete marker, as on a versioned
 *    bucket, so a test can prove the script never issues one)
 *  - `POST /` on a separate origin (STS GetCallerIdentity, for
 *    `scripts/lib/aws-creds-guard.sh`)
 *
 * Keys are multi-version: `putObject` pushes a NEW version on top of whatever
 * is already there, exactly as a rebuild does, and deleting the current
 * version by id lets an older one become current again, exactly as S3 does.
 *
 * Every request is logged, structured by operation, so a test asserts on what
 * the real CLI actually sent rather than on what the code under test says it
 * did. Faults (an error from one operation, a write S3 acknowledges but does
 * not apply, a multipart object that completes one byte short, a request that
 * never answers, state that changes between two of the script's calls) are
 * injected explicitly by the test that needs them.
 */

import type { Server } from "bun";

export interface StoredVersion {
  versionId: string;
  size: number;
  etag: string;
  lastModified: string;
  tags: Record<string, string>;
  deleteMarker: boolean;
}

export type StandinOp =
  | "ListObjectsV2"
  | "ListObjectVersions"
  | "HeadObject"
  | "CopyObject"
  | "CreateMultipartUpload"
  | "UploadPartCopy"
  | "CompleteMultipartUpload"
  | "AbortMultipartUpload"
  | "PutObjectTagging"
  | "GetObjectTagging"
  | "DeleteObject";

export type StandinLogEntry =
  | { op: "ListObjectsV2"; bucket: string; prefix: string }
  | { op: "ListObjectVersions"; bucket: string; prefix: string }
  | { op: "HeadObject"; bucket: string; key: string; status: number }
  | { op: "CopyObject"; bucket: string; sourceKey: string; destKey: string; status: number }
  | { op: "CreateMultipartUpload"; bucket: string; key: string }
  | {
      op: "UploadPartCopy";
      bucket: string;
      key: string;
      partNumber: number;
      size: number;
      status: number;
    }
  | { op: "CompleteMultipartUpload"; bucket: string; key: string; size: number; status: number }
  | { op: "AbortMultipartUpload"; bucket: string; key: string }
  | { op: "PutObjectTagging"; bucket: string; key: string; body: string; status: number }
  | { op: "GetObjectTagging"; bucket: string; key: string; status: number }
  | { op: "DeleteObject"; bucket: string; key: string; versionId: string | null; status: number }
  | { op: "GetCallerIdentity" }
  | { op: "Unknown"; method: string; path: string; search: string };

export interface Fault {
  code: string;
  status: number;
  /** Let this many matching calls through before failing. */
  after?: number;
  /** Fail this many matching calls, then behave normally (default: all). */
  times?: number;
  /** Only calls for this key. */
  key?: string;
}

let versionCounter = 0;
function nextVersionId(): string {
  versionCounter += 1;
  return `standin-v${versionCounter}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Pull every `<Tag><Key>k</Key><Value>v</Value></Tag>` pair out of a
 *  PutObjectTagging request body. The CLI's body shape was confirmed by
 *  watching a real `aws s3api put-object-tagging` request. */
function parseTaggingBody(body: string): Record<string, string> {
  const tags: Record<string, string> = {};
  const tagRe = /<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g;
  for (const match of body.matchAll(tagRe)) {
    tags[xmlUnescape(match[1])] = xmlUnescape(match[2]);
  }
  return tags;
}

/** The SigV4 credential scope's region, e.g. `us-east-2` from
 *  `Credential=AKID/20260929/us-east-2/s3/aws4_request`. */
function regionOf(authorization: string | null): string | null {
  const m = /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(authorization ?? "");
  return m ? m[1] : null;
}

export interface RenameS3Standin {
  /** Value for AWS_ENDPOINT_URL_S3. */
  s3Url: string;
  /** Value for AWS_ENDPOINT_URL_STS. */
  stsUrl: string;
  log: StandinLogEntry[];
  /** Signing regions the CLI actually used, per service. */
  regions: { s3: Set<string>; sts: Set<string> };
  /** Push a NEW version on top of the key (as a rebuild does). Returns its version id. */
  putObject(
    bucket: string,
    key: string,
    opts: { size: number; etag: string; lastModified: string; tags?: Record<string, string> },
  ): string;
  /** Push a delete marker on top of the key. Returns its version id. */
  putDeleteMarker(bucket: string, key: string): string;
  /** The key's current version, or undefined when absent or hidden by a marker. */
  getObject(bucket: string, key: string): StoredVersion | undefined;
  /** Every stored version of the key, oldest first. */
  versions(bucket: string, key: string): StoredVersion[];
  /** True if the key has a current (non-marker) version. */
  has(bucket: string, key: string): boolean;
  /** Make one operation fail with an S3 error XML. */
  inject(op: StandinOp, fault: Fault): void;
  /** Stop injecting faults (the "credentials refreshed, run it again" case). */
  clearFaults(): void;
  /** Make the NEXT PutObjectTagging on this bucket/key fail with a
   *  non-retryable 403 AccessDenied (one-shot; consumed on use). */
  failNextPutTagging(bucket: string, key: string): void;
  /** Make the NEXT PutObjectTagging on this bucket/key answer 200 without
   *  applying anything (a write S3 acknowledged but did not keep). */
  ignoreNextPutTagging(bucket: string, key: string): void;
  /** Make the NEXT CompleteMultipartUpload store an object this many bytes short. */
  shortenNextMultipartCompleteBy(bytes: number): void;
  /** Make the NEXT HeadObject of this key never answer (the CLI's read
   *  timeout fires, and its error text embeds the request URL). */
  hangNextHead(bucket: string, key: string): void;
  /** Run `fn` just before the Nth call (1-based) of `op` is handled. */
  beforeOp(op: StandinOp, fn: () => void, nth?: number): void;
  stop(): void;
}

export function startRenameS3Standin(): RenameS3Standin {
  const store = new Map<string, StoredVersion[]>(); // oldest -> newest
  const uploads = new Map<string, { bucket: string; key: string; parts: Map<number, number> }>();
  const log: StandinLogEntry[] = [];
  const regions = { s3: new Set<string>(), sts: new Set<string>() };
  const faults = new Map<StandinOp, Array<Fault & { seen: number; failed: number }>>();
  const ignoredTaggingWrites = new Set<string>();
  const hangingHeads = new Set<string>();
  const hooks = new Map<StandinOp, Array<{ fn: () => void; nth: number }>>();
  const opCounts = new Map<StandinOp, number>();
  const shorten = { bytes: 0 };
  const objKey = (bucket: string, key: string) => `${bucket}/${key}`;
  const current = (bucket: string, key: string): StoredVersion | undefined => {
    const vs = store.get(objKey(bucket, key));
    return vs && vs.length > 0 ? vs[vs.length - 1] : undefined;
  };
  const live = (bucket: string, key: string): StoredVersion | undefined => {
    const v = current(bucket, key);
    return v && !v.deleteMarker ? v : undefined;
  };

  /** Runs the hooks for this call, then returns the fault to apply, if any. */
  const enter = (op: StandinOp, key: string): Fault | null => {
    const n = (opCounts.get(op) ?? 0) + 1;
    opCounts.set(op, n);
    for (const h of hooks.get(op) ?? []) {
      if (h.nth === n) h.fn();
    }
    for (const f of faults.get(op) ?? []) {
      if (f.key !== undefined && f.key !== key) continue;
      f.seen += 1;
      if (f.seen <= (f.after ?? 0)) continue;
      if (f.times !== undefined && f.failed >= f.times) continue;
      f.failed += 1;
      return f;
    }
    return null;
  };
  const faultResponse = (f: Fault) =>
    new Response(
      `<Error><Code>${f.code}</Code><Message>induced ${f.code} (test)</Message></Error>`,
      {
        status: f.status,
        headers: { "Content-Type": "application/xml" },
      },
    );

  const s3Server: Server = Bun.serve({
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      const segments = path.slice(1).split("/");
      const bucket = segments[0] ?? "";
      const key = segments.slice(1).join("/");
      const search = url.searchParams;
      const region = regionOf(req.headers.get("authorization"));
      if (region) regions.s3.add(region);

      // Bucket-root operations (no key segment): ListObjectsV2 / ListObjectVersions.
      if (key === "") {
        if (search.get("list-type") === "2") {
          const prefix = search.get("prefix") ?? "";
          log.push({ op: "ListObjectsV2", bucket, prefix });
          const fault = enter("ListObjectsV2", prefix);
          if (fault) return faultResponse(fault);
          const contents = [...store.keys()]
            .filter((k) => k.startsWith(`${bucket}/${prefix}`))
            .sort()
            .map((k) => ({
              objectKey: k.slice(bucket.length + 1),
              v: current(bucket, k.slice(bucket.length + 1)),
            }))
            .filter(({ v }) => v && !v.deleteMarker)
            .map(
              ({ objectKey, v }) =>
                `<Contents><Key>${xmlEscape(objectKey)}</Key><LastModified>${v?.lastModified}</LastModified><ETag>${xmlEscape(v?.etag ?? "")}</ETag><Size>${v?.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
            )
            .join("");
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
            { status: 200, headers: { "Content-Type": "application/xml" } },
          );
        }
        if (search.has("versions")) {
          const prefix = search.get("prefix") ?? "";
          log.push({ op: "ListObjectVersions", bucket, prefix });
          const fault = enter("ListObjectVersions", prefix);
          if (fault) return faultResponse(fault);
          let xml = "";
          for (const k of [...store.keys()]
            .filter((k) => k.startsWith(`${bucket}/${prefix}`))
            .sort()) {
            const objectKey = k.slice(bucket.length + 1);
            const vs = [...(store.get(k) ?? [])].reverse();
            vs.forEach((v, i) => {
              const tag = v.deleteMarker ? "DeleteMarker" : "Version";
              const body = v.deleteMarker
                ? ""
                : `<ETag>${xmlEscape(v.etag)}</ETag><Size>${v.size}</Size><StorageClass>STANDARD</StorageClass>`;
              xml += `<${tag}><Key>${xmlEscape(objectKey)}</Key><VersionId>${v.versionId}</VersionId><IsLatest>${i === 0}</IsLatest><LastModified>${v.lastModified}</LastModified>${body}</${tag}>`;
            });
          }
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>false</IsTruncated>${xml}</ListVersionsResult>`,
            { status: 200, headers: { "Content-Type": "application/xml" } },
          );
        }
        log.push({ op: "Unknown", method: req.method, path, search: url.search });
        return new Response("<Error><Code>NotImplemented</Code></Error>", { status: 501 });
      }

      // Keyed operations.
      if (req.method === "HEAD") {
        const hangKey = objKey(bucket, key);
        if (hangingHeads.has(hangKey)) {
          hangingHeads.delete(hangKey);
          log.push({ op: "HeadObject", bucket, key, status: 0 });
          // Never answer; have Bun drop the idle connection after 1s (its
          // default is 10s) so the CLI reports "Connection was closed before
          // we received a valid response from endpoint URL: ...<key>".
          server.timeout(req, 1);
          await new Promise<void>((resolve) => {
            req.signal.addEventListener("abort", () => resolve());
          });
          return new Response(null, { status: 499 });
        }
        const fault = enter("HeadObject", key);
        if (fault) {
          log.push({ op: "HeadObject", bucket, key, status: fault.status });
          return new Response(null, { status: fault.status });
        }
        const v = live(bucket, key);
        log.push({ op: "HeadObject", bucket, key, status: v ? 200 : 404 });
        if (!v) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Length": String(v.size),
            ETag: v.etag,
            "Last-Modified": new Date(v.lastModified).toUTCString(),
            "Content-Type": "application/zip",
          },
        });
      }

      // CreateMultipartUpload
      if (req.method === "POST" && search.has("uploads")) {
        log.push({ op: "CreateMultipartUpload", bucket, key });
        const fault = enter("CreateMultipartUpload", key);
        if (fault) return faultResponse(fault);
        const id = `upload-${nextVersionId()}`;
        uploads.set(id, { bucket, key, parts: new Map() });
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }

      // UploadPartCopy: a PUT with partNumber+uploadId (it also carries
      // x-amz-copy-source, so it must be matched before plain CopyObject).
      if (req.method === "PUT" && search.has("partNumber") && search.has("uploadId")) {
        const partNumber = Number(search.get("partNumber"));
        const range = /bytes=(\d+)-(\d+)/.exec(req.headers.get("x-amz-copy-source-range") ?? "");
        const size = range ? Number(range[2]) - Number(range[1]) + 1 : 0;
        const fault = enter("UploadPartCopy", key);
        if (fault) {
          log.push({ op: "UploadPartCopy", bucket, key, partNumber, size, status: fault.status });
          return faultResponse(fault);
        }
        uploads.get(search.get("uploadId") ?? "")?.parts.set(partNumber, size);
        log.push({ op: "UploadPartCopy", bucket, key, partNumber, size, status: 200 });
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><CopyPartResult><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"part${partNumber}"</ETag></CopyPartResult>`,
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }

      // CompleteMultipartUpload
      if (req.method === "POST" && search.has("uploadId")) {
        await req.text();
        const upload = uploads.get(search.get("uploadId") ?? "");
        const fault = enter("CompleteMultipartUpload", key);
        if (fault) {
          log.push({ op: "CompleteMultipartUpload", bucket, key, size: 0, status: fault.status });
          return faultResponse(fault);
        }
        if (!upload) {
          log.push({ op: "CompleteMultipartUpload", bucket, key, size: 0, status: 404 });
          return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
        }
        const total = [...upload.parts.values()].reduce((a, b) => a + b, 0) - shorten.bytes;
        shorten.bytes = 0;
        const n = upload.parts.size;
        const version: StoredVersion = {
          versionId: nextVersionId(),
          size: total,
          // The multipart-form ETag S3 gives a completed multipart upload.
          etag: `"${versionCounter.toString(16).padStart(32, "0")}-${n}"`,
          lastModified: new Date().toISOString(),
          tags: {},
          deleteMarker: false,
        };
        const arr = store.get(objKey(upload.bucket, upload.key)) ?? [];
        arr.push(version);
        store.set(objKey(upload.bucket, upload.key), arr);
        uploads.delete(search.get("uploadId") ?? "");
        log.push({ op: "CompleteMultipartUpload", bucket, key, size: total, status: 200 });
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>http://standin/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(version.etag)}</ETag></CompleteMultipartUploadResult>`,
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }

      // AbortMultipartUpload
      if (req.method === "DELETE" && search.has("uploadId")) {
        uploads.delete(search.get("uploadId") ?? "");
        log.push({ op: "AbortMultipartUpload", bucket, key });
        return new Response(null, { status: 204 });
      }

      // Single-call CopyObject. Real shape (no leading slash): "<bucket>/<key>".
      if (req.method === "PUT" && req.headers.has("x-amz-copy-source")) {
        const source = req.headers.get("x-amz-copy-source") ?? "";
        const slash = source.indexOf("/");
        const sourceBucket = slash === -1 ? source : source.slice(0, slash);
        const sourceKey = slash === -1 ? "" : decodeURIComponent(source.slice(slash + 1));
        const fault = enter("CopyObject", key);
        if (fault) {
          log.push({ op: "CopyObject", bucket, sourceKey, destKey: key, status: fault.status });
          return faultResponse(fault);
        }
        const src = live(sourceBucket, sourceKey);
        if (!src) {
          log.push({ op: "CopyObject", bucket, sourceKey, destKey: key, status: 404 });
          return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        }
        const dest: StoredVersion = {
          versionId: nextVersionId(),
          size: src.size,
          etag: src.etag,
          lastModified: src.lastModified,
          tags: {},
          deleteMarker: false,
        };
        const arr = store.get(objKey(bucket, key)) ?? [];
        arr.push(dest);
        store.set(objKey(bucket, key), arr);
        log.push({ op: "CopyObject", bucket, sourceKey, destKey: key, status: 200 });
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${dest.lastModified}</LastModified><ETag>${xmlEscape(dest.etag)}</ETag></CopyObjectResult>`,
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }

      if (req.method === "PUT" && search.has("tagging")) {
        const fk = objKey(bucket, key);
        const body = await req.text();
        const fault = enter("PutObjectTagging", key);
        if (fault) {
          log.push({ op: "PutObjectTagging", bucket, key, body, status: fault.status });
          return faultResponse(fault);
        }
        const v = live(bucket, key);
        if (!v) {
          log.push({ op: "PutObjectTagging", bucket, key, body, status: 404 });
          return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        }
        if (ignoredTaggingWrites.has(fk)) {
          ignoredTaggingWrites.delete(fk);
        } else {
          v.tags = parseTaggingBody(body);
        }
        log.push({ op: "PutObjectTagging", bucket, key, body, status: 200 });
        return new Response(null, { status: 200 });
      }

      if (req.method === "GET" && search.has("tagging")) {
        const fault = enter("GetObjectTagging", key);
        if (fault) {
          log.push({ op: "GetObjectTagging", bucket, key, status: fault.status });
          return faultResponse(fault);
        }
        const v = live(bucket, key);
        if (!v) {
          log.push({ op: "GetObjectTagging", bucket, key, status: 404 });
          return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        }
        log.push({ op: "GetObjectTagging", bucket, key, status: 200 });
        const tagXml = Object.entries(v.tags)
          .map(
            ([k, val]) => `<Tag><Key>${xmlEscape(k)}</Key><Value>${xmlEscape(val)}</Value></Tag>`,
          )
          .join("");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${tagXml}</TagSet></Tagging>`,
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }

      if (req.method === "DELETE") {
        const versionId = search.get("versionId");
        const fault = enter("DeleteObject", key);
        if (fault) {
          log.push({ op: "DeleteObject", bucket, key, versionId, status: fault.status });
          return faultResponse(fault);
        }
        const fk = objKey(bucket, key);
        const arr = store.get(fk) ?? [];
        if (!versionId) {
          // A bare DELETE on a versioned bucket only adds a delete marker.
          arr.push({
            versionId: nextVersionId(),
            size: 0,
            etag: "",
            lastModified: new Date().toISOString(),
            tags: {},
            deleteMarker: true,
          });
          store.set(fk, arr);
          log.push({ op: "DeleteObject", bucket, key, versionId: null, status: 204 });
          return new Response(null, { status: 204 });
        }
        const idx = arr.findIndex((v) => v.versionId === versionId);
        if (idx >= 0) {
          arr.splice(idx, 1);
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
      const region = regionOf(req.headers.get("authorization"));
      if (region) regions.sts.add(region);
      log.push({ op: "GetCallerIdentity" });
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/rename-archives-standin</Arn><UserId>AIDASTANDIN00000000</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>standin-request-id</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    },
  });

  const push = (bucket: string, key: string, v: StoredVersion): string => {
    const arr = store.get(objKey(bucket, key)) ?? [];
    arr.push(v);
    store.set(objKey(bucket, key), arr);
    return v.versionId;
  };

  return {
    s3Url: `http://127.0.0.1:${s3Server.port}`,
    stsUrl: `http://127.0.0.1:${stsServer.port}`,
    log,
    regions,
    putObject(bucket, key, opts) {
      return push(bucket, key, {
        versionId: nextVersionId(),
        size: opts.size,
        etag: opts.etag,
        lastModified: opts.lastModified,
        tags: opts.tags ? { ...opts.tags } : {},
        deleteMarker: false,
      });
    },
    putDeleteMarker(bucket, key) {
      return push(bucket, key, {
        versionId: nextVersionId(),
        size: 0,
        etag: "",
        lastModified: new Date().toISOString(),
        tags: {},
        deleteMarker: true,
      });
    },
    getObject: (bucket, key) => live(bucket, key),
    versions: (bucket, key) => [...(store.get(objKey(bucket, key)) ?? [])],
    has: (bucket, key) => live(bucket, key) !== undefined,
    inject(op, fault) {
      const list = faults.get(op) ?? [];
      list.push({ ...fault, seen: 0, failed: 0 });
      faults.set(op, list);
    },
    clearFaults() {
      faults.clear();
    },
    failNextPutTagging(_bucket, key) {
      const list = faults.get("PutObjectTagging") ?? [];
      list.push({ code: "AccessDenied", status: 403, key, times: 1, seen: 0, failed: 0 });
      faults.set("PutObjectTagging", list);
    },
    ignoreNextPutTagging(bucket, key) {
      ignoredTaggingWrites.add(objKey(bucket, key));
    },
    shortenNextMultipartCompleteBy(bytes) {
      shorten.bytes = bytes;
    },
    hangNextHead(bucket, key) {
      hangingHeads.add(objKey(bucket, key));
    },
    beforeOp(op, fn, nth = 1) {
      const list = hooks.get(op) ?? [];
      list.push({ fn, nth });
      hooks.set(op, list);
    },
    stop() {
      s3Server.stop(true);
      stsServer.stop(true);
    },
  };
}
