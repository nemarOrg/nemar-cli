#!/usr/bin/env bun
/**
 * Synthetic Neurobagel graph-mode JSON-LD, for measuring the footprint of the node at scale
 * (epic #1586, Phase 3). It is a measurement tool, not a source of truth: nothing it writes
 * describes a real dataset, and the output must never be loaded into a node that is registered
 * or exposed.
 *
 * The shape follows Neurobagel's own example (recipes v0.9.1,
 * data/example_synthetic_pheno-bids-derivatives.jsonld): Dataset -> Subject ->
 * PhenotypicSession / ImagingSession -> Acquisition, with the example's `@context` copied
 * verbatim. Output is deterministic for a given seed.
 *
 *   bun deploy/neurobagel/tools/gen-synthetic-jsonld.ts \
 *     --context-from recipes/data/example_synthetic_pheno-bids-derivatives.jsonld \
 *     --out /path/to/source --datasets 800 --subjects 5-120 --profile nemar --index
 *
 * Profiles:
 *   nemar  what a NEMAR record is expected to hold: one phenotypic session (age, sex, sometimes a
 *          diagnosis) and one imaging session with one electrophysiology acquisition
 *   rich   the example's own density: two phenotypic sessions with a diagnosis and two
 *          assessments, two imaging sessions with four acquisitions and two pipelines
 *
 * With --index it also writes index.json in the artifact store interface that nb-load reads, so
 * the output directory is directly usable as NB_SOURCE.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args.set(a.slice(2), "true");
    else {
      args.set(a.slice(2), next);
      i++;
    }
  }
  return args;
}

// Small deterministic PRNG (mulberry32): the same seed always yields the same bytes.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuid(rand: () => number): string {
  const h = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  h[12] = "4";
  h[16] = "89ab"[Math.floor(rand() * 4)];
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const args = parseArgs(process.argv.slice(2));
const need = (k: string): string => {
  const v = args.get(k);
  if (!v) throw new Error(`missing --${k}`);
  return v;
};

const out = need("out");
const nDatasets = Number(need("datasets"));
const [minSub, maxSub] = need("subjects").split("-").map(Number);
const subjectsHi = maxSub ?? minSub;
const profile = args.get("profile") ?? "nemar";
const seed = Number(args.get("seed") ?? "1");
const prefix = args.get("prefix") ?? "sy";
const writeIndex = args.get("index") === "true";
if (!["nemar", "rich"].includes(profile)) throw new Error("--profile must be nemar or rich");

const context = (JSON.parse(readFileSync(need("context-from"), "utf8")) as Json)["@context"];
mkdirSync(out, { recursive: true });

const sexes = ["snomed:248153007", "snomed:248152002"];
const modalities = ["nidm:Electroencephalography", "nidm:Magnetoencephalography"];
const assessments = ["snomed:859351000000102", "snomed:342061000000106"];

const indexEntries: Json[] = [];
for (let d = 1; d <= nDatasets; d++) {
  const id = `${prefix}${String(d).padStart(6, "0")}`;
  const rand = rng(seed * 1_000_003 + d);
  const nSub = minSub + Math.floor(rand() * (subjectsHi - minSub + 1));
  const subjects: Json[] = [];
  for (let s = 1; s <= nSub; s++) {
    const label = `sub-${String(s).padStart(3, "0")}`;
    const sessions: Json[] = [];
    const nPheno = profile === "rich" ? 2 : 1;
    const nImg = profile === "rich" ? 2 : 1;
    for (let k = 1; k <= nPheno; k++) {
      const ses: Json = {
        identifier: `nb:${uuid(rand)}`,
        hasLabel: `ses-${String(k).padStart(2, "0")}`,
        hasAge: Math.round((18 + rand() * 60) * 10) / 10,
        hasSex: { identifier: sexes[Math.floor(rand() * 2)], schemaKey: "Sex" },
        schemaKey: "PhenotypicSession",
      };
      if (profile === "rich" || rand() < 0.4) {
        ses.hasDiagnosis = [{ identifier: "ncit:C94342", schemaKey: "Diagnosis" }];
      }
      if (profile === "rich") {
        ses.hasAssessment = assessments.map((a) => ({ identifier: a, schemaKey: "Assessment" }));
      }
      sessions.push(ses);
    }
    for (let k = 1; k <= nImg; k++) {
      const nAcq = profile === "rich" ? 4 : 1;
      const ses: Json = {
        identifier: `nb:${uuid(rand)}`,
        hasLabel: `ses-${String(k).padStart(2, "0")}`,
        hasFilePath: `/synthetic/${id}/${label}/ses-${String(k).padStart(2, "0")}`,
        hasAcquisition: Array.from({ length: nAcq }, () => ({
          identifier: `nb:${uuid(rand)}`,
          hasContrastType: {
            identifier: modalities[Math.floor(rand() * 2)],
            schemaKey: "Image",
          },
          schemaKey: "Acquisition",
        })),
        schemaKey: "ImagingSession",
      };
      if (profile === "rich") {
        ses.hasCompletedPipeline = ["fmriprep", "freesurfer"].map((p) => ({
          identifier: `nb:${uuid(rand)}`,
          hasPipelineVersion: "1.0.0",
          hasPipelineName: { identifier: `np:${p}`, schemaKey: "Pipeline" },
          schemaKey: "CompletedPipeline",
        }));
      }
      sessions.push(ses);
    }
    subjects.push({
      identifier: `nb:${uuid(rand)}`,
      hasLabel: label,
      hasSession: sessions,
      schemaKey: "Subject",
    });
  }
  const doc: Json = {
    "@context": context,
    identifier: `nb:${uuid(rand)}`,
    hasLabel: `Synthetic dataset ${id}`,
    hasAuthors: ["Synthetic, A."],
    hasReferencesAndLinks: [`https://example.invalid/dataset/${id}`],
    hasKeywords: ["synthetic"],
    hasRepositoryURL: `https://example.invalid/repository/${id}`,
    hasAccessInstructions: "Synthetic footprint-measurement record. Not a real dataset.",
    hasAccessType: "public",
    hasAccessLink: `https://example.invalid/dataset/${id}`,
    hasSamples: subjects,
    schemaKey: "Dataset",
  };
  const body = `${JSON.stringify(doc)}\n`;
  const name = `${id}.jsonld`;
  writeFileSync(join(out, name), body);
  indexEntries.push({
    id,
    fingerprint: `synthetic-${seed}-${createHash("sha256").update(body).digest("hex").slice(0, 16)}`,
    artifacts: [
      {
        name,
        kind: "jsonld",
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: Buffer.byteLength(body),
      },
    ],
  });
}

if (writeIndex) {
  const index = {
    schema: "nemar-neurobagel-artifact-index/1",
    generated_at: new Date(0).toISOString(),
    datasets: indexEntries,
  };
  writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 1)}\n`);
}
console.log(`wrote ${nDatasets} dataset(s) to ${out}${writeIndex ? " with index.json" : ""}`);
