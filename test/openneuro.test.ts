/**
 * Tests for OpenNeuro dataset download support.
 * These tests hit OpenNeuro's public S3 bucket (no auth needed).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type S3Object,
  decodeXmlEntities,
  downloadWithHttps,
  isOpenNeuroDatasetId,
  listOpenNeuroObjects,
  openNeuroDatasetExists,
} from "../src/lib/openneuro";

describe("OpenNeuro dataset ID validation", () => {
  test("valid OpenNeuro IDs", () => {
    expect(isOpenNeuroDatasetId("ds000001")).toBe(true);
    expect(isOpenNeuroDatasetId("ds000248")).toBe(true);
    expect(isOpenNeuroDatasetId("ds999999")).toBe(true);
  });

  test("invalid IDs", () => {
    expect(isOpenNeuroDatasetId("nm000104")).toBe(false);
    expect(isOpenNeuroDatasetId("on000001")).toBe(false);
    expect(isOpenNeuroDatasetId("xx000001")).toBe(false);
    expect(isOpenNeuroDatasetId("ds00001")).toBe(false); // too few digits
    expect(isOpenNeuroDatasetId("ds0000001")).toBe(false); // too many digits
    expect(isOpenNeuroDatasetId("DS000001")).toBe(false); // uppercase
    expect(isOpenNeuroDatasetId("")).toBe(false);
    expect(isOpenNeuroDatasetId("ds")).toBe(false);
  });
});

describe("XML entity decoding", () => {
  test("decodes all XML entities", () => {
    expect(decodeXmlEntities("file&amp;name")).toBe("file&name");
    expect(decodeXmlEntities("a&lt;b&gt;c")).toBe("a<b>c");
    expect(decodeXmlEntities("it&apos;s &quot;quoted&quot;")).toBe('it\'s "quoted"');
  });

  test("passes through strings without entities", () => {
    expect(decodeXmlEntities("normal/path/file.edf")).toBe("normal/path/file.edf");
  });
});

describe("OpenNeuro S3 integration", () => {
  const KNOWN_DATASET = "ds000248";
  const NONEXISTENT_DATASET = "ds999999";

  test("existing dataset is found", async () => {
    const exists = await openNeuroDatasetExists(KNOWN_DATASET);
    expect(exists).toBe(true);
  }, 15000);

  test("non-existent dataset returns false", async () => {
    const exists = await openNeuroDatasetExists(NONEXISTENT_DATASET);
    expect(exists).toBe(false);
  }, 15000);

  test("existing dataset found via HTTPS fallback", async () => {
    // Force HTTPS path by telling it AWS CLI is not available
    const exists = await openNeuroDatasetExists(KNOWN_DATASET, false);
    expect(exists).toBe(true);
  }, 15000);

  test("non-existent dataset returns false via HTTPS fallback", async () => {
    const exists = await openNeuroDatasetExists(NONEXISTENT_DATASET, false);
    expect(exists).toBe(false);
  }, 15000);

  test("list objects returns files with sizes", async () => {
    const objects = await listOpenNeuroObjects(KNOWN_DATASET);
    expect(objects.length).toBeGreaterThan(0);

    // Should have BIDS root files
    const keys = objects.map((o) => o.key);
    expect(keys.some((k) => k.includes("dataset_description.json"))).toBe(true);

    // All objects should have keys under the dataset prefix
    for (const obj of objects) {
      expect(obj.size).toBeGreaterThanOrEqual(0);
      expect(obj.key.startsWith(`${KNOWN_DATASET}/`)).toBe(true);
    }

    // Most objects should have positive sizes
    const nonEmpty = objects.filter((o) => o.size > 0);
    expect(nonEmpty.length).toBeGreaterThan(0);
  }, 30000);
});

describe("OpenNeuro HTTPS download", () => {
  const KNOWN_DATASET = "ds000248";
  const outputDir = join(tmpdir(), `nemar-openneuro-test-${Date.now()}`);
  const partialFailDir = join(tmpdir(), `nemar-openneuro-partial-${Date.now()}`);

  afterAll(() => {
    for (const dir of [outputDir, partialFailDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("downloads files via HTTPS with progress", async () => {
    // Only download the small root-level files (skip large data files)
    const allObjects = await listOpenNeuroObjects(KNOWN_DATASET);
    const smallObjects = allObjects.filter((o) => o.size < 10000 && !o.key.includes("sub-"));
    expect(smallObjects.length).toBeGreaterThan(0);

    let lastProgress = { filesDown: 0, bytesDown: 0 };
    const result = await downloadWithHttps(KNOWN_DATASET, outputDir, smallObjects, {
      concurrency: 4,
      onProgress: (filesDown, filesTotal, bytesDown, bytesTotal) => {
        lastProgress = { filesDown, bytesDown };
        expect(filesDown).toBeLessThanOrEqual(filesTotal);
        expect(bytesDown).toBeLessThanOrEqual(bytesTotal);
      },
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("https");
    expect(result.filesDownloaded).toBe(smallObjects.length);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(lastProgress.filesDown).toBe(smallObjects.length);

    // Verify files exist on disk
    const descPath = join(outputDir, "dataset_description.json");
    expect(existsSync(descPath)).toBe(true);
  }, 60000);

  test("resume skips already-downloaded files", async () => {
    // Re-download same files - should skip all (already exist with correct size)
    const allObjects = await listOpenNeuroObjects(KNOWN_DATASET);
    const smallObjects = allObjects.filter((o) => o.size < 10000 && !o.key.includes("sub-"));

    const result = await downloadWithHttps(KNOWN_DATASET, outputDir, smallObjects, {
      concurrency: 4,
    });

    expect(result.success).toBe(true);
    expect(result.filesDownloaded).toBe(smallObjects.length);
  }, 60000);

  test("rejects path traversal in S3 keys", async () => {
    const maliciousObjects: S3Object[] = [{ key: "ds000248/../../etc/passwd", size: 100 }];
    const result = await downloadWithHttps("ds000248", outputDir, maliciousObjects);
    expect(result.success).toBe(false);
    expect(result.error).toContain("failed");
  }, 15000);

  test("reports partial failures with error details", async () => {
    const objects: S3Object[] = [
      { key: "ds000248/dataset_description.json", size: 1536 },
      { key: "ds000248/NONEXISTENT_FILE_12345.txt", size: 100 },
    ];
    const result = await downloadWithHttps("ds000248", partialFailDir, objects);
    expect(result.success).toBe(false);
    expect(result.filesDownloaded).toBe(1);
    expect(result.error).toContain("1 file(s) failed");
  }, 30000);
});
