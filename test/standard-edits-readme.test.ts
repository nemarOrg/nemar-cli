/**
 * The README edits at their shared home (`shared/standard-edits/readme.ts`).
 *
 * The suites that guarded them before the move still import the old paths and pass unedited:
 * `test/readme-badge-plan.test.ts` (the badge plan, from `backend/src/services/doi.ts`) and
 * `test/import-openneuro.test.ts` (`ensureReadmeMd`, #642). This file proves the old paths are
 * wired to the shared code, then pins what those suites leave open and the upstream re-pull's
 * planner (ADR 0111) relies on: the stub's exact bytes, the import rule over a list of names, and
 * the publish step's choice of content source and deletions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  buildDoiBadge as badgeViaDoiService,
  planReadmeBadgeCommit as planViaDoiService,
} from "../backend/src/services/doi";
import {
  PUBLISH_README_ORDER,
  buildDoiBadge,
  decideReadme,
  planReadmeBadgeCommit,
  readmeProvenanceStub,
  selectPublishReadmes,
} from "../shared/standard-edits/readme";
import { ensureReadmeMd } from "../src/lib/import-openneuro";

describe("the badge pair, at its shared path", () => {
  test("is the very pair the DOI service exports", () => {
    expect(badgeViaDoiService).toBe(buildDoiBadge);
    expect(planViaDoiService).toBe(planReadmeBadgeCommit);
  });

  test("the badge is the shields.io form with the DOI encoded in the image URL only", () => {
    expect(buildDoiBadge("10.82901/nemar.nm000122")).toBe(
      "[![DOI](https://img.shields.io/badge/DOI-10.82901%2Fnemar.nm000122-blue)](https://doi.org/10.82901/nemar.nm000122)",
    );
  });
});

describe("the import's stub", () => {
  test("is these exact bytes, with the DOI line", () => {
    expect(readmeProvenanceStub("ds000117", "10.18112/openneuro.ds000117.v1.0.0")).toBe(
      "<!-- nemar:provenance -->\n## Provenance\n\nThis dataset is mirrored on NEMAR from OpenNeuro.\n\n- Source: [ds000117](https://openneuro.org/datasets/ds000117)\n- DOI: [10.18112/openneuro.ds000117.v1.0.0](https://doi.org/10.18112/openneuro.ds000117.v1.0.0)\n",
    );
  });

  test("and without one when there is no DOI", () => {
    expect(readmeProvenanceStub("ds000117", null)).toBe(
      "<!-- nemar:provenance -->\n## Provenance\n\nThis dataset is mirrored on NEMAR from OpenNeuro.\n\n- Source: [ds000117](https://openneuro.org/datasets/ds000117)\n",
    );
  });
});

describe("decideReadme, the import's rule over names", () => {
  test("a bare README in any case is renamed, and the name it had is reported", () => {
    expect(decideReadme(["CHANGES", "README"])).toEqual({
      kind: "renamed",
      from: "README",
      to: "README.md",
    });
    expect(decideReadme(["readme"])).toEqual({ kind: "renamed", from: "readme", to: "README.md" });
  });

  test("any README with an extension is kept, and wins over a bare one in either order", () => {
    expect(decideReadme(["README", "README.md"])).toEqual({ kind: "kept", path: "README.md" });
    expect(decideReadme(["README.md", "README"])).toEqual({ kind: "kept", path: "README.md" });
    expect(decideReadme(["README.rst"])).toEqual({ kind: "kept", path: "README.rst" });
    expect(decideReadme(["Readme.md"])).toEqual({ kind: "kept", path: "Readme.md" });
    expect(decideReadme(["README.MD"])).toEqual({ kind: "kept", path: "README.MD" });
  });

  test("with two extensions present, the first listed is the one reported", () => {
    expect(decideReadme(["README.txt", "README.md"])).toEqual({ kind: "kept", path: "README.txt" });
    expect(decideReadme(["README.md", "README.txt"])).toEqual({ kind: "kept", path: "README.md" });
  });

  test("names that only look like a README are not one", () => {
    for (const names of [[], ["READMEx"], ["README.md.bak"], ["README."], ["my-README.md"]]) {
      expect(decideReadme(names)).toEqual({ kind: "created", path: "README.md" });
    }
  });
});

describe("ensureReadmeMd carries out decideReadme's decision on disk", () => {
  // What this proves is the file I/O: which names it hands the rule, the rename, the stub it
  // writes, and that a kept README is left alone. The rule itself is pinned by the direct
  // decideReadme tests above.
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "standard-edits-readme-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The names `ensureReadmeMd` sees: regular files at the root, in listing order. */
  const regularFiles = (): string[] =>
    readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);

  const LAYOUTS: Record<string, (dir: string) => void> = {
    "bare README": (d) => writeFileSync(join(d, "README"), "bare body\n"),
    // Renamed like any bare README, and still reported as `from: "README"`: that outcome
    // spelling is the preserved legacy quirk (see ReadmeOutcome), not a bug for this move to fix.
    "lowercase bare readme": (d) => writeFileSync(join(d, "readme"), "lower body\n"),
    "README.md": (d) => writeFileSync(join(d, "README.md"), "md body\n"),
    "README.rst and README.txt": (d) => {
      writeFileSync(join(d, "README.rst"), "rst\n");
      writeFileSync(join(d, "README.txt"), "txt\n");
    },
    "bare README beside README.md": (d) => {
      writeFileSync(join(d, "README"), "bare\n");
      writeFileSync(join(d, "README.md"), "md\n");
    },
    nothing: () => undefined,
    "README.md.bak only": (d) => writeFileSync(join(d, "README.md.bak"), "bak\n"),
    // Not regular files, so not a README to either function.
    "a directory named README": (d) => mkdirSync(join(d, "README")),
    "a symlink named README": (d) => {
      writeFileSync(join(d, "target.txt"), "linked\n");
      symlinkSync("target.txt", join(d, "README"));
    },
  };

  for (const [name, build] of Object.entries(LAYOUTS)) {
    test(name, () => {
      build(root);
      const before = regularFiles();
      const decision = decideReadme(before);
      const bodyOfRenamed =
        decision.kind === "renamed" ? readFileSync(join(root, decision.from), "utf8") : null;

      const outcome = ensureReadmeMd(root, "ds000117", "10.18112/openneuro.ds000117.v1.0.0");

      if (decision.kind === "renamed") {
        // `from` is always "README", whatever case the file had: the legacy outcome, kept as is.
        expect(outcome).toEqual({ kind: "renamed", from: "README", to: "README.md" });
        expect(readFileSync(join(root, "README.md"), "utf8")).toBe(bodyOfRenamed as string);
        expect(regularFiles()).not.toContain(decision.from);
      } else if (decision.kind === "created") {
        expect(outcome).toEqual({ kind: "created", path: "README.md" });
        expect(readFileSync(join(root, "README.md"), "utf8")).toBe(
          readmeProvenanceStub("ds000117", "10.18112/openneuro.ds000117.v1.0.0"),
        );
      } else {
        expect(outcome).toEqual(decision);
        expect(regularFiles().sort()).toEqual([...before].sort());
      }
    });
  }
});

