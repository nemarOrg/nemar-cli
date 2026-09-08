/**
 * The spike's MCP tool registry (issue #1293). Two tools, both far simpler
 * than the real phase 2-4 tool surface (`shared/contract/mcp.ts`) --
 * this spike exists to answer two questions, not to be the server:
 *
 *   1. Does `@modelcontextprotocol/server@2.0.0` + `@modelcontextprotocol/hono@2.0.0`
 *      actually serve tools/list and tools/call under workerd (`wrangler dev`),
 *      in both the 2026-07-28 envelope and the legacy `initialize` handshake?
 *   2. Which blosc/zstd decode path (decision 7 of the phase 1 plan) actually
 *      runs there: `numcodecs`' WASM Blosc codec, or the pure-JS `fzstd` +
 *      manual unshuffle implementation in `decode.ts`?
 *
 * `describe_fixture` answers a static question from the checked-in on008083
 * index fixture -- no network, no decode, just proves tools/list + tools/call
 * round-trip through the SDK on this runtime.
 *
 * `decode_chunk` runs BOTH decode paths against the committed `chunk.bin`
 * (one real inner chunk of nm000329's level-0 array, captured with two range
 * requests against the shard's trailing index -- see README.md) and reports
 * which succeeded, whether they agree, and whether they match the ground
 * truth in `chunk.expected.json` (produced by a real Python `zstandard`
 * decompress + manual unshuffle, cross-checked against
 * `numcodecs.Blosc().decode()` -- see fixtures/chunk.expected.json's `source`
 * field).
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import chunkExpected from "../fixtures/chunk.expected.json";
import on008083Index from "../fixtures/zarr-index-v3.json";
import { decodePathA, decodePathB } from "./decode.js";

// Bun/Wrangler both resolve this relative to the module, per Wrangler's
// documented support for binary asset imports; see wrangler.toml's
// `rules` entry pointing `*.bin` at the `Data` import type.
import chunkBin from "../fixtures/chunk.bin";

function checksum(values: Int16Array): { sum: string; weighted_checksum: string } {
  let sum = 0n;
  let weighted = 0n;
  for (let i = 0; i < values.length; i++) {
    const v = BigInt(values[i]);
    sum += v;
    weighted += v * BigInt(i + 1);
  }
  return { sum: sum.toString(), weighted_checksum: weighted.toString() };
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "mcp-transport-spike", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions: "Phase 1 spike for nemarOrg/nemar-cli#1293 -- not a real NEMAR MCP server.",
      cacheHints: {
        "tools/list": { ttlMs: 86_400_000, cacheScope: "public" },
        "server/discover": { ttlMs: 86_400_000, cacheScope: "public" },
      },
    },
  );

  server.registerTool(
    "describe_fixture",
    {
      title: "Describe fixture",
      description:
        "Summarize the checked-in on008083 zarr index v3 fixture. No network, no decode.",
      inputSchema: z.object({}),
    },
    async () => {
      const index = on008083Index as {
        dataset_id: string;
        format_version: number;
        store_count: number;
        stores: Array<{
          zarr: string;
          groups?: Array<{ name: string; n_channels?: number | null }>;
        }>;
      };
      const summary = {
        dataset_id: index.dataset_id,
        format_version: index.format_version,
        store_count: index.store_count,
        first_store_zarr: index.stores[0]?.zarr ?? null,
        first_store_group: index.stores[0]?.groups?.[0]?.name ?? null,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary) }],
        structuredContent: summary,
      };
    },
  );

  server.registerTool(
    "decode_chunk",
    {
      title: "Decode chunk",
      description:
        "Decode the committed nm000329 level-0 inner chunk through both candidate paths " +
        "(numcodecs WASM blosc, and a pure-JS blosc2-header + fzstd + unshuffle decoder), " +
        "and report whether each succeeded, whether they agree, and whether they match " +
        "the Python-derived ground truth.",
      inputSchema: z.object({}),
    },
    async () => {
      const bytes = new Uint8Array(chunkBin as ArrayBuffer);

      let pathAOk = false;
      let pathAError: string | null = null;
      let pathAChecksum: { sum: string; weighted_checksum: string } | null = null;
      let pathAFirst16: number[] | null = null;
      try {
        const decodedA = await decodePathA(bytes);
        pathAOk = true;
        pathAChecksum = checksum(decodedA);
        pathAFirst16 = Array.from(decodedA.slice(0, 16));
      } catch (err) {
        pathAError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }

      let pathBOk = false;
      let pathBError: string | null = null;
      let pathBChecksum: { sum: string; weighted_checksum: string } | null = null;
      let pathBFirst16: number[] | null = null;
      try {
        const decodedB = decodePathB(bytes);
        pathBOk = true;
        pathBChecksum = checksum(decodedB);
        pathBFirst16 = Array.from(decodedB.slice(0, 16));
      } catch (err) {
        pathBError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }

      const expected = chunkExpected as {
        sum: number;
        weighted_checksum: number;
        first_16_flat: number[];
      };
      const aMatchesExpected =
        pathAOk &&
        pathAChecksum?.sum === String(expected.sum) &&
        pathAChecksum?.weighted_checksum === String(expected.weighted_checksum);
      const bMatchesExpected =
        pathBOk &&
        pathBChecksum?.sum === String(expected.sum) &&
        pathBChecksum?.weighted_checksum === String(expected.weighted_checksum);
      const agree =
        pathAOk &&
        pathBOk &&
        pathAChecksum?.sum === pathBChecksum?.sum &&
        pathAChecksum?.weighted_checksum === pathBChecksum?.weighted_checksum;

      const result = {
        input_bytes: bytes.length,
        path_a_numcodecs_wasm: {
          ok: pathAOk,
          error: pathAError,
          first_16: pathAFirst16,
          checksum: pathAChecksum,
          matches_expected: aMatchesExpected,
        },
        path_b_pure_js: {
          ok: pathBOk,
          error: pathBError,
          first_16: pathBFirst16,
          checksum: pathBChecksum,
          matches_expected: bMatchesExpected,
        },
        paths_agree: agree,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}
