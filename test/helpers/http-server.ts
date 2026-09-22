/**
 * In-process HTTP listener helpers for the C5 suites. Starts the real
 * startHttpServer() from src/index.ts on 127.0.0.1:0 (no fixed port, so
 * suites can run in parallel), and gives each test three ways to talk to it:
 * a v1 (2025-11-25) SDK client transport, a raw 2026-07-28 fetch, and a
 * mock upstream Label Cloud to inspect what the server forwarded.
 */

import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../src/index.js";
import type { HttpServerHandle } from "../../src/index.js";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const PROTOCOL_VERSION_2026 = "2026-07-28";

/**
 * Starts the real HTTP transport in-process. Deletes BLACKLIST_API_KEY first
 * (the fail-closed guard in startHttpServer() throws if it's set) - callers
 * that need to assert the fail-closed behaviour itself use startHttpServer()
 * directly instead (see test/http-fail-closed.test.ts).
 */
export async function startInProcess(
  options: { host?: string; port?: number } = {}
): Promise<HttpServerHandle> {
  delete process.env.BLACKLIST_API_KEY;
  return startHttpServer({ host: "127.0.0.1", port: 0, ...options });
}

/** The v1 1.25.3 SDK's streamable-HTTP client transport - the 2025-era path. */
export function legacyTransport(
  url: string,
  headers?: Record<string, string>
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
  });
}

export interface Rpc2026Options {
  method: string;
  params?: Record<string, unknown>;
  key?: string;
  mcpName?: string;
  id?: number | string | null;
}

export interface Rpc2026Result {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * A raw 2026-07-28 request: no initialize, no session, both required `_meta`
 * envelope keys (D2 - the SDK's RequestMetaEnvelopeSchema rejects an
 * envelope with only one), and the SEP-2243 Mcp-Method/Mcp-Name headers.
 */
export async function rpc2026(url: string, opts: Rpc2026Options): Promise<Rpc2026Result> {
  const { method, params = {}, key, mcpName, id = 1 } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION_2026,
    "Mcp-Method": method,
  };
  if (mcpName !== undefined) headers["Mcp-Name"] = mcpName;
  if (key !== undefined) headers["Authorization"] = `Bearer ${key}`;

  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION_2026,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };

  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body (e.g. an SSE stream from the legacy-era selector control) -
    // callers that expect that parse the raw text themselves.
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

export interface UpstreamHit {
  method: string;
  url: string;
  apiKey: string | undefined;
  userAgent: string | undefined;
}

export interface MockUpstream {
  url: string;
  hits: UpstreamHit[];
  close: () => Promise<void>;
}

/** A local stand-in for the Label Cloud API that records every request it sees. */
export async function mockUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<MockUpstream> {
  const hits: UpstreamHit[] = [];
  const server = createNodeHttpServer((req, res) => {
    const apiKeyHeader = req.headers["x-api-key"];
    const userAgentHeader = req.headers["user-agent"];
    hits.push({
      method: req.method ?? "",
      url: req.url ?? "",
      apiKey: Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader,
      userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader,
    });
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

type WriteFn = typeof process.stdout.write;

/**
 * Captures everything written to stdout/stderr while still passing it
 * through, so a C-2 key-leak assertion can inspect it without going silent
 * on failures elsewhere in the suite.
 */
export function captureStdio(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const record = (original: WriteFn): WriteFn =>
    ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any)(chunk, ...rest);
    }) as WriteFn;

  process.stdout.write = record(originalStdoutWrite);
  process.stderr.write = record(originalStderrWrite);

  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}