describe("selectPublishReadmes, the publish step's rule over a tree", () => {
  const entry = (path: string) => ({ path, sha: `sha-of-${path}`, type: "blob" });

  test("the order is README.md, README.rst, README.txt, README", () => {
    expect([...PUBLISH_README_ORDER]).toEqual(["README.md", "README.rst", "README.txt", "README"]);
  });

  test("no README: nothing to read and nothing to delete", () => {
    expect(selectPublishReadmes([entry("CHANGES")])).toEqual({
      found: [],
      contentSource: undefined,
      remove: [],
    });
  });

  test("README.md alone is read and kept", () => {
    const md = entry("README.md");
    expect(selectPublishReadmes([entry("CHANGES"), md])).toEqual({
      found: [md],
      contentSource: md,
      remove: [],
    });
  });

  test("a bare README is the content source and is deleted once README.md is written", () => {
    const bare = entry("README");
    expect(selectPublishReadmes([bare])).toEqual({
      found: [bare],
      contentSource: bare,
      remove: [bare],
    });
  });

  test("README.md wins over every other form, and the others are deleted in order", () => {
    const tree = ["README", "README.txt", "README.md", "README.rst"].map(entry);
    const result = selectPublishReadmes(tree);
    expect(result.contentSource?.path).toBe("README.md");
    expect(result.found.map((f) => f.path)).toEqual([
      "README.md",
      "README.rst",
      "README.txt",
      "README",
    ]);
    expect(result.remove.map((f) => f.path)).toEqual(["README.rst", "README.txt", "README"]);
  });

  test("without README.md, the .rst is read before the .txt, and both are deleted", () => {
    const result = selectPublishReadmes(["README.txt", "README.rst"].map(entry));
    expect(result.contentSource?.path).toBe("README.rst");
    expect(result.remove.map((f) => f.path)).toEqual(["README.rst", "README.txt"]);
  });

  test("exact case and the root only: readme.md, Readme and sub-01/README.md are not READMEs", () => {
    const result = selectPublishReadmes(
      ["readme.md", "Readme", "README.MD", "sub-01/README.md"].map(entry),
    );
    expect(result).toEqual({ found: [], contentSource: undefined, remove: [] });
  });

  test("returns the tree's own entries, so the step deletes by the blob it read", () => {
    const bare = entry("README");
    expect(selectPublishReadmes([bare]).remove[0]).toBe(bare);
  });
});

