/**
 * The conformance run's own configuration (epic #2014 phase #2020): what can be checked without
 * running the suite. The run needs Docker and takes half an hour, so the things that make it
 * trustworthy are pinned here where `bun test` sees them:
 *
 *  - the plan configurations point the suite at the rig's pages and callback, carry two clients, and
 *    the configuration plan carries no client at all;
 *  - every image the run pulls is pinned by digest, and the tags in the override and in the workflow
 *    agree;
 *  - the workflow uses no secret, has read-only permissions, uploads only the results and logs (never
 *    the plan configurations, which hold the throwaway clients' secrets), runs the Basic plan with the
 *    variants the phase approved, and its temporary push trigger is limited to `conformance/**`.
 *
 * Nothing here replaces NEMAR logic; the rig and the suite are exercised by the run.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  RIG_ACCOUNT_EMAIL,
  RIG_TEXT,
  buildBasicPlanConfig,
  buildConfigPlanConfig,
  callbackAddress,
} from "../scripts/oidc-conformance/plan-config";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ADDR = { issuer: "https://rig.example.org:9443", alias: "nemar" };
const CLIENTS = {
  client: { client_id: "client-one", client_secret: "secret-one" },
  client2: { client_id: "client-two", client_secret: "secret-two" },
};

describe("the plan configurations", () => {
  test("the callback address is the suite's alias path", () => {
    expect(callbackAddress("https://localhost.emobix.co.uk:8443/", "nemar")).toBe(
      "https://localhost.emobix.co.uk:8443/test/a/nemar/callback",
    );
  });

  test("the configuration plan reads discovery and holds no client", () => {
    const config = buildConfigPlanConfig(ADDR);
    expect(config.server).toEqual({
      discoveryUrl: "https://rig.example.org:9443/.well-known/openid-configuration",
    });
    expect(Object.keys(config).sort()).toEqual(["alias", "description", "server"]);
  });

  test("the Basic plan has two clients, the sign-in and consent tasks, and the four overrides' pages", () => {
    const config = buildBasicPlanConfig(ADDR, CLIENTS) as {
      client: unknown;
      client2: unknown;
      browser: Array<{
        match: string;
        tasks: Array<{ task: string; match?: string; optional?: boolean }>;
      }>;
      override: Record<string, { browser: unknown[] }>;
    };
    expect(config.client).toEqual(CLIENTS.client);
    expect(config.client2).toEqual(CLIENTS.client2);
    const block = config.browser[0];
    expect(block?.match).toBe("https://rig.example.org:9443/oauth/authorize*");
    expect(block?.tasks.map((t) => t.task)).toEqual(["Login", "Consent", "Verify Complete"]);
    // Sign-in and consent are optional (a prompt=none request shows neither); completion is not.
    expect(block?.tasks.map((t) => t.optional === true)).toEqual([true, true, false]);
    expect(Object.keys(config.override).sort()).toEqual([
      "oidcc-ensure-registered-redirect-uri",
      "oidcc-max-age-1",
      "oidcc-prompt-login",
    ]);
  });

  test("the browser signs in with the rig's account and chooses Allow by its value", () => {
    const text = JSON.stringify(buildBasicPlanConfig(ADDR, CLIENTS));
    expect(text).toContain(RIG_ACCOUNT_EMAIL);
    expect(text).toContain("//button[@value='allow']");
    expect(text).toContain(RIG_TEXT.redirectNotRegistered);
  });
});

describe("the images", () => {
  const override = parse(read("scripts/oidc-conformance/compose.override.yml")) as {
    services: Record<string, { image: string; extra_hosts?: string[] }>;
  };

  test("each of the three is pinned by tag and by digest", () => {
    const images = Object.values(override.services).map((s) => s.image);
    expect(images).toHaveLength(3);
    for (const image of images) expect(image).toMatch(/:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
  });

  test("the suite's two images are at the workflow's release tag", () => {
    const tag = /SUITE_TAG:\s*(\S+)/.exec(read(".github/workflows/oidc-conformance.yml"))?.[1];
    expect(tag).toMatch(/^release-v\d+\.\d+\.\d+$/);
    expect(override.services.server?.image).toContain(`:${tag}@`);
    expect(override.services.nginx?.image).toContain(`:${tag}@`);
    expect(override.services.mongodb?.image).toContain("mongo:6.0.13@");
  });

  test("the suite's server reaches the rig by name, from the host's gateway", () => {
    expect(override.services.server?.extra_hosts).toEqual(["rig.example.org:host-gateway"]);
  });
});

describe("the workflow", () => {
  const text = read(".github/workflows/oidc-conformance.yml");
  interface Step {
    name?: string;
    uses?: string;
    with?: { path: string };
  }
  const workflow = parse(text) as {
    on: { workflow_dispatch: unknown; push: { branches: string[] } };
    permissions: Record<string, string>;
    jobs: { conformance: { "timeout-minutes": number; steps: Step[] } };
  };
  const steps = workflow.jobs.conformance.steps;

  test("is dispatched by hand, and by a push only to conformance branches", () => {
    expect("workflow_dispatch" in workflow.on).toBe(true);
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["conformance/**"]);
  });

  test("reads the repository and nothing else, uses no secret, and is bounded", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(text).not.toMatch(/secrets\./);
    expect(workflow.jobs.conformance["timeout-minutes"]).toBe(60);
  });

  test("uploads the results and the logs, and never the plan configurations", () => {
    const upload = steps.find((s) => String(s.uses).startsWith("actions/upload-artifact@"));
    expect(upload?.with?.path.trim()).toBe("conformance-artifacts/");
    // The plan configurations are written to the runner's temporary directory, outside that path.
    expect(text).toContain("RIG_OUT_DIR=$RUNNER_TEMP/rig-out");
    expect(text).not.toMatch(/path:[^\n]*rig-out/);
  });

  test("runs the configuration plan first, then the approved Basic variants", () => {
    const names = steps.map((s) => s.name);
    expect(names.indexOf("Configuration plan (smoke test, no browser)")).toBeLessThan(
      names.indexOf("Basic plan"),
    );
    expect(text).toContain(
      '"oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]"',
    );
    expect(text).toContain('"oidcc-config-certification-test-plan"');
  });

  test("pins the Python packages exactly", () => {
    expect(text).toContain("--with httpx==0.28.1 --with pyparsing==3.3.3");
  });

  test("checks the suite's commit, so a moved tag fails the run", () => {
    expect(text).toMatch(/SUITE_COMMIT:\s*[0-9a-f]{40}/);
    expect(text).toContain('"$actual" != "$SUITE_COMMIT"');
  });
});
