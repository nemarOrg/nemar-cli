/**
 * Host-fork decision tests (epic #923, phase 3 / #925; the `mcp` arm added
 * epic #1065 phase 2 / #1294).
 *
 * Verifies the single worker forks the right sub-app per hostname, that the
 * defaults preserve exact prod behavior when DATA_HOSTNAME/ZARR_HOSTNAME/
 * MCP_HOSTNAME are unset, and that the staging worker claims only its -test
 * hosts (not the prod literals). Pure function, no harness.
 */

import { describe, expect, test } from "bun:test";
import { resolveHostRoute } from "../src/services/host-routing";
import type { Bindings } from "../src/types/bindings";

type HostVars = Pick<Bindings, "DATA_HOSTNAME" | "ZARR_HOSTNAME" | "MCP_HOSTNAME">;

const prodEnv = {} as HostVars;
const stagingEnv = {
  DATA_HOSTNAME: "data-test.nemar.org",
  ZARR_HOSTNAME: "zarr-test.nemar.org",
  MCP_HOSTNAME: "mcp-test.nemar.org",
} as HostVars;

describe("resolveHostRoute defaults (prod, vars unset)", () => {
  test("prod literals fork to their sub-apps", () => {
    expect(resolveHostRoute("data.nemar.org", prodEnv)).toBe("data");
    expect(resolveHostRoute("zarr.nemar.org", prodEnv)).toBe("zarr");
    expect(resolveHostRoute("mcp.nemar.org", prodEnv)).toBe("mcp");
  });

  test("api host and workers.dev fall through to api", () => {
    expect(resolveHostRoute("api.nemar.org", prodEnv)).toBe("api");
    expect(resolveHostRoute("nemar-api.sccn-org.workers.dev", prodEnv)).toBe("api");
  });

  test("case-insensitive", () => {
    expect(resolveHostRoute("DATA.NEMAR.ORG", prodEnv)).toBe("data");
    expect(resolveHostRoute("Zarr.Nemar.Org", prodEnv)).toBe("zarr");
    expect(resolveHostRoute("Mcp.Nemar.Org", prodEnv)).toBe("mcp");
  });

  test("empty-string host vars fall back to the prod defaults", () => {
    const emptyEnv = { DATA_HOSTNAME: "", ZARR_HOSTNAME: "", MCP_HOSTNAME: "" } as HostVars;
    expect(resolveHostRoute("data.nemar.org", emptyEnv)).toBe("data");
    expect(resolveHostRoute("zarr.nemar.org", emptyEnv)).toBe("zarr");
    expect(resolveHostRoute("mcp.nemar.org", emptyEnv)).toBe("mcp");
  });
});

describe("resolveHostRoute staging (data-test/zarr-test/mcp-test)", () => {
  test("the -test hosts fork to their sub-apps", () => {
    expect(resolveHostRoute("data-test.nemar.org", stagingEnv)).toBe("data");
    expect(resolveHostRoute("zarr-test.nemar.org", stagingEnv)).toBe("zarr");
    expect(resolveHostRoute("mcp-test.nemar.org", stagingEnv)).toBe("mcp");
    expect(resolveHostRoute("api-test.nemar.org", stagingEnv)).toBe("api");
  });

  test("staging worker does NOT claim the prod literals", () => {
    // If a request for the prod host somehow reached the staging worker, it must
    // fall through to the api app, not hijack the data/zarr/mcp fork.
    expect(resolveHostRoute("data.nemar.org", stagingEnv)).toBe("api");
    expect(resolveHostRoute("zarr.nemar.org", stagingEnv)).toBe("api");
    expect(resolveHostRoute("mcp.nemar.org", stagingEnv)).toBe("api");
  });

  test("dev workers.dev fallback host is api", () => {
    expect(resolveHostRoute("nemar-api-dev.sccn-org.workers.dev", stagingEnv)).toBe("api");
  });
});