describe("the publish step calls the shared rule", () => {
  // The orchestrator's update_readme step reads GitHub, so no test drives it end to end. This
  // pins, on the parsed syntax tree (so no comment can satisfy or trip it), that the step takes
  // its README selection from the shared rule, reads and badges the content source the rule
  // chose, deletes exactly what the rule says to delete, and keeps no README list of its own, so
  // the re-pull planner cannot model a rule the step no longer follows.
  const ORCHESTRATOR = "publication-orchestrator.ts";
  const file = ts.createSourceFile(
    ORCHESTRATOR,
    readFileSync(join(import.meta.dir, "../backend/src/services", ORCHESTRATOR), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const nodes = (root: ts.Node): ts.Node[] => {
    const out: ts.Node[] = [];
    const visit = (n: ts.Node) => {
      out.push(n);
      ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
  };
  const printer = ts.createPrinter({ removeComments: true });
  /** Code text with every comment and run of whitespace dropped. */
  const code = (n: ts.Node) =>
    printer.printNode(ts.EmitHint.Unspecified, n, file).replace(/\s+/g, "");
  const step = nodes(file).find(
    (n): n is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) && n.name?.text === "stepUpdateReadme",
  );
  const inStep = step ? nodes(step) : [];
  const initializerOf = (name: string) =>
    inStep
      .filter(ts.isVariableDeclaration)
      .filter((d) => ts.isIdentifier(d.name) && d.name.text === name)
      .map((d) => (d.initializer ? code(d.initializer) : ""));

  test("imports selectPublishReadmes from the shared module", () => {
    const imported = file.statements
      .filter(ts.isImportDeclaration)
      .filter(
        (d) =>
          ts.isStringLiteral(d.moduleSpecifier) &&
          d.moduleSpecifier.text === "../../../shared/standard-edits/readme.js",
      )
      .flatMap((d) => {
        const bindings = d.importClause?.namedBindings;
        return bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((e) => e.name.text)
          : [];
      });
    expect(imported).toContain("selectPublishReadmes");
  });

  test("selects from main's tree, reads the chosen source, and badges it under its own path", () => {
    expect(step).toBeDefined();
    expect(initializerOf("tree")).toEqual(['awaitgetTreeAtRef(repoName,"main",pat)']);
    expect(initializerOf("readmes")).toEqual(["selectPublishReadmes(tree)"]);
    expect(initializerOf("contentSource")).toEqual(["readmes.contentSource"]);
    const reads = inStep
      .filter(ts.isCallExpression)
      .filter((c) => code(c.expression) === "getBlobContent")
      .map(code);
    expect(reads).toEqual(["getBlobContent(repoName,contentSource.sha,pat)"]);
    const sourcePath = inStep
      .filter(ts.isPropertyAssignment)
      .filter((p) => ts.isIdentifier(p.name) && p.name.text === "contentSourcePath")
      .map((p) => code(p.initializer));
    expect(sourcePath).toEqual(["contentSource?.path"]);
  });

  test("deletes exactly the files the rule lists, and nothing else", () => {
    const loops = inStep.filter(ts.isForOfStatement);
    expect(loops.map((l) => code(l.expression))).toEqual(["readmes.remove"]);
    const deletes = inStep
      .filter(ts.isCallExpression)
      .filter((c) => code(c.expression) === "deleteRepoFile");
    expect(deletes).toHaveLength(1);
    expect(nodes(loops[0] as ts.Node)).toContain(deletes[0] as ts.Node);
  });

  test("spells no README name but the README.md it writes, anywhere in the file", () => {
    // A re-inlined candidate list, in any case, is a literal naming a README spelling.
    const spellings = nodes(file)
      .filter((n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      .map((n) => (n as ts.StringLiteral).text)
      .filter((t) => /^readme(\.[a-z0-9]+)?$/i.test(t));
    expect(spellings.length).toBeGreaterThan(0);
    expect([...new Set(spellings)]).toEqual(["README.md"]);
  });
});
