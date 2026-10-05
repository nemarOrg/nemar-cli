/**
 * Regenerate the pinned Neurobagel vocabulary snapshot.
 *
 *   bun run scripts/neurobagel/generate-vocab.ts           # rewrite the snapshot files
 *   bun run scripts/neurobagel/generate-vocab.ts --check   # exit 1 if the files on disk differ
 *
 * Every input is fetched from a COMMIT SHA, never from a branch, so a rerun
 * produces the same bytes until PINS below is edited on purpose.
 * Moving a pin is a vocabulary change: rerun this script, review the diff of
 * `shared/neurobagel/vocab/`, rerun the goldens and the bagel oracle
 * (`shared/neurobagel/README.md`), and let the transform version in
 * `shared/neurobagel/version.ts` move in the same PR when the output changes.
 *
 * Network: read-only GETs against raw.githubusercontent.com.
 * `uv` runs scripts/neurobagel/bagel_models.py, which imports the pinned
 * `bagel` release, to produce the JSON-LD context and the JSON Schemas.
 * This script is the only place the vocabulary is fetched; the transform
 * itself never touches the network.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CanonicalJsonValue, canonicalJson } from "../../shared/neurobagel/canonical-json";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const VOCAB_DIR = join(REPO_ROOT, "shared/neurobagel/vocab");

/**
 * The pins.
 * `communities` is the authority for every term the transform may emit.
 * `bagel`, `api` and `recipes` are the Neurobagel code the output is validated
 * against (the CLI, the node API's own SPARQL generator and the stack's loader); their files are pinned by blob SHA so a change upstream shows up as
 * drift here rather than as a surprise in a load.
 */
export const PINS = {
  communities: {
    repo: "neurobagel/communities",
    commit: "0cbf82a4777a10e984253dac2b134902963c4095",
    files: [
      "config_metadata/config_namespace_map.json",
      "configs/Neurobagel/assessment.json",
      "configs/Neurobagel/config.json",
      "configs/Neurobagel/diagnosis.json",
      "configs/Neurobagel/imaging_modalities.json",
      "configs/Neurobagel/sex.json",
    ],
  },
  bagel: {
    repo: "neurobagel/bagel-cli",
    tag: "v0.11.6",
    pypi: "bagel==0.11.6",
    commit: "505838159e273f5feb03d117bff454c27932728e",
    files: [
      "bagel/cli.py",
      "bagel/dataset_description_model.py",
      "bagel/dictionary_models.py",
      "bagel/mappings.py",
      "bagel/models.py",
      "bagel/utilities/bids_utils.py",
      "bagel/utilities/model_utils.py",
      "bagel/utilities/pheno_utils.py",
    ],
  },
  api: {
    repo: "neurobagel/api",
    tag: "v0.11.0",
    commit: "2395a650e90c8e62d5211232945ecc4117407094",
    files: [
      "app/api/env_settings.py",
      "app/api/logger.py",
      "app/api/models.py",
      "app/api/sparql_models.py",
      "app/api/utility.py",
    ],
  },
  recipes: {
    repo: "neurobagel/recipes",
    commit: "389d0b719ebc641e3a329112b64305fa7889023f",
    files: [
      "docker-compose.yml",
      "init_data/process_jsonld.py",
      "init_data/utils/dataset_description_model.py",
      "init_data/utils/dictionary_models.py",
      "init_data/utils/models.py",
      "scripts/add_data_to_graph.sh",
    ],
  },
} as const;

type PinName = keyof typeof PINS;

type PinnedFile = {
  blob_sha: string;
  bytes: number;
  sha256: string;
};

// A type alias, not an interface: only an alias is assignable to canonicalJson's object type.
type Term = {
  identifier: string;
  label: string;
};

