import type { MCPTool } from "./openapi-to-mcp.js";

/**
 * The 14 tools that only read Label Cloud state.
 */
const READ_ONLY = new Set([
  "search_addresses",
  "get_auto_tracer_data",
  "get_entity_addresses",
  "get_addresses_by_origin",
  "get_addresses_by_previous",
  "search_entities",
  "get_entity",
  "get_networks",
  "get_types",
  "get_incident",
  "get_incident_by_tag",
  "search_incidents",
  "get_incident_addresses",
  "get_address_incidents",
]);

/**
 * The 4 tools that permanently remove a row (or soft-delete one).
 */
const DESTRUCTIVE = new Set([
  "delete_address",
  "delete_entity",
  "remove_address_tag",
  "delete_incident",
]);

/**
 * The 6 tools that write but never destroy.
 */
const WRITE = new Set([
  "create_address",
  "create_entity",
  "set_auto_tracing",
  "add_address_tag",
  "create_incident",
  "update_incident",
]);

const EXPECTED_TOOL_COUNT = READ_ONLY.size + DESTRUCTIVE.size + WRITE.size;

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

export type AnnotatedTool = MCPTool & { annotations: McpToolAnnotations };

function annotationsFor(toolName: string): McpToolAnnotations {
  if (READ_ONLY.has(toolName)) {
    return { readOnlyHint: true, destructiveHint: false };
  }
  if (DESTRUCTIVE.has(toolName)) {
    return { readOnlyHint: false, destructiveHint: true };
  }
  if (WRITE.has(toolName)) {
    return { readOnlyHint: false, destructiveHint: false };
  }
  throw new Error(`withAnnotations: unclassified tool "${toolName}"`);
}

/**
 * Adds a readOnlyHint/destructiveHint pair to each tool for the AC-10 client
 * hint. Throws rather than silently under-annotating if a tool is missing
 * from all three lists above, or if the lists and the actual tool set don't
 * both land on exactly 24 - a renamed or added tool must update this file.
 */
export function withAnnotations(tools: MCPTool[]): AnnotatedTool[] {
  const annotated = tools.map((tool) => ({ ...tool, annotations: annotationsFor(tool.name) }));

  const uniqueNames = new Set(tools.map((tool) => tool.name));
  if (
    tools.length !== EXPECTED_TOOL_COUNT ||
    uniqueNames.size !== EXPECTED_TOOL_COUNT ||
    EXPECTED_TOOL_COUNT !== 24
  ) {
    throw new Error(
      `withAnnotations: expected exactly 24 uniquely-named tools classified across ` +
        `READ_ONLY/DESTRUCTIVE/WRITE, got ${tools.length} tools (${uniqueNames.size} unique) ` +
        `against ${EXPECTED_TOOL_COUNT} classified`
    );
  }

  return annotated;
}
