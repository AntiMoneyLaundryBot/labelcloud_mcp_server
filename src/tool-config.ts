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
    description: "Add a blockchain address to the AMLBot Label Cloud",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_search",
    name: "search_addresses",
    description: "Search for addresses in the AMLBot Label Cloud",
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
    description: "Get all addresses associated with an entity",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_paginateByEntity",
    name: "paginate_entity_addresses",
    description: "Get paginated addresses associated with an entity",
    include: false, // Not currently exposed
  },

  // === Entity Operations ===
  {
    operationId: "ApiEntityController_create",
    name: "create_entity",
    description: "Create a new entity in the AMLBot Label Cloud",
    include: true,
  },
  {
    operationId: "ApiEntityController_search",
    name: "search_entities",
    description: "Search for entities in the AMLBot Label Cloud",
    include: true,
  },
  {
    operationId: "ApiEntityController_show",
    name: "get_entity",
    description: "Get an entity by its ID",
    include: true,
  },
  {
    operationId: "ApiEntityController_destroy",
    name: "delete_entity",
    description: "Delete an entity from the AMLBot Label Cloud",
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
