/**
 * Fail-closed guard for tests that spawn the MCP server or hit the Blacklist
 * API directly. Resolves BLACKLIST_API_URL the exact same way src/index.ts's
 * resolveApiUrl() does, then refuses (throws at import time) unless that
 * resolves to the dev host. This must resolve-then-check rather than
 * hard-code the dev URL, or a test run pointed at prod by mistake would never
 * be caught.
 */

import dotenv from "dotenv";
import { legacyTransport, startInProcess } from "./http-server.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HttpServerHandle } from "../../src/index.js";

// Mirrors resolveApiUrl() exactly: load .env, then resolve, so this check
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

// --- HTTP endpoint for the dev-pinned suites (C5) ---

/** Hostnames the dev-pinned suites may point MCP_TEST_URL at (port ignored, same shape as parseAllowedHosts). Never 162.55.129.53 (prod). */
const ALLOWED_TEST_HOSTS = new Set(["127.0.0.1", "localhost", "94.130.51.230"]);
const ALLOWED_TEST_HOST_SUFFIX = ".amlbot.rocks";

function assertAllowedTestHost(rawUrl: string): void {
  const hostname = new URL(rawUrl).hostname;
  const allowed =
    ALLOWED_TEST_HOSTS.has(hostname) || hostname.endsWith(ALLOWED_TEST_HOST_SUFFIX);
  if (!allowed) {
    throw new Error(
      `Refusing to run: MCP_TEST_URL resolves to host "${hostname}", which is not on the ` +
        `allow-list (127.0.0.1, localhost, 94.130.51.230, *.amlbot.rocks). This suite creates ` +
        `and deletes real rows and must never run against an unrecognised host, especially prod ` +
        `(162.55.129.53).`
    );
  }
}

export interface DevServerHandle {
  url: string;
  close: () => Promise<void>;
}

// Captured by startDevServer() before it hands off to startInProcess(),
// which deletes BLACKLIST_API_KEY from the environment.
let devKey: string | undefined;

/**
 * The HTTP endpoint the 7 dev-pinned suites connect to: MCP_TEST_URL when
 * set (a deployed instance, fails closed against the allow-list above), else
 * an in-process listener wired to the dev Label Cloud API. Captures
 * BLACKLIST_API_KEY as the per-request bearer key first, since
 * startInProcess() deletes it (the HTTP transport never holds a server-side key).
 */
export async function startDevServer(): Promise<DevServerHandle> {
  const key = process.env.BLACKLIST_API_KEY;
  if (!key) {
    throw new Error(
      "BLACKLIST_API_KEY is required to run the dev-pinned MCP suites: it becomes the " +
        "per-request Bearer key sent to the HTTP transport."
    );
  }
  devKey = key;

  const testUrl = process.env.MCP_TEST_URL;
  if (testUrl) {
    assertAllowedTestHost(testUrl);
    return { url: testUrl, close: async () => {} };
  }

  const handle: HttpServerHandle = await startInProcess();
  return handle;
}

/** The v1 legacy transport, pre-authorized with the key startDevServer() captured. */
export function devTransport(url: string): StreamableHTTPClientTransport {
  if (!devKey) {
    throw new Error("devTransport() called before startDevServer() captured BLACKLIST_API_KEY");
  }
  return legacyTransport(url, { Authorization: `Bearer ${devKey}` });
}
