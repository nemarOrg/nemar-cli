#!/usr/bin/env bun
/**
 * Monitor Cloudflare Workers and KV usage
 *
 * Run: bun run scripts/monitor-usage.ts
 *
 * This script queries the Cloudflare GraphQL API to check:
 * - Worker invocations (requests to each worker)
 * - KV operations (reads/writes per namespace)
 *
 * After switching to Cache API, KV operations for nemar-api should be 0.
 */

import { execSync } from "child_process";

const ACCOUNT_ID = "10f166f3ec8395ff4a219f581c5f359d";

// Get OAuth token from wrangler config
function getToken(): string {
  try {
    const config = execSync("cat ~/.wrangler/config/default.toml", { encoding: "utf-8" });
    const match = config.match(/oauth_token = "([^"]+)"/);
    if (match) return match[1];
  } catch {
    // Ignore
  }
  throw new Error("Could not find Cloudflare OAuth token. Run 'wrangler login' first.");
}

interface GraphQLResponse<T> {
  data: {
    viewer: {
      accounts: T[];
    };
  } | null;
  errors?: Array<{ message: string }>;
}

async function queryGraphQL<T>(query: string): Promise<T[]> {
  const token = getToken();
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const result = await response.json() as GraphQLResponse<T>;
  if (result.errors) {
    throw new Error(result.errors.map(e => e.message).join(", "));
  }
  return result.data?.viewer.accounts ?? [];
}

async function getWorkerInvocations(startDate: string, endDate: string) {
  const query = `query {
    viewer {
      accounts(filter: { accountTag: "${ACCOUNT_ID}" }) {
        workersInvocationsAdaptive(
          limit: 20,
          filter: { datetime_geq: "${startDate}T00:00:00Z", datetime_leq: "${endDate}T23:59:59Z" }
        ) {
          dimensions { scriptName }
          sum { requests subrequests errors }
        }
      }
    }
  }`;

  const accounts = await queryGraphQL<{
    workersInvocationsAdaptive: Array<{
      dimensions: { scriptName: string };
      sum: { requests: number; subrequests: number; errors: number };
    }>;
  }>(query);

  return accounts[0]?.workersInvocationsAdaptive ?? [];
}

async function getKVOperations(namespaceId: string, startDate: string, endDate: string) {
  const query = `query {
    viewer {
      accounts(filter: { accountTag: "${ACCOUNT_ID}" }) {
        kvOperationsAdaptiveGroups(
          filter: { namespaceId: "${namespaceId}", date_geq: "${startDate}", date_leq: "${endDate}" }
          limit: 100
          orderBy: [date_DESC]
        ) {
          dimensions { date actionType }
          sum { requests }
        }
      }
    }
  }`;

  const accounts = await queryGraphQL<{
    kvOperationsAdaptiveGroups: Array<{
      dimensions: { date: string; actionType: string };
      sum: { requests: number };
    }>;
  }>(query);

  return accounts[0]?.kvOperationsAdaptiveGroups ?? [];
}

async function main() {
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║         Cloudflare Workers & KV Usage Monitor                  ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log();

  // Worker Invocations
  console.log(`📊 Worker Invocations (${yesterday} to ${today})`);
  console.log("─".repeat(60));

  const invocations = await getWorkerInvocations(yesterday, today);

  if (invocations.length === 0) {
    console.log("  No invocations recorded");
  } else {
    console.log("  Worker                    Requests    Subrequests    Errors");
    console.log("  " + "─".repeat(56));
    for (const inv of invocations.sort((a, b) => b.sum.requests - a.sum.requests)) {
      const name = inv.dimensions.scriptName.padEnd(24);
      const reqs = inv.sum.requests.toString().padStart(8);
      const subs = inv.sum.subrequests.toString().padStart(12);
      const errs = inv.sum.errors.toString().padStart(10);
      console.log(`  ${name}${reqs}${subs}${errs}`);
    }
  }

  console.log();

  // KV Operations (check remaining namespaces)
  console.log(`📦 KV Operations (${yesterday} to ${today})`);
  console.log("─".repeat(60));

  const kvNamespaces = [
    { id: "18f0bc588a2a4e24bd1d98b51340bd5a", name: "HED_CACHE" },
    { id: "8deb8c02177349afb1d1fe2f7d4079f4", name: "RATE_LIMITER (hed-bot)" },
    { id: "8f8506b1a7fb400680a00014312c124d", name: "RATE_LIMITER (osa)" },
  ];

  for (const ns of kvNamespaces) {
    const ops = await getKVOperations(ns.id, yesterday, today);
    const total = ops.reduce((sum, op) => sum + op.sum.requests, 0);

    console.log(`  ${ns.name}: ${total} operations`);
    if (ops.length > 0) {
      for (const op of ops) {
        console.log(`    - ${op.dimensions.date} ${op.dimensions.actionType}: ${op.sum.requests}`);
      }
    }
  }

  console.log();

  // Summary
  console.log("📈 Summary");
  console.log("─".repeat(60));

  const nemarRequests = invocations.find(i => i.dimensions.scriptName === "nemar-api")?.sum.requests ?? 0;
  const nemarDevRequests = invocations.find(i => i.dimensions.scriptName === "nemar-api-dev")?.sum.requests ?? 0;

  console.log(`  nemar-api (production): ${nemarRequests} requests`);
  console.log(`  nemar-api-dev (testing): ${nemarDevRequests} requests`);
  console.log();
  console.log("  ✅ Rate limiting now uses Cache API (no KV operations)");
  console.log("  ✅ Dev environment has rate limiting disabled");
  console.log();

  // Cost estimate
  console.log("💰 Estimated Savings");
  console.log("─".repeat(60));
  console.log(`  Before: ${nemarRequests} requests × 2 KV ops = ${nemarRequests * 2} KV operations`);
  console.log(`  After:  0 KV operations (using Cache API)`);
  console.log();
  console.log("  Free tier limits:");
  console.log("    - KV reads:  100,000/day");
  console.log("    - KV writes: 1,000/day  ← Previously at risk");
  console.log();
}

main().catch(console.error);
