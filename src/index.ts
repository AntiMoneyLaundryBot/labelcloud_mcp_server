#!/usr/bin/env node

import { Server, createMcpHandler, type Tool, type AuthInfo } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler, hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import dotenv from "dotenv";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  generateToolsFromSpec,
  buildPath,
  buildQueryString,
  buildRequestBody,
  type OperationInfo,
  type MCPTool,
} from "./openapi-to-mcp.js";
import { setAutoTracing, type SetAutoTracingArgs, type ApiRequestFn } from "./set-auto-tracing.js";
import { getToolConfigByName } from "./tool-config.js";
import { canonicalizeToolArgs } from "./address-canonical.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };
const openApiSpec = require("../docs/blacklist-api-endpoints.json");

export function resolveApiUrl(): string {
  return process.env.BLACKLIST_API_URL || "https://api-blacklist.amlbot.com";
}

// Generate tools from spec
const { tools: generatedTools, operationMap } = generateToolsFromSpec(openApiSpec);

// set_auto_tracing is a hand-written composite (src/set-auto-tracing.ts), not
// generated from the OpenAPI allow-list: it drives two allow-listed operations
// (GET then POST /addresses) and refuses on ambiguous/absent rows in between,
// which the declarative generator has no mechanism for. Its name/description
// still live in tool-config.ts as the single source of truth.
const setAutoTracingConfig = getToolConfigByName("set_auto_tracing");
if (!setAutoTracingConfig) {
  throw new Error("Missing tool-config.ts entry for set_auto_tracing");
}
const SET_AUTO_TRACING_TOOL: MCPTool = {
  name: setAutoTracingConfig.name,
  description: setAutoTracingConfig.description,
  inputSchema: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description:
          "Blockchain address hash (e.g., '0x1234...' for Ethereum, 'T...' for Tron). Not an entity name.",
      },
      network: {
        type: "string",
        description: "Address blockchain (must match the address's existing network exactly).",
      },
      enableSniffer: {
        type: "boolean",
        description: "The new value for the enableSniffer flag.",
      },
    },
    required: ["address", "network", "enableSniffer"],
  },
};

const TOOLS: MCPTool[] = [SET_AUTO_TRACING_TOOL, ...generatedTools];

/**
 * Builds a per-request Label Cloud API client bound to one consumer's key.
 * Keeps today's 3-argument shape (`ApiRequestFn`, pinned at
 * test/address-canonical.test.ts:247) — there is no 4th argument anywhere.
 */
