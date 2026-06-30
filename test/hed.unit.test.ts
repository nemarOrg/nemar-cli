/**
 * Unit tests for the HED detection helpers (epic #869 phase 2, #871). Pure
 * helpers; real-shape BIDS inputs, no mocks. The HED-positive fixtures are the
 * actual dataset_description.json + task-MMN_events.json from nm000132 (ERP CORE,
 * HEDVersion 8.4.0).
 */

import { describe, expect, test } from "bun:test";
import { eventsJsonHasHed, eventsTsvHasHed, parseHedVersion } from "../backend/src/services/hed";

// Real nm000132 dataset_description.json (trimmed to the relevant keys).
const REAL_DESC = `{
  "Name": "ERP CORE",
  "BIDSVersion": "1.10.1",
  "HEDVersion": "8.4.0",
  "DatasetType": "raw",
  "License": "CC-BY-4.0"
}`;

// Real nm000132 task-MMN_events.json: a "value" column carrying a "HED" object.
const REAL_EVENTS_JSON_HED = `{
  "value": {
    "LongName": "Event code value",
    "Levels": { "1": "Status event", "70": "deviant tone" },
    "HED": {
      "1": "Experiment-control, ID/1",
      "70": "(Duration/100 ms, (Sensory-event, Target, Tone))"
    }
  }
}`;

// Value-level HED string (the other legal events.json HED shape).
const EVENTS_JSON_HED_STRING = `{
  "response_time": { "LongName": "Response time", "HED": "Delay/# ms" }
}`;

// A real-shape events.json with NO HED key anywhere.
const EVENTS_JSON_NO_HED = `{
  "onset": { "Description": "Event onset" },
  "trial_type": { "LongName": "Trial type", "Levels": { "go": "go trial" } }
}`;

describe("parseHedVersion", () => {
  test("reads a scalar HEDVersion string", () => {
    expect(parseHedVersion(JSON.parse(REAL_DESC))).toBe("8.4.0");
  });

  test("joins an array HEDVersion (multi-library)", () => {
    expect(parseHedVersion({ HEDVersion: ["8.3.0", "sc:score_1.0.0"] })).toBe(
      "8.3.0,sc:score_1.0.0",
    );
  });

  test("trims whitespace and drops blank array entries", () => {
    expect(parseHedVersion({ HEDVersion: "  8.2.0  " })).toBe("8.2.0");
    expect(parseHedVersion({ HEDVersion: ["8.3.0", "", "  "] })).toBe("8.3.0");
  });

  test("returns null when HEDVersion is absent, blank, or wrong-typed", () => {
    expect(parseHedVersion({ Name: "no hed here" })).toBeNull();
    expect(parseHedVersion({ HEDVersion: "" })).toBeNull();
    expect(parseHedVersion({ HEDVersion: [] })).toBeNull();
    expect(parseHedVersion({ HEDVersion: 8.4 })).toBeNull();
    expect(parseHedVersion(null)).toBeNull();
    expect(parseHedVersion("not an object")).toBeNull();
  });
});

describe("eventsJsonHasHed", () => {
  test("true for a column with a HED object (real nm000132 sidecar)", () => {
    expect(eventsJsonHasHed(REAL_EVENTS_JSON_HED)).toBe(true);
  });

  test("true for a column with a value-level HED string", () => {
    expect(eventsJsonHasHed(EVENTS_JSON_HED_STRING)).toBe(true);
  });

  test("false when no column declares HED", () => {
    expect(eventsJsonHasHed(EVENTS_JSON_NO_HED)).toBe(false);
  });

  test("false on malformed JSON or non-object", () => {
    expect(eventsJsonHasHed("{ not valid json")).toBe(false);
    expect(eventsJsonHasHed("[]")).toBe(false);
    expect(eventsJsonHasHed("42")).toBe(false);
  });
});

describe("eventsTsvHasHed", () => {
  test("true when the header has a literal HED column", () => {
    expect(eventsTsvHasHed("onset\tduration\tHED\n0.5\t0.1\tEvent\n")).toBe(true);
  });

  test("true regardless of HED column position / surrounding whitespace", () => {
    expect(eventsTsvHasHed("HED\tonset\n(Event)\t0.0")).toBe(true);
    expect(eventsTsvHasHed("onset\t HED \tvalue\n0\tx\ty")).toBe(true);
  });

  test("false when there is no HED column", () => {
    expect(eventsTsvHasHed("onset\tduration\ttrial_type\n0.5\t0.1\tgo")).toBe(false);
    // Substring match must not count -- only an exact 'HED' cell.
    expect(eventsTsvHasHed("onset\tHEDxx\tSHED\n0\ta\tb")).toBe(false);
  });

  test("false on empty content", () => {
    expect(eventsTsvHasHed("")).toBe(false);
  });
});
