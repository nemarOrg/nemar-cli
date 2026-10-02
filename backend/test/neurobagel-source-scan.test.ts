/**
 * What the Neurobagel feature's SOURCE may and may not do (epic #1586, phase 4; ADR 0084).
 *
 * These are scans of the code, so they prove an ABSENCE a behavioural test cannot: that
 * no second module can write the bucket, that nothing in the feature reads the reserved
 * DOI except through the blinded projection, that no code path of the feature sends mail
 * or dispatches to GitHub, that the hooks are never awaited, and that the committed
 * configuration turns everything off. A scan is weaker than a behaviour (it reads text),
 * so each one is paired with a test that RUNS the thing it is about, named in a comment,
 * and each scan fails when the line it guards is introduced (see the mutation battery in
 * the pull request).
 *
 * "The feature" is `services/neurobagel-*.ts`, `routes/neurobagel.ts` and
 * `routes/admin/neurobagel.ts`. The data plane the gatherer calls in-process
 * (`routes/data.ts`) is not part of it: it already reads the public repositories it
 * serves, and it is the code whose answers the feature takes as given.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEV_CRON_ALLOWLIST } from "../src/index";

const SRC = join(import.meta.dir, "../src");
const SERVICES = join(SRC, "services");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(join(dir, e.name)));
    else if (e.name.endsWith(".ts")) out.push(join(dir, e.name));
  }
  return out;
}

/**
 * Source without comments, by a small scanner that knows strings and template literals,
 * so a `/*` inside a line comment or a `//` inside a URL is not mistaken for the start or
 * end of anything. (A pair of regular expressions was tried first and swallowed a code
 * line after a comment that mentioned `/neurobagel/*`.) Comment text is replaced by
 * nothing, string contents are kept: the scans below look for what the code SAYS.
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\") {
          out += text[i] as string;
          i++;
        }
        out += text[i] as string;
        i++;
      }
      out += quote;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const code = (file: string): string => stripComments(readFileSync(file, "utf8"));

const FEATURE = [
  ...readdirSync(SERVICES)
    .filter((f) => /^neurobagel-.*\.ts$/.test(f))
    .map((f) => join(SERVICES, f)),
  join(SRC, "routes/neurobagel.ts"),
  join(SRC, "routes/admin/neurobagel.ts"),
];
const WRITER = join(SERVICES, "neurobagel-writer.ts");
const HOOKS = join(SERVICES, "neurobagel-hooks.ts");
const rel = (f: string) => f.slice(SRC.length + 1);

describe("the feature is the set of files this scan thinks it is", () => {
  test("discovery finds the modules, so nothing below passes over an empty list", () => {
    expect(FEATURE.map(rel).sort()).toEqual(
      [
        "routes/admin/neurobagel.ts",
        "routes/neurobagel.ts",
        "services/neurobagel-curation.ts",
        "services/neurobagel-eligibility.ts",
        "services/neurobagel-fingerprint.ts",
        "services/neurobagel-gather.ts",
        "services/neurobagel-hooks.ts",
        "services/neurobagel-ops.ts",
        "services/neurobagel-plan.ts",
        "services/neurobagel-status.ts",
        "services/neurobagel-store.ts",
        "services/neurobagel-writer.ts",
      ].sort(),
    );
  });
});

describe("only the writer writes the bucket", () => {
  // Behavioural twin: neurobagel-writer.test.ts counts every put and delete a run makes.
  const CALL = /\.(put|delete|createMultipartUpload|resumeMultipartUpload)\s*\(/;

  test("no feature module but the writer calls put or delete on anything", () => {
    for (const file of FEATURE.filter((f) => f !== WRITER)) {
      expect(code(file).match(CALL), `${rel(file)} writes`).toBeNull();
    }
  });

  test("the writer does call them, so the scan above is not vacuous", () => {
    const writer = code(WRITER);
    expect(writer).toMatch(/\.put\s*\(/);
    expect(writer).toMatch(/\.delete\s*\(/);
  });

  test("the binding is named only by the files that are meant to hold it", () => {
    // The binding: a member access (`env.NEUROBAGEL`), an interface member
    // (`NEUROBAGEL?: R2Bucket`) or a type key (`"NEUROBAGEL"`). Not the `NEUROBAGEL_*`
    // variables, and not the word in a message.
    const binding = /\.\s*NEUROBAGEL\b(?!_)|^\s*NEUROBAGEL\??:|"NEUROBAGEL"/m;
    const holders = walk(SRC)
      .filter((f) => binding.test(code(f)))
      .map(rel)
      .sort();
    expect(holders).toEqual(
      [
        "types/bindings.ts",
        "routes/neurobagel.ts",
        "services/neurobagel-ops.ts",
        "services/neurobagel-status.ts",
        "services/neurobagel-writer.ts",
      ].sort(),
    );
  });

  test("no file outside the feature writes through a variable that holds the binding", () => {
    // The route and status read it; neither is the writer, and the first test above
    // already refused a put or delete in them. This one covers the rest of the tree.
    for (const file of walk(SRC)) {
      if (FEATURE.includes(file)) continue;
      const c = code(file);
      if (!/\.\s*NEUROBAGEL\b(?!_)/.test(c)) continue;
      expect(c, `${rel(file)} names NEUROBAGEL`).not.toMatch(
        /\.\s*NEUROBAGEL\b(?!_)[\s\S]{0,200}\.(put|delete)\s*\(/,
      );
    }
  });
});

describe("the reserved DOI is read only through the blinded projection", () => {
  // Behavioural twin: neurobagel-writer.test.ts runs an anonymous dataset through the
  // writer and the anonymity-projection suites pin CONCEPT_DOI_SQL itself.
  test("no feature SQL names d.concept_doi or datasets.concept_doi", () => {
    for (const file of FEATURE) {
      const c = code(file);
      expect(c, `${rel(file)} reads the raw column`).not.toMatch(/\bd\.concept_doi\b/);
      expect(c, `${rel(file)} reads the raw column`).not.toMatch(/\bdatasets\.concept_doi\b/);
    }
  });

  test("a statement that selects from datasets names concept_doi only as the projection's alias", () => {
    for (const file of FEATURE) {
      // Every template or string literal that is SQL over `datasets`.
      const literals = [...code(file).matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => m[1] ?? m[2] ?? "")
        .filter((s) => /\bFROM\s+datasets\b/i.test(s));
      for (const sql of literals) {
        const withoutProjection = sql.replace(/\$\{CONCEPT_DOI_SQL\}\s+AS\s+concept_doi/g, "");
        expect(withoutProjection, `${rel(file)}: ${sql.slice(0, 60)}`).not.toMatch(/concept_doi/);
      }
    }
  });

  test("the modules that project it import the blinded projection", () => {
    for (const file of FEATURE) {
      const c = code(file);
      if (/CONCEPT_DOI_SQL\}\s+AS\s+concept_doi/.test(c)) {
        expect(c).toMatch(
          /import\s*\{[^}]*\bCONCEPT_DOI_SQL\b[^}]*\}\s*from\s*"\.\/anonymity\.js"/,
        );
      }
    }
    // And there are such modules: the fingerprint and the plan both read the DOI.
    const projecting = FEATURE.filter((f) => /CONCEPT_DOI_SQL\}\s+AS\s+concept_doi/.test(code(f)));
    expect(projecting.map(rel).sort()).toEqual([
      "services/neurobagel-plan.ts",
      "services/neurobagel-writer.ts",
    ]);
  });
});

describe("nothing in the feature sends mail or dispatches to GitHub", () => {
  // Behavioural twin: neurobagel-hooks.test.ts runs the writer as a dev worker with a
  // live mail key and records everything it speaks to.
  const FORBIDDEN_IMPORT =
    /\/(email|broadcast|github|github-auth|datacite|doi|doi-metadata|ezid|zenodo|approval-dispatch|import-failure-issue|notices)(\.js|\/)/;
  const FORBIDDEN_NAMES =
    /\b(sendEmail|sendBroadcast|sendAnonymity\w*Email|repository_dispatch|getDatasetsToken|createOrUpdateFile|createIssue|triggerWorkflow|RESEND_API_KEY|api\.github\.com)\b/;

  test("no feature module imports a mail, GitHub or registrar module", () => {
    for (const file of FEATURE) {
      const imports = [...code(file).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      for (const spec of imports) {
        expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(FORBIDDEN_IMPORT);
      }
    }
  });

  test("no feature module names a mail or dispatch API", () => {
    for (const file of FEATURE) {
      expect(code(file), rel(file)).not.toMatch(FORBIDDEN_NAMES);
    }
  });

  test("an anonymity-class finding is written to the audit log and nowhere else", () => {
    const plan = code(join(SERVICES, "neurobagel-plan.ts"));
    expect(plan).toMatch(/auditLogStatement/);
    // The dataset_anonymity mail category is the other channel ADR 0067 names; not used here.
    for (const file of FEATURE) expect(code(file)).not.toMatch(/dataset_anonymity/);
  });
});

describe("the hooks", () => {
  const SITES: Record<string, number> = {
    "services/publication-orchestrator.ts": 2,
    "routes/callbacks/manifest.ts": 1,
    "routes/callbacks/version-doi.ts": 1,
    "routes/callbacks/import-state.ts": 1,
  };

  test("exactly these files call the hook, this many times (the one reachable legacy version path included)", () => {
    const found: Record<string, number> = {};
    for (const file of walk(SRC)) {
      if (file === HOOKS) continue;
      const n = (code(file).match(/\bscheduleNeurobagelSync\s*\(/g) ?? []).length;
      if (n > 0) found[rel(file)] = n;
    }
    expect(found).toEqual(SITES);
  });

  test("it is never awaited, returned or chained: the flow cannot depend on it", () => {
    for (const file of walk(SRC)) {
      const c = code(file);
      expect(c, rel(file)).not.toMatch(/\bawait\s+scheduleNeurobagelSync\b/);
      expect(c, rel(file)).not.toMatch(/\breturn\s+scheduleNeurobagelSync\b/);
      expect(c, rel(file)).not.toMatch(
        /\bscheduleNeurobagelSync\s*\([^;]*\)\s*\.(then|catch|finally)\b/,
      );
    }
  });

  test("every call site hands it the flow's own waitUntil and a stable trigger name", () => {
    for (const file of Object.keys(SITES)) {
      const c = code(join(SRC, file));
      for (const call of c.matchAll(/scheduleNeurobagelSync\(([\s\S]*?)\);/g)) {
        expect(call[1], file).toMatch(/waitUntil/);
        expect(call[1], file).toMatch(/"hook:(publication|version|import)"/);
      }
    }
  });

  test("the version hooks follow the metadata refresh they depend on (they read what it writes)", () => {
    for (const file of ["routes/callbacks/manifest.ts", "routes/callbacks/version-doi.ts"]) {
      const c = code(join(SRC, file));
      const calls = [...c.matchAll(/scheduleNeurobagelSync\(([\s\S]*?)\);/g)];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call[1], file).toMatch(/after:\s*refreshed/);
    }
  });

  test("the hook module runs the work inside waitUntil and catches everything", () => {
    const hooks = code(HOOKS);
    const fn = hooks.slice(hooks.indexOf("export function scheduleNeurobagelSync"));
    expect(fn).toMatch(/waitUntil\(work\)/);
    expect(fn).toMatch(/\.catch\(/);
    expect(fn).toMatch(/try\s*\{/);
    expect(fn).toMatch(/catch\s*\(err\)/);
  });
});

describe("the read route", () => {
  const route = code(join(SRC, "routes/neurobagel.ts"));

  test("compares the token in constant time, from the shared helper", () => {
    expect(route).toMatch(
      /import\s*\{\s*timingSafeEqual\s*\}\s*from\s*"\.\.\/lib\/constant-time\.js"/,
    );
    expect(route).toMatch(/timingSafeEqual\(/);
    expect(route).not.toMatch(/===\s*token\b|\btoken\s*===|!==\s*token\b|\btoken\s*!==/);
    expect(route).not.toMatch(/NEUROBAGEL_READ_TOKEN[^\n]*(===|!==)/);
  });

  test("never lists the bucket, and only reads from it", () => {
    expect(route).not.toMatch(/\.list\s*\(/);
    expect(route).not.toMatch(/\.(put|delete|head)\s*\(/);
    expect(route).toMatch(/\.get\(/);
  });

  test("answers only GET (a route handler for any other method is a new surface)", () => {
    expect(route).not.toMatch(/neurobagelRoutes\.(post|put|patch|delete|all)\s*\(/);
  });

  test("re-checks eligibility on the artifact path and filters the index through the same check", () => {
    expect(route).toMatch(/loadEligibleRow\(/);
    expect(route).toMatch(/eligibleAmong\(/);
  });
});

describe("the committed configuration is OFF", () => {
  const text = readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf8");
  const config = Bun.TOML.parse(text) as {
    vars?: Record<string, unknown>;
    r2_buckets?: { binding: string; bucket_name: string }[];
    triggers?: { crons: string[] };
    env?: {
      dev?: {
        vars?: Record<string, unknown>;
        r2_buckets?: { binding: string; bucket_name: string }[];
        triggers?: { crons: string[] };
      };
    };
  };

  test("no environment sets the writer's switch, and no secret is committed", () => {
    expect(config.vars?.NEUROBAGEL_WRITER_ENABLED).toBeUndefined();
    expect(config.env?.dev?.vars?.NEUROBAGEL_WRITER_ENABLED).toBeUndefined();
    for (const name of ["NEUROBAGEL_READ_TOKEN"]) {
      expect(config.vars?.[name]).toBeUndefined();
      expect(config.env?.dev?.vars?.[name]).toBeUndefined();
      expect(text).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
    }
    expect(text).not.toMatch(/^\s*NEUROBAGEL_WRITER_ENABLED\s*=/m);
  });

  test("each environment has its own private bucket under one binding name", () => {
    const prod = config.r2_buckets?.find((b) => b.binding === "NEUROBAGEL");
    const dev = config.env?.dev?.r2_buckets?.find((b) => b.binding === "NEUROBAGEL");
    expect(prod?.bucket_name).toBe("nemar-neurobagel");
    expect(dev?.bucket_name).toBe("nemar-neurobagel-dev");
    expect(prod?.bucket_name).not.toBe(dev?.bucket_name);
  });

  test("the dev worker's cron is unchanged and the reconcile is not on the dev allowlist", () => {
    expect(config.env?.dev?.triggers?.crons).toEqual(["0 4 * * *"]);
    expect([...DEV_CRON_ALLOWLIST].some((n) => /neurobagel/i.test(n))).toBe(false);
    expect([...DEV_CRON_ALLOWLIST]).toEqual([
      "publishZarrCatalog",
      "runZarrFidelitySweep",
      "fetchAndSyncDataPapers",
    ]);
  });

  test("the cron call sits in the production-only block, inside waitUntil, with a catch", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const start = index.indexOf("if (prodOnlyJobs) {");
    const reconcile = index.indexOf("runNeurobagelReconcileCron(env,");
    const nonProdTail = index.indexOf("fetchAndSyncCitationCounts(env.DB)");
    expect(start).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(start);
    expect(reconcile).toBeLessThan(nonProdTail);
    expect(index.slice(reconcile - 40, reconcile)).toMatch(/ctx\.waitUntil\(\s*$/);
    expect(index.slice(reconcile, reconcile + 1800)).toContain(".catch(");
  });
});
