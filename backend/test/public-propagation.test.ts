/**
 * Tests for the public-access propagation gate's pure XML parsing
 * (epic #736, Phase 4 / #741). The poll itself (anonymous HEAD against S3) is
 * exercised live; here we cover firstObjectKeyFromListXml against real
 * ListBucketResult shapes. No mocks.
 */

import { describe, expect, test } from "bun:test";
import { firstObjectKeyFromListXml } from "../src/services/s3";

const PAGE_WITH_OBJECTS = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>nemar</Name>
  <Prefix>nm000111/objects/</Prefix>
  <KeyCount>2</KeyCount>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>nm000111/objects/SHA256E-s91778304--900755de.edf</Key>
    <LastModified>2026-06-10T16:00:00.000Z</LastModified>
    <Size>91778304</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>nm000111/objects/SHA256E-s58458112--114113de.edf</Key>
    <LastModified>2026-06-10T16:00:01.000Z</LastModified>
    <Size>58458112</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`;

const EMPTY_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>nemar</Name>
  <Prefix>nm099999/objects/</Prefix>
  <KeyCount>0</KeyCount>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

describe("firstObjectKeyFromListXml", () => {
  test("returns the first <Key> from a multi-object page", () => {
    expect(firstObjectKeyFromListXml(PAGE_WITH_OBJECTS)).toBe(
      "nm000111/objects/SHA256E-s91778304--900755de.edf",
    );
  });

  test("returns null for a page with no <Contents>", () => {
    expect(firstObjectKeyFromListXml(EMPTY_PAGE)).toBeNull();
  });

  test("returns the key verbatim even for a single-object page", () => {
    const single =
      "<ListBucketResult><Contents><Key>nm000132/objects/blob.set</Key><Size>10</Size></Contents></ListBucketResult>";
    expect(firstObjectKeyFromListXml(single)).toBe("nm000132/objects/blob.set");
  });

  test("returns null for an unrelated XML blob", () => {
    expect(firstObjectKeyFromListXml("<Error><Code>AccessDenied</Code></Error>")).toBeNull();
  });
});
