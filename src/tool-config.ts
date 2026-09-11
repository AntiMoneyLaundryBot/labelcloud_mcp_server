/**
 * Tool configuration mapping OpenAPI operationIds to MCP tool definitions.
 *
 * Only operations with `include: true` will be exposed as MCP tools.
 * Tool names and descriptions can be customized here.
 */

export interface ToolConfig {
  operationId: string;
  name: string;
  description: string;
  include: boolean;
}

export const toolConfigs: ToolConfig[] = [
  // === Address Blacklist Operations ===
  {
    operationId: "ApiAddressBlacklistController_create",
    name: "create_address",
    description:
      "Add a blockchain address (e.g., '0x...' for Ethereum, 'T...' for Tron) to the Label Cloud, or upsert an existing one. Optional entityId must be a UUID from search_entities, not an entity name. " +
      "THIS IS A FULL UPSERT, NOT A PATCH - there is no PATCH route. To change ONE field (e.g. flip enableSniffer) on an address that already exists, you MUST first call search_addresses on it with fields including entityId, description, type, subType, reference, enableSniffer, originAddress, previousAddress, txHash, txBlockchain, txTimestamp, then resend this call with every one of those values carried over unchanged plus only your intended change. " +
      "Never omit entityId on an existing address that has one: an omitted/absent entityId is written as a literal null, which detaches the address from its entity and forces the address to become publicly visible in the public blacklist. `type` is required and effectively controls severity on the fast path - never guess it; always use the exact value read back from search_addresses, not a paraphrase.",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_search",
    name: "search_addresses",
    description:
      "Search for a specific blockchain address by its hash (e.g., '0x...' or 'T...'). Cannot search by entity name - use search_entities for that. " +
      "Pass fields (e.g. enableSniffer, originAddress, previousAddress, txHash, txBlockchain, txTimestamp, publicInfo, organization, entityId, description, type, subType, reference) to read back the full record - required before using create_address to upsert/flip a flag on an existing address, since that call is a full-record write with no PATCH equivalent.",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_destroy",
    name: "delete_address",
    description: "Remove an address from the AMLBot Label Cloud",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_searchByEntity",
    name: "get_entity_addresses",
    description:
      "Get all blockchain addresses associated with an entity. Requires entityId (UUID from search_entities), not the entity name.",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_paginateByEntity",
    name: "paginate_entity_addresses",
    description: "Get paginated addresses associated with an entity",
    include: false, // Not currently exposed
  },
  {
    operationId: "ApiAddressBlacklistController_findByOrigin",
    name: "get_addresses_by_origin",
    description:
      "Every address a red label propagated to from an origin address, as a complete edge list - every row where originAddress matches, ordered txTimestamp ASC then address ASC. Each edge carries address, previousAddress, txHash, txBlockchain, txTimestamp. Org-blind: returns edges across all organizations, not just the caller's own. limit defaults to 10000 (max 10000), offset defaults to 0; offset is applied after an exhaustive, service-side sort of the whole partition, so cost scales with partition size, not with offset.",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_findByPrevious",
    name: "get_addresses_by_previous",
    description:
      "The direct children of one address in a propagation tree (branch isolation) - only the edges whose previousAddress matches, not the whole subtree beneath it. Same five-field edge shape, ordering, limit/offset defaults, and org-blind scope as get_addresses_by_origin.",
    include: true,
  },

  // === Entity Operations ===
  {
    operationId: "ApiEntityController_create",
    name: "create_entity",
    description:
      "Create a new entity in the AMLBot Label Cloud. Returns the created entity including its 'id' (UUID) for use in other operations.",
    include: true,
  },
  {
    operationId: "ApiEntityController_search",
    name: "search_entities",
    description:
      "Search for entities by name. Returns entity details including the 'id' field (UUID) needed for other entity operations like get_entity_addresses.",
    include: true,
  },
  {
    operationId: "ApiEntityController_show",
    name: "get_entity",
    description:
      "Get entity details by UUID. Use search_entities first to find the entityId if you only have the name.",
    include: true,
  },
  {
    operationId: "ApiEntityController_destroy",
    name: "delete_entity",
    description:
      "Delete an entity by UUID. Use search_entities first to find the entityId if you only have the name.",
    include: true,
  },

  // === Common/Metadata Operations ===
  {
    operationId: "ApiCommonController_getNetworks",
    name: "get_networks",
    description: "Get list of supported blockchain networks",
    include: true,
  },
  {
    operationId: "ApiCommonController_getTypes",
    name: "get_types",
    description: "Get list of available address types",
    include: true,
  },

  // === Account Management (Admin) - EXCLUDED ===
  {
    operationId: "ApiAccountController_create",
    name: "create_account",
    description: "Create a new API account",
    include: false, // Admin operation
  },
  {
    operationId: "ApiAccountController_destroy",
    name: "delete_account",
    description: "Delete an API account",
    include: false, // Admin operation
  },
  {
    operationId: "ApiAccountController_show",
    name: "get_account",
    description: "Get API account details",
    include: false, // Admin operation
  },
  {
    operationId: "ApiAccountController_roles",
    name: "get_account_roles",
    description: "Get available account roles",
    include: false, // Admin operation
  },

  // === File Operations - EXCLUDED ===
  {
    operationId: "ApiAddressFileController_upload",
    name: "upload_address_file",
    description: "Upload a file for an address",
    include: false, // File upload not supported via MCP
  },
  {
    operationId: "ApiAddressFileController_list",
    name: "list_address_files",
    description: "List files for an address",
    include: false, // Not currently exposed
  },
  {
    operationId: "ApiAddressFileController_restore",
    name: "restore_address_file",
    description: "Restore a deleted file for an address",
    include: false, // Not currently exposed
  },
  {
    operationId: "ApiAddressFileController_destroy",
    name: "delete_address_file",
    description: "Delete a file for an address",
    include: false, // Not currently exposed
  },

  // === Legacy API - EXCLUDED ===
  {
    operationId: "ApiAddressController_search",
    name: "legacy_search_address",
    description: "Legacy address search endpoint",
    include: false, // Legacy endpoint
  },
];

/**
 * Get only the tools that should be included
 */
export function getIncludedToolConfigs(): ToolConfig[] {
  return toolConfigs.filter((config) => config.include);
}

/**
 * Get tool config by operationId
 */
export function getToolConfigByOperationId(operationId: string): ToolConfig | undefined {
  return toolConfigs.find((config) => config.operationId === operationId);
}

/**
 * Get tool config by tool name
 */
export function getToolConfigByName(name: string): ToolConfig | undefined {
  return toolConfigs.find((config) => config.name === name);
}
