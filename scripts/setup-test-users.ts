#!/usr/bin/env bun
/**
 * Setup Test Users for Integration Testing
 *
 * Creates test users with different access levels:
 * - test-admin: Admin user for testing admin commands
 * - test-user: Regular approved user
 * - test-pending: User awaiting approval
 * - test-revoked: User with revoked access
 *
 * Run: bun run scripts/setup-test-users.ts
 * Cleanup: bun run scripts/setup-test-users.ts --cleanup
 */

import { hashSync } from "bcryptjs";
import { createHash, randomBytes } from "crypto";

const TEST_PASSWORD = "TestPassword123!";
const TEST_USERS = [
  {
    username: "test-admin",
    email: "test-admin@nemar.test",
    github_username: "test-admin-gh",
    status: "approved",
    is_admin: 1,
    email_verified: 1,
  },
  {
    username: "test-user",
    email: "test-user@nemar.test",
    github_username: "test-user-gh",
    status: "approved",
    is_admin: 0,
    email_verified: 1,
  },
  {
    username: "test-pending",
    email: "test-pending@nemar.test",
    github_username: "test-pending-gh",
    status: "pending",
    is_admin: 0,
    email_verified: 0,
  },
  {
    username: "test-verified",
    email: "test-verified@nemar.test",
    github_username: "test-verified-gh",
    status: "verified",
    is_admin: 0,
    email_verified: 1,
  },
  {
    username: "test-revoked",
    email: "test-revoked@nemar.test",
    github_username: "test-revoked-gh",
    status: "revoked",
    is_admin: 0,
    email_verified: 1,
  },
];

function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = "nemar_test_" + randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 16);
  return { key, hash, prefix };
}

function generatePasswordHash(): string {
  return hashSync(TEST_PASSWORD, 10);
}

async function main() {
  const isCleanup = process.argv.includes("--cleanup");

  if (isCleanup) {
    console.log("Cleanup SQL (run with wrangler d1 execute):\n");
    console.log("-- Delete test tokens");
    console.log("DELETE FROM tokens WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'test-%');");
    console.log("-- Delete test audit logs");
    console.log("DELETE FROM audit_log WHERE resource_id LIKE 'test-%';");
    console.log("-- Delete test users");
    console.log("DELETE FROM users WHERE username LIKE 'test-%';");
    return;
  }

  console.log("=".repeat(60));
  console.log("Test User Setup SQL");
  console.log("=".repeat(60));
  console.log("\nRun these commands with: wrangler d1 execute nemar-db --remote\n");

  const passwordHash = generatePasswordHash();
  const credentials: Record<string, string> = {};

  // Generate SQL for users
  console.log("-- Create test users");
  for (const user of TEST_USERS) {
    const approvedAt = user.status === "approved" ? ", datetime('now')" : ", NULL";
    const revokedAt = user.status === "revoked" ? ", datetime('now')" : ", NULL";

    console.log(`INSERT INTO users (username, email, password_hash, github_username, status, is_admin, email_verified, approved_at, revoked_at)`);
    console.log(`VALUES ('${user.username}', '${user.email}', '${passwordHash}', '${user.github_username}', '${user.status}', ${user.is_admin}, ${user.email_verified}${approvedAt}${revokedAt});`);
    console.log();
  }

  // Generate tokens for approved users
  console.log("-- Create API tokens for approved users");
  for (const user of TEST_USERS) {
    if (user.status === "approved") {
      const apiKey = generateApiKey();
      credentials[user.username] = apiKey.key;

      console.log(`INSERT INTO tokens (user_id, api_key_hash, api_key_prefix)`);
      console.log(`SELECT id, '${apiKey.hash}', '${apiKey.prefix}' FROM users WHERE username = '${user.username}';`);
      console.log();
    }
  }

  console.log("=".repeat(60));
  console.log("Test Credentials (save to test/.env.test)");
  console.log("=".repeat(60));
  console.log();
  console.log(`TEST_PASSWORD=${TEST_PASSWORD}`);
  for (const [username, key] of Object.entries(credentials)) {
    const envVar = username.toUpperCase().replace(/-/g, "_") + "_API_KEY";
    console.log(`${envVar}=${key}`);
  }
  console.log();
  console.log("=".repeat(60));
}

main().catch(console.error);
