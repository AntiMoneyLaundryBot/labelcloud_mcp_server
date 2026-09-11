/**
 * Fail-closed guard for tests that spawn the MCP server or hit the Blacklist
 * API directly. Resolves BLACKLIST_API_URL the exact same way src/index.ts:23
 * does, then refuses (throws at import time) unless that resolves to the dev
 * host. This must resolve-then-check rather than hard-code the dev URL, or a
 * test run pointed at prod by mistake would never be caught.
 */

import dotenv from "dotenv";

// Mirrors src/index.ts:20-23 exactly: load .env, then resolve, so this check
// sees the same value the server itself would resolve to.
dotenv.config();

const DEV_API_URL = "https://api-blacklist.amlbot.rocks";

export const resolvedApiUrl =
  process.env.BLACKLIST_API_URL || "https://api-blacklist.amlbot.com";

if (resolvedApiUrl !== DEV_API_URL) {
  throw new Error(
    `Refusing to run: BLACKLIST_API_URL resolves to "${resolvedApiUrl}", not the dev API ` +
      `"${DEV_API_URL}". This test suite creates and deletes real rows and must never run ` +
      `against production. Set BLACKLIST_API_URL=${DEV_API_URL} before running tests.`
  );
}

/**
 * Env object to pass to any spawned MCP server / client transport so it talks
 * to the dev API. Only reachable once the module-load check above has passed.
 */
export function devServerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, BLACKLIST_API_URL: resolvedApiUrl };
}
