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
const { tools: TOOLS, operationMap } = generateToolsFromSpec(openApiSpec);

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
 * Generic tool handler that uses operation info from OpenAPI spec
 */
async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const opInfo = operationMap.get(toolName);
  if (!opInfo) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Build path with path parameters
  const pathParams: Record<string, string> = {};
  for (const paramName of opInfo.pathParams) {
    if (args[paramName] !== undefined) {
      pathParams[paramName] = String(args[paramName]);
    }
  }
  const path = buildPath(opInfo.path, pathParams);

  // Build query string
  const queryString = buildQueryString(args, opInfo.queryParams);

  // Build request body
  const body = buildRequestBody(args, opInfo.bodyParams);

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
