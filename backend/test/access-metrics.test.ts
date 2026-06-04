import { describe, expect, test } from "bun:test";
import { buildAccessDataPoint, recordAccess, zarrObjectType } from "../src/services/access-metrics";

describe("buildAccessDataPoint", () => {
  test("archive download: dataset_id index + version detail + zero bytes", () => {
    const dp = buildAccessDataPoint({
      datasetId: "nm000132",
      source: "archive",
      detail: "1.0.0",
    });
    expect(dp.indexes).toEqual(["nm000132"]);
    expect(dp.blobs).toEqual(["nm000132", "archive", "1.0.0"]);
    expect(dp.doubles).toEqual([0]);
  });

  test("zarr chunk read carries served bytes", () => {
    const dp = buildAccessDataPoint({
      datasetId: "on007139",
      source: "zarr",
      detail: "chunk",
      bytes: 524288,
    });
    expect(dp.indexes).toEqual(["on007139"]);
    expect(dp.blobs).toEqual(["on007139", "zarr", "chunk"]);
    expect(dp.doubles).toEqual([524288]);
  });

  test("field ordering is stable (the read-side SQL contract)", () => {
    const dp = buildAccessDataPoint({ datasetId: "nm1", source: "file", detail: "x", bytes: 5 });
    // blob1=dataset_id, blob2=source, blob3=detail; double1=bytes
    expect(dp.blobs?.[0]).toBe("nm1");
    expect(dp.blobs?.[1]).toBe("file");
    expect(dp.blobs?.[2]).toBe("x");
    expect(dp.doubles?.[0]).toBe(5);
  });
});

describe("zarrObjectType", () => {
  test("classifies the store index", () => {
    expect(zarrObjectType("nm000132/zarr/index.json")).toBe("index");
  });

  test("classifies store metadata (zarr.json)", () => {
    expect(zarrObjectType("nm000132/zarr/sub-01_task-rest_eeg.zarr/zarr.json")).toBe("metadata");
  });

  test("everything else is a chunk", () => {
    expect(zarrObjectType("nm000132/zarr/sub-01_task-rest_eeg.zarr/data/c/0/0/0")).toBe("chunk");
  });
});

describe("recordAccess", () => {
  test("no-ops without throwing when the ANALYTICS binding is absent", () => {
    // Real (empty) env: the guard must keep data-plane responses working when
    // the binding is not provisioned (dev/test). No mock binding involved.
    expect(() =>
      recordAccess({}, { datasetId: "nm000132", source: "archive", detail: "1.0.0" }),
    ).not.toThrow();
  });
});
