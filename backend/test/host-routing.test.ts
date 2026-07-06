/**
 * Host-fork decision tests (epic #923, phase 3 / #925).
 *
 * Verifies the single worker forks the right sub-app per hostname, that the
 * defaults preserve exact prod behavior when DATA_HOSTNAME/ZARR_HOSTNAME are
 * unset, and that the staging worker claims only its -test hosts (not the prod
 * literals). Pure function, no harness.
 */

import { describe, expect, test } from "bun:test";
import { resolveHostRoute } from "../src/services/host-routing";
import type { Bindings } from "../src/types/bindings";

const prodEnv = {} as Pick<Bindings, "DATA_HOSTNAME" | "ZARR_HOSTNAME">;
const stagingEnv = {
  DATA_HOSTNAME: "data-test.nemar.org",
  ZARR_HOSTNAME: "zarr-test.nemar.org",
} as Pick<Bindings, "DATA_HOSTNAME" | "ZARR_HOSTNAME">;

describe("resolveHostRoute defaults (prod, vars unset)", () => {
  test("prod literals fork to their sub-apps", () => {
    expect(resolveHostRoute("data.nemar.org", prodEnv)).toBe("data");
    expect(resolveHostRoute("zarr.nemar.org", prodEnv)).toBe("zarr");
  });

  test("api host and workers.dev fall through to api", () => {
    expect(resolveHostRoute("api.nemar.org", prodEnv)).toBe("api");
    expect(resolveHostRoute("nemar-api.sccn-org.workers.dev", prodEnv)).toBe("api");
  });

  test("case-insensitive", () => {
    expect(resolveHostRoute("DATA.NEMAR.ORG", prodEnv)).toBe("data");
    expect(resolveHostRoute("Zarr.Nemar.Org", prodEnv)).toBe("zarr");
  });

  test("empty-string host vars fall back to the prod defaults", () => {
    const emptyEnv = { DATA_HOSTNAME: "", ZARR_HOSTNAME: "" } as Pick<
      Bindings,
      "DATA_HOSTNAME" | "ZARR_HOSTNAME"
    >;
    expect(resolveHostRoute("data.nemar.org", emptyEnv)).toBe("data");
    expect(resolveHostRoute("zarr.nemar.org", emptyEnv)).toBe("zarr");
  });
});

describe("resolveHostRoute staging (data-test/zarr-test)", () => {
  test("the -test hosts fork to their sub-apps", () => {
    expect(resolveHostRoute("data-test.nemar.org", stagingEnv)).toBe("data");
    expect(resolveHostRoute("zarr-test.nemar.org", stagingEnv)).toBe("zarr");
    expect(resolveHostRoute("api-test.nemar.org", stagingEnv)).toBe("api");
  });

  test("staging worker does NOT claim the prod literals", () => {
    // If a request for the prod host somehow reached the staging worker, it must
    // fall through to the api app, not hijack the data/zarr fork.
    expect(resolveHostRoute("data.nemar.org", stagingEnv)).toBe("api");
    expect(resolveHostRoute("zarr.nemar.org", stagingEnv)).toBe("api");
  });

  test("dev workers.dev fallback host is api", () => {
    expect(resolveHostRoute("nemar-api-dev.sccn-org.workers.dev", stagingEnv)).toBe("api");
  });
});
