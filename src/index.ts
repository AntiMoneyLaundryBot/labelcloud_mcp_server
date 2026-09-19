#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { createRequire } from "module";
import {
  generateToolsFromSpec,
  buildPath,
  buildQueryString,
  buildRequestBody,
  type OperationInfo,
  type MCPTool,
} from "./openapi-to-mcp.js";
import { setAutoTracing, type SetAutoTracingArgs } from "./set-auto-tracing.js";
import { getToolConfigByName } from "./tool-config.js";

dotenv.config();

const API_KEY = process.env.BLACKLIST_API_KEY;
const API_URL = process.env.BLACKLIST_API_URL || "https://api-blacklist.amlbot.com";

console.error(`[labelcloud-mcp-server] API base URL: ${API_URL}`);

if (!API_KEY) {
  console.error("Error: BLACKLIST_API_KEY environment variable is required");
  process.exit(1);
}

// Load OpenAPI spec
const require = createRequire(import.meta.url);
const openApiSpec = require("../docs/blacklist-api-endpoints.json");

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

// API Client
async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${API_URL}${path}`;
  if (method.toUpperCase() !== "GET") {
    console.error(`[labelcloud-mcp-server] write: ${method.toUpperCase()} ${url}`);
  }
  const headers: Record<string, string> = {
    "X-Api-Key": API_KEY!,
    "Content-Type": "application/json",
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

  const resolvedArgs = resolveOperationArgs(opInfo, args);

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

// Create server
const server = new Server(
  {
    name: "labelcloud-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, (args as Record<string, unknown>) || {});

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

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AMLBot Blacklist MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
