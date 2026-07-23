/**
 * Regression guard for listObjectSizes' multi-page merge (#969 review). The
 * pagination decision (IsTruncated / NextContinuationToken -> fetch another
 * page) lives in listObjectPages, which builds its request URL from a
 * literal `<bucket>.s3.<region>.amazonaws.com` host with no override seam to
 * redirect to a local Bun.serve fake -- so this targets the extracted,
 * exported page-parser directly: feed it two synthetic ListBucketResult XML
 * pages (mirroring what two real pages would contain) and assert both merge
 * into one Map, keyed by the prefix-stripped annex key. No mocks -- pure
 * string parsing over plain data, same as the rest of the pagination logic
 * this module already exercises via listObjectKeys/getDatasetS3Stats.
 */

import { describe, expect, test } from "bun:test";
import { mergeObjectSizesPage } from "../src/services/s3";

const PREFIX = "on000001/objects/";

function page(entries: Array<{ key: string; size: number }>, truncated: boolean): string {
  const contents = entries
    .map(
      (e) =>
        `<Contents><Key>${e.key}</Key><LastModified>2026-07-20T00:00:00.000Z</LastModified><Size>${e.size}</Size></Contents>`,
    )
    .join("");
  const truncation = truncated
    ? "<IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken>"
    : "<IsTruncated>false</IsTruncated>";
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}${truncation}</ListBucketResult>`;
}

describe("mergeObjectSizesPage", () => {
  test("two pages merge into one Map with all keys from both", () => {
    const page1 = page(
      [
        { key: `${PREFIX}SHA256E-s10--a.edf`, size: 10 },
        { key: `${PREFIX}SHA256E-s20--b.edf`, size: 20 },
      ],
      true,
    );
    const page2 = page(
      [
        { key: `${PREFIX}SHA256E-s30--c.edf`, size: 30 },
        { key: `${PREFIX}SHA256E-s40--d.edf`, size: 40 },
      ],
      false,
    );

    const sizes = new Map<string, number>();
    mergeObjectSizesPage(page1, PREFIX, sizes);
    mergeObjectSizesPage(page2, PREFIX, sizes);

    expect(sizes.size).toBe(4);
    expect(sizes.get("SHA256E-s10--a.edf")).toBe(10);
    expect(sizes.get("SHA256E-s20--b.edf")).toBe(20);
    expect(sizes.get("SHA256E-s30--c.edf")).toBe(30);
    expect(sizes.get("SHA256E-s40--d.edf")).toBe(40);
  });

  test("a key repeated across pages (re-listed, e.g. a paginated boundary) keeps the later page's size", () => {
    const page1 = page([{ key: `${PREFIX}SHA256E-s10--a.edf`, size: 0 }], true);
    const page2 = page([{ key: `${PREFIX}SHA256E-s10--a.edf`, size: 10 }], false);

    const sizes = new Map<string, number>();
    mergeObjectSizesPage(page1, PREFIX, sizes);
    mergeObjectSizesPage(page2, PREFIX, sizes);

    expect(sizes.size).toBe(1);
    expect(sizes.get("SHA256E-s10--a.edf")).toBe(10);
  });

  test("keys outside the prefix are ignored on every page", () => {
    const page1 = page(
      [
        { key: `${PREFIX}SHA256E-s10--a.edf`, size: 10 },
        { key: "on000002/objects/SHA256E-s99--x.edf", size: 99 },
      ],
      false,
    );
    const sizes = new Map<string, number>();
    mergeObjectSizesPage(page1, PREFIX, sizes);
    expect(sizes.size).toBe(1);
    expect(sizes.has("SHA256E-s10--a.edf")).toBe(true);
  });

  test("the bare prefix placeholder key (zero-length stripped) is skipped", () => {
    const page1 = page([{ key: PREFIX, size: 0 }], false);
    const sizes = new Map<string, number>();
    mergeObjectSizesPage(page1, PREFIX, sizes);
    expect(sizes.size).toBe(0);
  });

  test("an empty page is a no-op merge", () => {
    const sizes = new Map<string, number>([["existing", 5]]);
    mergeObjectSizesPage(page([], false), PREFIX, sizes);
    expect(sizes.size).toBe(1);
    expect(sizes.get("existing")).toBe(5);
  });
});