function rawUrl(pin: PinName, path: string): string {
  const { repo, commit } = PINS[pin];
  return `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { "User-Agent": "nemar-neurobagel-dev/1.0" } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The git object id of a file, so a pin can be checked against `git ls-tree`. */
function gitBlobSha(bytes: Uint8Array): string {
  const hash = createHash("sha1");
  hash.update(`blob ${bytes.length}\0`);
  hash.update(bytes);
  return hash.digest("hex");
}

function describe(bytes: Uint8Array): PinnedFile {
  return {
    blob_sha: gitBlobSha(bytes),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

interface VocabNamespace {
  namespace_prefix: string;
  namespace_url: string;
  terms: { id: string; name: string; abbreviation?: string; data_type?: string }[];
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`pinned vocabulary has no ${what}`);
  return value;
}

/** Fetch every pinned file once; return the parsed JSON ones by path. */
async function fetchPins(): Promise<{
  files: Record<PinName, Record<string, PinnedFile>>;
  json: Record<string, unknown>;
}> {
  const files = { communities: {}, bagel: {}, api: {}, recipes: {} } as Record<
    PinName,
    Record<string, PinnedFile>
  >;
  const json: Record<string, unknown> = {};
  for (const pin of Object.keys(PINS) as PinName[]) {
    for (const path of PINS[pin].files) {
      const bytes = await fetchBytes(rawUrl(pin, path));
      files[pin][path] = describe(bytes);
      if (path.endsWith(".json"))
        json[`${pin}:${path}`] = JSON.parse(new TextDecoder().decode(bytes));
    }
  }
  return { files, json };
}

function termsOf(
  doc: VocabNamespace[],
  prefix: string,
): Map<string, { name: string; abbreviation?: string; data_type?: string }> {
  const ns = need(
    doc.find((n) => n.namespace_prefix === prefix),
    `namespace ${prefix}`,
  );
  return new Map(ns.terms.map((t) => [t.id, t]));
}

/** One `identifier: label` pair per line keeps a vocabulary bump reviewable. */
function termFile(doc: VocabNamespace[]): { text: string; count: number } {
  const entries: [string, string][] = [];
  for (const ns of doc) {
    for (const term of ns.terms) entries.push([`${ns.namespace_prefix}:${term.id}`, term.name]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const seen = new Set<string>();
  for (const [identifier] of entries) {
    if (seen.has(identifier)) throw new Error(`duplicate term ${identifier}`);
    seen.add(identifier);
  }
  const lines = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return { text: `{\n${lines.join(",\n")}\n}\n`, count: entries.length };
}

async function runBagelModels(): Promise<{
  bagel_version: string;
  context: Record<string, CanonicalJsonValue>;
  dataset_schema: CanonicalJsonValue;
  dictionary_schema: CanonicalJsonValue;
}> {
  const proc = Bun.spawn(["uv", "run", "--quiet", join(HERE, "bagel_models.py")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`bagel_models.py exited ${code}: ${stderr}`);
  return JSON.parse(stdout);
}

export async function buildVocabFiles(): Promise<Map<string, string>> {
  const { files, json } = await fetchPins();
  const get = (path: string): unknown => need(json[`communities:${path}`], path);

  const sex = get("configs/Neurobagel/sex.json") as VocabNamespace[];
  const modalities = get("configs/Neurobagel/imaging_modalities.json") as VocabNamespace[];
  const diagnosis = get("configs/Neurobagel/diagnosis.json") as VocabNamespace[];
  const assessment = get("configs/Neurobagel/assessment.json") as VocabNamespace[];
  const config = get("configs/Neurobagel/config.json") as {
    namespace_prefix: string;
    namespace_url: string;
    standardized_variables: {
      id: string;
      name: string;
      variable_type: string;
      formats: { id: string; name: string }[] | null;
    }[];
  }[];
  const namespaceMap = get("config_metadata/config_namespace_map.json") as {
    config_name: string;
    namespaces: Record<string, { namespace_prefix: string; namespace_url: string }[]>;
  }[];

  // Namespaces of the default "Neurobagel" configuration, the one `bagel pheno`
  // validates term URLs against.
  const neurobagel = need(
    namespaceMap.find((c) => c.config_name === "Neurobagel"),
    "Neurobagel entry in config_namespace_map.json",
  );
  const namespaces: Record<string, string> = {};
  for (const group of Object.values(neurobagel.namespaces)) {
    for (const ns of group) namespaces[ns.namespace_prefix] = ns.namespace_url;
  }

  // Sex terms, keyed by the lower-case English name the mapping rules use.
  const sexNs = need(sex[0], "sex namespace");
  const sexTerms: Record<string, Term> = {};
  for (const [id, term] of termsOf(sex, sexNs.namespace_prefix)) {
    sexTerms[term.name.toLowerCase()] = {
      identifier: `${sexNs.namespace_prefix}:${id}`,
      label: term.name,
    };
  }

  // Imaging modalities, keyed by BIDS datatype directory (`eeg`, `meg`, ...).
  const modalityNs = need(modalities[0], "imaging modality namespace");
  const imagingModalities: Record<string, Term & { abbreviation: string; data_type: string }> = {};
  for (const [id, term] of termsOf(modalities, modalityNs.namespace_prefix)) {
    imagingModalities[need(term.abbreviation, `abbreviation of ${id}`)] = {
      identifier: `${modalityNs.namespace_prefix}:${id}`,
      label: term.name,
      abbreviation: need(term.abbreviation, `abbreviation of ${id}`),
      data_type: need(term.data_type, `data_type of ${id}`),
    };
  }

  // The healthy control term lives in the diagnosis vocabulary (ncit namespace).
  const control = need(termsOf(diagnosis, "ncit").get("C94342"), "ncit:C94342");
  const healthyControl: Term = { identifier: "ncit:C94342", label: control.name };

  // Standardized variables and the age formats the Neurobagel config declares.
  const nbConfig = need(
    config.find((c) => c.namespace_prefix === "nb"),
    "nb config",
  );
  const variables: Record<string, Term> = {};
  let ageFormats: Record<string, Term> = {};
  for (const variable of nbConfig.standardized_variables) {
    variables[variable.id] = { identifier: `nb:${variable.id}`, label: variable.name };
    if (variable.id === "Age") {
      ageFormats = Object.fromEntries(
        need(variable.formats, "Age formats").map((format) => [
          format.id,
          { identifier: `nb:${format.id}`, label: format.name },
        ]),
      );
    }
  }

  const diagnosisFile = termFile(diagnosis);
  const assessmentFile = termFile(assessment);
  const bagelModels = await runBagelModels();
  if (`bagel==${bagelModels.bagel_version}` !== PINS.bagel.pypi) {
    throw new Error(
      `bagel_models.py ran bagel ${bagelModels.bagel_version}, PINS.bagel says ${PINS.bagel.pypi}`,
    );
  }
  for (const [prefix, url] of Object.entries(namespaces)) {
    if (bagelModels.context[prefix] !== url) {
      throw new Error(`bagel context disagrees with the namespace map on ${prefix}`);
    }
  }

  const snapshot: CanonicalJsonValue = {
    age_formats: ageFormats,
    bagel_version: bagelModels.bagel_version,
    context: bagelModels.context,
    healthy_control: healthyControl,
    imaging_modalities: imagingModalities,
    namespaces,
    pins: {
      bagel: {
        commit: PINS.bagel.commit,
        files: files.bagel,
        pypi: PINS.bagel.pypi,
        repo: PINS.bagel.repo,
        tag: PINS.bagel.tag,
      },
      api: {
        commit: PINS.api.commit,
        files: files.api,
        repo: PINS.api.repo,
        tag: PINS.api.tag,
      },
      communities: {
        commit: PINS.communities.commit,
        files: files.communities,
        repo: PINS.communities.repo,
      },
      recipes: {
        commit: PINS.recipes.commit,
        files: files.recipes,
        repo: PINS.recipes.repo,
      },
    },
    sex: sexTerms,
    snapshot_version: 1,
    term_files: {
      assessment: { file: "assessment-terms.json", terms: assessmentFile.count },
      diagnosis: { file: "diagnosis-terms.json", terms: diagnosisFile.count },
    },
    variables,
  };

  return new Map<string, string>([
    ["snapshot.json", canonicalJson(snapshot)],
    ["diagnosis-terms.json", diagnosisFile.text],
    ["assessment-terms.json", assessmentFile.text],
    ["dataset.schema.json", canonicalJson(bagelModels.dataset_schema)],
    ["dictionary.schema.json", canonicalJson(bagelModels.dictionary_schema)],
  ]);
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const outputs = await buildVocabFiles();
  let drifted = false;
  for (const [name, text] of outputs) {
    const path = join(VOCAB_DIR, name);
    if (check) {
      let current: string | null = null;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = null;
      }
      if (current !== text) {
        drifted = true;
        console.error(`DRIFT ${name}`);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`wrote ${name} (${text.length} bytes)`);
    }
  }
  if (check) {
    if (drifted) process.exit(1);
    console.log("vocabulary snapshot matches the pins");
  }
}

if (import.meta.main) await main();
