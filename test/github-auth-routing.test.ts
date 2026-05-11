// Phase 3 routing helper: getDatasetsToken collapses the App/PAT
// selection into a single bearer-string call. Routes use this instead
// of `c.env.GITHUB_ADMIN_PAT` so the right token gets used per env.

import { describe, expect, test } from "bun:test";
import {
  __resetInstallationTokenCacheForTests,
  __seedInstallationTokenCacheForTests,
  getDatasetsAuth,
  getDatasetsToken,
} from "../backend/src/services/github-auth";
import type { Bindings } from "../backend/src/types/bindings";

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    GITHUB_ADMIN_PAT: "pat-fallback",
    GITHUB_APP_ID: "100",
    GITHUB_APP_PRIVATE_KEY: "(unused in these tests)",
    GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "111",
    GITHUB_APP_INSTALLATION_ID_NEMAR_ORG: "222",
    ...overrides,
  } as Bindings;
}

describe("getDatasetsAuth", () => {
  test("returns kind=app when App is fully configured", () => {
    const auth = getDatasetsAuth(makeEnv());
    expect(auth.kind).toBe("app");
    if (auth.kind === "app") expect(auth.installationId).toBe(111);
  });

  test("falls back to kind=pat when App is missing GITHUB_APP_ID", () => {
    const auth = getDatasetsAuth(makeEnv({ GITHUB_APP_ID: undefined }));
    expect(auth.kind).toBe("pat");
    if (auth.kind === "pat") expect(auth.token).toBe("pat-fallback");
  });

  test("falls back to kind=pat when nemarDatasets install ID is missing", () => {
    const auth = getDatasetsAuth(
      makeEnv({ GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined }),
    );
    expect(auth.kind).toBe("pat");
  });
});

describe("getDatasetsToken", () => {
  test("returns the seeded App token when App is configured", async () => {
    __resetInstallationTokenCacheForTests();
    __seedInstallationTokenCacheForTests(111, "ghs_app_seeded", Date.now() + 60 * 60 * 1000);
    try {
      const token = await getDatasetsToken(makeEnv());
      expect(token).toBe("ghs_app_seeded");
    } finally {
      __resetInstallationTokenCacheForTests();
    }
  });

  test("returns the PAT when App secrets aren't configured", async () => {
    __resetInstallationTokenCacheForTests();
    const token = await getDatasetsToken(makeEnv({ GITHUB_APP_ID: undefined }));
    expect(token).toBe("pat-fallback");
  });
});