export function makeApiRequest(apiKey: string | undefined, apiUrl: string): ApiRequestFn {
  return async (method, path, body) => {
    if (!apiKey) {
      throw new Error("Missing Label Cloud API key");
    }
    const url = `${apiUrl}${path}`;
    if (method.toUpperCase() !== "GET") {
      console.error(`[labelcloud-mcp-server] write: ${method.toUpperCase()} ${url}`);
    }
    const headers: Record<string, string> = {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      "User-Agent": `labelcloud-mcp/${pkg.version}`,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

/**
 * Translate exposed arg names to the underlying operation's real param names
 * (ToolConfig.argAliases), then merge in any hidden, fixed ToolConfig.presetArgs.
 * Both are invisible to the caller: aliases simplify what they see, presets are
 * values they can never set.
 */
function resolveOperationArgs(
  opInfo: OperationInfo,
  args: Record<string, unknown>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...args };

  if (opInfo.argAliases) {
    for (const [exposedName, underlyingName] of Object.entries(opInfo.argAliases)) {
      if (!(exposedName in resolved)) continue;
      const value = resolved[exposedName];
      delete resolved[exposedName];
      resolved[underlyingName] =
        opInfo.arrayAliasTargets?.includes(underlyingName) && !Array.isArray(value)
          ? [value]
          : value;
    }
  }

  if (opInfo.presetArgs) {
    Object.assign(resolved, opInfo.presetArgs);
  }

  return resolved;
}

/**
 * Generic tool handler that uses operation info from OpenAPI spec
 */
async function handleToolCall(
  apiRequest: ApiRequestFn,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (toolName === "set_auto_tracing") {
    return setAutoTracing(apiRequest, args as unknown as SetAutoTracingArgs);
  }

  const opInfo = operationMap.get(toolName);
  if (!opInfo) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const resolvedArgs = resolveOperationArgs(opInfo, canonicalizeToolArgs(toolName, args));

  // Build path with path parameters
  const pathParams: Record<string, string> = {};
  for (const paramName of opInfo.pathParams) {
    if (resolvedArgs[paramName] !== undefined) {
      pathParams[paramName] = String(resolvedArgs[paramName]);
    }
  }
  const path = buildPath(opInfo.path, pathParams);

  // Build query string
  const queryString = buildQueryString(resolvedArgs, opInfo.queryParams);

  // Build request body
  const body = buildRequestBody(resolvedArgs, opInfo.bodyParams);

  // Construct full path with query string
  const fullPath = queryString ? `${path}?${queryString}` : path;

  return apiRequest(opInfo.method, fullPath, body);
}

/**
 * Builds a fresh low-level Server bound to one apiRequest closure. One
 * instance per stdio connection, or per HTTP request/legacy-fallback under
 * createMcpHandler — the same factory backs both eras (2025 and 2026-07-28).
 */
export function createServer(apiRequest: ApiRequestFn): Server {
  const server = new Server(
    {
      name: "labelcloud-mcp-server",
      version: pkg.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: TOOLS as unknown as Tool[],
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(apiRequest, name, (args as Record<string, unknown>) || {});

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

function startStdio(): void {
  const apiKey = process.env.BLACKLIST_API_KEY;
  if (!apiKey) {
    console.error("Error: BLACKLIST_API_KEY environment variable is required");
    process.exit(1);
  }
  serveStdio(() => createServer(makeApiRequest(apiKey, resolveApiUrl())));
  console.error("AMLBot Blacklist MCP Server running on stdio");
}

// --- HTTP transport: each consumer sends its own key, never a server-held one ---

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Bearer, or the X-Api-Key alias. Never logged, never cached.
 */
export function extractApiKey(headers: IncomingMessage["headers"]): string | undefined {
  const authHeader = headers["authorization"];
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const bearerMatch = authValue ? /^Bearer\s+(\S+)$/i.exec(authValue) : null;
  if (bearerMatch) {
    return bearerMatch[1];
  }
  const apiKeyHeader = headers["x-api-key"];
  const apiKeyValue = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  return apiKeyValue || undefined;
}

interface JsonRpcMessageLike {
  method?: string;
}

/** True if any message in a single-or-batched JSON-RPC body is a tools/call. */
export function requiresKey(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (m) => m !== null && typeof m === "object" && (m as JsonRpcMessageLike).method === "tools/call"
  );
}

/**
 * Comma-separated hostnames (port stripped, bracketed IPv6 kept intact), plus
 * the loopback names always needed for the healthcheck and the deploy probe.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "[::1]"]);
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const hostname = trimmed.startsWith("[")
      ? trimmed.slice(0, trimmed.indexOf("]") + 1)
      : trimmed.split(":")[0];
    if (hostname) hosts.add(hostname);
  }
  return [...hosts];
}

async function readRequestBody(
  req: IncomingMessage
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      return { ok: false, status: 413 };
    }
    chunks.push(chunk as Buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function sendJson(res: ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

export interface HttpServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startHttpServer(
  options: { host?: string; port?: number } = {}
): Promise<HttpServerHandle> {
  if (process.env.BLACKLIST_API_KEY !== undefined) {
    throw new Error(
      "Refusing to start in HTTP mode: BLACKLIST_API_KEY is set. The HTTP server never holds a " +
        "Label Cloud key - each consumer sends their own (Authorization: Bearer <key>). Unset BLACKLIST_API_KEY."
    );
  }

  const host = options.host ?? process.env.MCP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.MCP_PORT ?? 3000);
  const apiUrl = resolveApiUrl();
  const allowedHosts = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);
  const hostOk = hostHeaderValidation(allowedHosts);
  const originOk = originValidation(allowedHosts);

  const mcp = createMcpHandler((ctx) => createServer(makeApiRequest(ctx.authInfo?.token, apiUrl)), {
    responseMode: "json",
    onerror: (error) => console.error("[labelcloud-mcp-server] handler error:", error.message),
  });
  const handleNodeRequest = toNodeHandler(mcp);

  const httpServer = createNodeHttpServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (pathname !== "/mcp") {
      sendJson(res, 404, {}, { error: "Not found" });
      return;
    }
    if (!hostOk(req, res)) return;
    if (!originOk(req, res)) return;

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    const bodyResult = await readRequestBody(req);
    if (!bodyResult.ok) {
      res.writeHead(bodyResult.status).end();
      return;
    }

    let body: unknown;
    try {
      body = bodyResult.text ? JSON.parse(bodyResult.text) : undefined;
    } catch {
      sendJson(res, 400, {}, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const key = extractApiKey(req.headers);
    if (!key && requiresKey(body)) {
      sendJson(
        res,
        401,
        { "WWW-Authenticate": 'Bearer realm="labelcloud-mcp"' },
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32001,
            message: "Missing Label Cloud API key: send Authorization: Bearer <key>",
          },
        }
      );
      return;
    }

    if (key) {
      (req as IncomingMessage & { auth?: AuthInfo }).auth = {
        token: key,
        clientId: "labelcloud-consumer",
        scopes: [],
      };
    }

    await handleNodeRequest(req, res, body);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/mcp`;
  console.error(
    `[labelcloud-mcp-server] HTTP on ${url} -> upstream ${apiUrl}; allowed hosts: ${allowedHosts.join(", ")}`
  );

  return {
    url,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function main(): Promise<void> {
  dotenv.config();
  console.error(`[labelcloud-mcp-server] API base URL: ${resolveApiUrl()}`);
  if (process.argv.includes("--http")) {
    await startHttpServer();
    return;
  }
  startStdio();
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
