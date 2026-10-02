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
 * With --index it also writes index.json in the format defined by ../index.schema.json (the one
 * source of truth: the schema string, the artifact suffix and the fingerprint form are read from
 * it), so the output directory is directly usable as NB_SOURCE.
 *
 * The functions are exported so a test can drive them; running the file runs main().
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import schema from "../index.schema.json";

type Json = Record<string, unknown>;

export type Options = {
  out: string;
  datasets: number;
  minSubjects: number;
  maxSubjects: number;
  profile: "nemar" | "rich";
  seed: number;
  prefix: string;
  index: boolean;
  contextFrom: string;
};

export type IndexArtifact = { name: string; kind: string; sha256: string; bytes: number };
export type IndexDataset = { id: string; fingerprint: string; artifacts: IndexArtifact[] };
export type ArtifactIndex = {
  schema: string;
  generated_at: string;
  datasets: IndexDataset[];
};

/** The index constants, read from the schema rather than written a second time here. */
export const INDEX_SCHEMA_STRING: string = schema.properties.schema.const;
export const JSONLD_SUFFIX: string = schema["x-rules"].artifactSuffix.jsonld;

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

function positiveInt(name: string, raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`--${name} must be a positive whole number, got '${raw ?? ""}'`);
  }
  return Number(raw);
}

export function parseOptions(argv: string[]): Options {
  const args = parseArgs(argv);
  const need = (k: string): string => {
    const v = args.get(k);
    if (!v) throw new Error(`missing --${k}`);
    return v;
  };
  const range = need("subjects").split("-");
  if (range.length > 2) throw new Error("--subjects must be N or MIN-MAX");
  const minSubjects = positiveInt("subjects", range[0]);
  const maxSubjects = range.length === 2 ? positiveInt("subjects", range[1]) : minSubjects;
  if (maxSubjects < minSubjects) throw new Error("--subjects MAX must not be below MIN");
  const profile = args.get("profile") ?? "nemar";
  if (profile !== "nemar" && profile !== "rich") throw new Error("--profile must be nemar or rich");
  const seedRaw = args.get("seed") ?? "1";
  if (!/^[0-9]+$/.test(seedRaw)) throw new Error(`--seed must be a whole number, got '${seedRaw}'`);
  return {
    out: need("out"),
    datasets: positiveInt("datasets", args.get("datasets")),
    minSubjects,
    maxSubjects,
    profile,
    seed: Number(seedRaw),
    prefix: args.get("prefix") ?? "sy",
    index: args.get("index") === "true",
    contextFrom: need("context-from"),
  };
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

const sexes = ["snomed:248153007", "snomed:248152002"];
const modalities = ["nidm:Electroencephalography", "nidm:Magnetoencephalography"];
const assessments = ["snomed:859351000000102", "snomed:342061000000106"];

/** One dataset document (as a string) for dataset number `d`, 1-based. */
export function generateDataset(
  opts: Options,
  d: number,
  context: unknown,
): { id: string; body: string } {
  const id = `${opts.prefix}${String(d).padStart(6, "0")}`;
  const rand = rng(opts.seed * 1_000_003 + d);
  const nSub = opts.minSubjects + Math.floor(rand() * (opts.maxSubjects - opts.minSubjects + 1));
  const rich = opts.profile === "rich";
  const subjects: Json[] = [];
  for (let s = 1; s <= nSub; s++) {
    const label = `sub-${String(s).padStart(3, "0")}`;
    const sessions: Json[] = [];
    for (let k = 1; k <= (rich ? 2 : 1); k++) {
      const ses: Json = {
        identifier: `nb:${uuid(rand)}`,
        hasLabel: `ses-${String(k).padStart(2, "0")}`,
        hasAge: Math.round((18 + rand() * 60) * 10) / 10,
        hasSex: { identifier: sexes[Math.floor(rand() * 2)], schemaKey: "Sex" },
        schemaKey: "PhenotypicSession",
      };
      if (rich || rand() < 0.4) {
        ses.hasDiagnosis = [{ identifier: "ncit:C94342", schemaKey: "Diagnosis" }];
      }
      if (rich) {
        ses.hasAssessment = assessments.map((a) => ({ identifier: a, schemaKey: "Assessment" }));
      }
      sessions.push(ses);
    }
    for (let k = 1; k <= (rich ? 2 : 1); k++) {
      const ses: Json = {
        identifier: `nb:${uuid(rand)}`,
        hasLabel: `ses-${String(k).padStart(2, "0")}`,
        hasFilePath: `/synthetic/${id}/${label}/ses-${String(k).padStart(2, "0")}`,
        hasAcquisition: Array.from({ length: rich ? 4 : 1 }, () => ({
          identifier: `nb:${uuid(rand)}`,
          hasContrastType: {
            identifier: modalities[Math.floor(rand() * 2)],
            schemaKey: "Image",
          },
          schemaKey: "Acquisition",
        })),
        schemaKey: "ImagingSession",
      };
      if (rich) {
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
  return { id, body: `${JSON.stringify(doc)}\n` };
}

const sha256 = (b: string): string => createHash("sha256").update(b).digest("hex");

/** The index entry for one dataset document: the fingerprint form is the schema's. */
export function indexEntry(id: string, body: string): IndexDataset {
  const hash = sha256(body);
  return {
    id,
    // The reference form: sha256 of the artifacts' own hashes (here, one artifact).
    fingerprint: `sha256:${sha256(hash)}`,
    artifacts: [
      {
        name: `${id}${JSONLD_SUFFIX}`,
        kind: "jsonld",
        sha256: hash,
        bytes: Buffer.byteLength(body),
      },
    ],
  };
}

export function buildIndex(entries: IndexDataset[], generatedAt: string): ArtifactIndex {
  return { schema: INDEX_SCHEMA_STRING, generated_at: generatedAt, datasets: entries };
}

export function main(argv: string[]): void {
  const opts = parseOptions(argv);
  const context = (JSON.parse(readFileSync(opts.contextFrom, "utf8")) as Json)["@context"];
  mkdirSync(opts.out, { recursive: true });
  const entries: IndexDataset[] = [];
  for (let d = 1; d <= opts.datasets; d++) {
    const { id, body } = generateDataset(opts, d, context);
    writeFileSync(join(opts.out, `${id}${JSONLD_SUFFIX}`), body);
    entries.push(indexEntry(id, body));
  }
  if (opts.index) {
    const index = buildIndex(entries, new Date(0).toISOString());
    writeFileSync(join(opts.out, "index.json"), `${JSON.stringify(index, null, 1)}\n`);
  }
  console.log(
    `wrote ${opts.datasets} dataset(s) to ${opts.out}${opts.index ? " with index.json" : ""}`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  }
}
