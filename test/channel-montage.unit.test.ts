/**
 * Unit tests for the channel-count + electrode-system classifiers
 * (epic #854 phase 2, #858). Pure helpers; real-shape BIDS inputs, no mocks.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyElectrodeSystem,
  parseChannelsTsv,
  parseEegChannelCount,
  resolveNChannels,
} from "../backend/src/services/channel-montage";

// Real HBN GSN-HydroCel-129 shape: E1..E128 + Cz, with a `type` column.
const HBN_TSV = [
  "name\ttype\tunits",
  ...Array.from({ length: 128 }, (_, i) => `E${i + 1}\tEEG\tuV`),
  "Cz\tEEG\tuV",
].join("\n");

// A 19-channel 10-20 cap with two non-EEG channels.
const CAP_1020_TSV = [
  "name\ttype",
  "Fp1\tEEG",
  "Fp2\tEEG",
  "F7\tEEG",
  "F3\tEEG",
  "Fz\tEEG",
  "F4\tEEG",
  "F8\tEEG",
  "T7\tEEG",
  "C3\tEEG",
  "Cz\tEEG",
  "C4\tEEG",
  "T8\tEEG",
  "P7\tEEG",
  "P3\tEEG",
  "Pz\tEEG",
  "P4\tEEG",
  "P8\tEEG",
  "O1\tEEG",
  "O2\tEEG",
  "HEOG\tEOG",
  "STI 014\tTRIG",
].join("\n");

describe("parseChannelsTsv", () => {
  test("counts EEG rows and collects labels (HBN E1..E128 + Cz)", () => {
    const r = parseChannelsTsv(HBN_TSV);
    expect(r).not.toBeNull();
    expect(r?.count).toBe(129);
    expect(r?.eegCount).toBe(129);
    expect(r?.labels[0]).toBe("E1");
    expect(r?.labels.at(-1)).toBe("Cz");
  });

  test("separates EEG-type rows from non-EEG (EOG/trigger)", () => {
    const r = parseChannelsTsv(CAP_1020_TSV);
    expect(r?.count).toBe(21);
    expect(r?.eegCount).toBe(19);
  });

  test("falls back to all rows when there is no type column", () => {
    const r = parseChannelsTsv("name\nFp1\nFp2\nCz");
    expect(r?.count).toBe(3);
    expect(r?.eegCount).toBe(3);
  });

  test("returns null for a pointer/garbled file with no name column", () => {
    expect(parseChannelsTsv("/annex/objects/SHA256E-s123--abc.tsv")).toBeNull();
    expect(parseChannelsTsv("")).toBeNull();
  });
});

describe("parseEegChannelCount", () => {
  test("reads EEGChannelCount", () => {
    expect(parseEegChannelCount('{"EEGChannelCount": 128, "SamplingFrequency": 500}')).toBe(128);
  });
  test("null on missing/invalid", () => {
    expect(parseEegChannelCount('{"SamplingFrequency": 500}')).toBeNull();
    expect(parseEegChannelCount("not json")).toBeNull();
    expect(parseEegChannelCount('{"EEGChannelCount": 0}')).toBeNull();
  });
});

describe("resolveNChannels", () => {
  test("measured channels.tsv EEG count wins over a disagreeing sidecar", () => {
    const tsv = { count: 130, eegCount: 129, labels: [] };
    expect(resolveNChannels(128, tsv)).toBe(129);
  });
  test("falls back to the sidecar when no channels.tsv", () => {
    expect(resolveNChannels(64, null)).toBe(64);
  });
  test("uses total count when no row is typed EEG", () => {
    expect(resolveNChannels(null, { count: 32, eegCount: 0, labels: [] })).toBe(32);
  });
  test("null when neither source is present", () => {
    expect(resolveNChannels(null, null)).toBeNull();
  });
});

describe("classifyElectrodeSystem", () => {
  test("EGI geodesic from E1..E128 + Cz", () => {
    const labels = [...Array.from({ length: 128 }, (_, i) => `E${i + 1}`), "Cz"];
    expect(classifyElectrodeSystem(labels)).toBe("egi-geodesic");
  });

  test("BioSemi from A-bank labels (A1..D32), even with the E* overlap", () => {
    expect(classifyElectrodeSystem(["A1", "A17", "B5", "C20", "D32", "E1"])).toBe("biosemi");
  });

  test("classic 19-channel 10-20 cap", () => {
    const labels = "Fp1 Fp2 F7 F3 Fz F4 F8 T7 C3 Cz C4 T8 P7 P3 Pz P4 P8 O1 O2".split(" ");
    expect(classifyElectrodeSystem(labels)).toBe("10-20");
  });

  test("legacy T3/T4/T5/T6 spellings still read as 10-20", () => {
    const labels = "Fp1 Fp2 F7 F3 Fz F4 F8 T3 C3 Cz C4 T4 T5 P3 Pz P4 T6 O1 O2".split(" ");
    expect(classifyElectrodeSystem(labels)).toBe("10-20");
  });

  test("10-10 when intermediate labels are present", () => {
    const labels = "Fp1 Fpz Fp2 AF3 AF4 F1 Fz F2 FC1 FCz FC2 C1 Cz C2 CP1 CPz CP2 Pz POz Oz".split(
      " ",
    );
    expect(classifyElectrodeSystem(labels)).toBe("10-10");
  });

  test("10-05 when fine / half-distance labels are present", () => {
    const labels = "Fpz AFp1h AFF1h Fz FCC1h Cz CCP1h Pz PPO1h POz Oz".split(" ");
    expect(classifyElectrodeSystem(labels)).toBe("10-05");
  });

  test("other for label sets that barely overlap the standard system", () => {
    expect(classifyElectrodeSystem(["X1", "X2", "X3", "Cz", "Fz"])).toBe("other");
  });

  test("null when too few labels to decide", () => {
    expect(classifyElectrodeSystem(["Cz", "Fz"])).toBeNull();
  });
});
