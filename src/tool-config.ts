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
  /**
   * Fixed query/body param values merged into every call of this tool, hidden
   * from the exposed input schema (the caller cannot see or override them).
   * Keyed by the underlying OpenAPI parameter/body-property name.
   */
  presetArgs?: Record<string, unknown>;
  /**
   * Exposed input property name -> underlying OpenAPI parameter/body-property
   * name. Lets several tools share one operationId while presenting a
   * simplified, renamed input schema (e.g. a singular `network` exposed over
   * an underlying `blockchains` array param).
   */
  argAliases?: Record<string, string>;
  /**
   * Underlying OpenAPI parameter/body-property names to exclude entirely from
   * the exposed input schema (not settable by the caller, and not preset).
   */
  omitArgs?: string[];
}

/** Binding naming note (spec `SPEC-2026-09-18-labelcloud-mcp-auto-tracing-tools`):
 * the feature is LabelSniffer = auto-tracer = auto-label-propagation. Every
 * tool description touching it must contain all three strings verbatim. */
const LABEL_SNIFFER_NAMING =
  "LabelSniffer (a.k.a. auto-tracer, a.k.a. auto-label-propagation)";

export const toolConfigs: ToolConfig[] = [
  // === Address Blacklist Operations ===
  {
    operationId: "ApiAddressBlacklistController_create",
    name: "create_address",
    description:
      "Add a blockchain address (e.g., '0x...' for Ethereum, 'T...' for Tron) to the Label Cloud, or upsert an existing one. Optional entityId must be a UUID from search_entities, not an entity name. " +
      "THIS IS A FULL UPSERT: every call replaces the whole record. To flip ONLY the enableSniffer flag (" +
      LABEL_SNIFFER_NAMING +
      ") on an address that already exists, use set_auto_tracing instead - it reads the record back and preserves every other field for you. To change any other single field on an existing address, you MUST first call search_addresses on it with fields including entityId, description, type, subType, reference, enableSniffer, originAddress, previousAddress, txHash, txBlockchain, txTimestamp, then resend this call with every one of those values carried over unchanged plus only your intended change. " +
      "Never omit entityId on an existing address that has one: an omitted/absent entityId is written as a literal null, which detaches the address from its entity and forces the address to become publicly visible in the public blacklist. `type` is required and effectively controls severity on the fast path - never guess it; always use the exact value read back from search_addresses, not a paraphrase.",
    include: true,
  },
  {
    // Not a real OpenAPI operation - this composite is hand-written in
    // src/set-auto-tracing.ts (see index.ts's dispatch on toolName). The
    // operationId here never matches a path in docs/blacklist-api-endpoints.json,
    // so generateToolsFromSpec's spec-driven loop never picks it up; this entry
    // only supplies its name/description as the single source of truth.
    operationId: "Composite_setAutoTracing",
    name: "set_auto_tracing",
    description:
      "Enable or disable " +
      LABEL_SNIFFER_NAMING +
      " on ONE existing blockchain address by flipping its enableSniffer flag, without a full-record upsert. Reads the address back first (every writable field, ACTIVE status only) and refuses if it does not exist or is DELETED - this tool never creates a row and never reactivates a DELETED one. Writes back the exact same record with only enableSniffer changed: entityId, type, subType, description, reference and isPublicInfo are preserved verbatim, and the provenance fields (originAddress, previousAddress, txHash, txBlockchain, txTimestamp) are left completely untouched. Returns {before, after} snapshots of the address. Use this instead of create_address to flip the flag.",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_search",
    name: "search_addresses",
    description:
      "Search for a specific blockchain address by its hash (e.g., '0x...' or 'T...'). Cannot search by entity name - use search_entities for that. " +
      "Pass fields (e.g. enableSniffer, originAddress, previousAddress, txHash, txBlockchain, txTimestamp, publicInfo, organization, entityId, description, type, subType, reference) to read back the full record - required before using create_address to upsert any other field on an existing address, since that call is a full-record write. " +
      "To read just the " +
      LABEL_SNIFFER_NAMING +
      " flag and its provenance, use get_auto_tracer_data instead. To flip the flag alone, use set_auto_tracing instead. " +
      "The response always carries a top-level `tags` array of `{network, tag}` beside publicBlacklist/privateBlacklist. It covers all networks, or only the `blockchains` you pass. It is empty when the address has no tags or is not visible to your key. It is returned whatever `fields` you pass, and also for an address that has tags but no labels (empty lists plus tags). " +
      "Tag lookup is case-sensitive on the address: send the address in the exact letter case you tagged it with, and pass only non-EVM networks in `blockchains` (any EVM network there makes the lookup lowercase the address). " +
      "Add or remove tags with add_address_tag / remove_address_tag.",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_search",
    name: "get_auto_tracer_data",
    description:
      "Read " +
      LABEL_SNIFFER_NAMING +
      " data for one address: the enableSniffer flag plus its five provenance fields (originAddress, previousAddress, txHash, txBlockchain, txTimestamp) - without naming any `fields` yourself. Input is just address and an optional network. Its response also carries the address's top-level `tags` array, as search_addresses returns it, limited to `network` when you pass one. Use search_addresses instead if you need other fields such as description, type, subType, reference or entityId.",
    include: true,
    presetArgs: {
      fields: [
        "enableSniffer",
        "originAddress",
        "previousAddress",
        "txHash",
        "txBlockchain",
        "txTimestamp",
      ],
      statuses: ["ACTIVE"],
    },
    argAliases: {
      network: "blockchains",
    },
    omitArgs: ["fields", "entityId"],
  },
  {
    operationId: "ApiAddressBlacklistController_destroy",
    name: "delete_address",
    description: "Remove an address from the AMLBot Label Cloud",
    include: true,
  },
  {
    operationId: "TagsController_add",
    name: "add_address_tag",
    description:
      "Add ONE tag to a blockchain address on one network in the Label Cloud (e.g. `geo.uk.london`, `deposit.binance`). A tag is an extra fact about the address, separate from its label type, and an address can carry many.\n\n" +
      "**Tag format:** the tag must match `^[a-z0-9_]+(\\.[a-z0-9_]+)*$` and be 1-128 characters long: lowercase letters, digits and underscores, with dots separating namespaces (`<namespace>.<value>[.<value>…]`). Anything else, including uppercase or spaces, is rejected with API error 400 and is never converted, so send the tag already lowercase. The one exception is a `.` or `..` piece (e.g. `..` or `a/..`), which is rejected locally with `Invalid path parameter` before any request is sent.\n\n" +
      "**No edit:** to change a tag, remove the old one with remove_address_tag, then add the new one. Adding a tag the address already has changes nothing and returns `added:false`.\n\n" +
      "**Network:** `network` is required. EVM addresses are stored lowercased under network `evm_eoa`, so all EVM chains share one tag set. The response echoes the stored address and network.\n\n" +
      "**Privacy:** tags follow the address's privacy. You can tag an address only if its labels are visible to your key, or if it has no labels at all. Otherwise you get API error 404.\n\n" +
      "**Labels are separate:** tags never change the address's label, and create_address and set_auto_tracing never read, send or clear tags. Read tags back with search_addresses, in its top-level `tags` array.",
    include: true,
  },
  {
    operationId: "TagsController_remove",
    name: "remove_address_tag",
    description:
      "PERMANENTLY remove ONE tag from a blockchain address on one network. This is a hard delete: the tag disappears from every read, and only the audit log keeps a record. There is no undo other than adding it again with add_address_tag. There is also no edit: to change a tag, remove the old one and add the new one.\n\n" +
      "The address, network and tag rules are the same as add_address_tag: the tag must match `^[a-z0-9_]+(\\.[a-z0-9_]+)*$`, be 1-128 characters and be lowercase; EVM addresses are matched lowercased under `evm_eoa`.\n\n" +
      "**On success** the tool returns `null`.\n\n" +
      "**API error 404** means one of two things, deliberately indistinguishable because tags follow the address's privacy: the tag is not on the address, or the address is not visible to your key.\n\n" +
      "**Labels are untouched:** this never removes or changes the address's label. Use delete_address for that.",
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
      "Every address a red label propagated to from an origin address, as a complete edge list - every row where originAddress matches, ordered txTimestamp ASC then address ASC. Each edge carries address, previousAddress, txHash, txBlockchain, txTimestamp. Org-blind: returns edges across all organizations, not just the caller's own. limit defaults to 10000 (max 10000), offset defaults to 0; offset is applied after an exhaustive, service-side sort of the whole partition, so cost scales with partition size, not with offset. Part of " +
      LABEL_SNIFFER_NAMING +
      ".",
    include: true,
  },
  {
    operationId: "ApiAddressBlacklistController_findByPrevious",
    name: "get_addresses_by_previous",
    description:
      "The direct children of one address in a propagation tree (branch isolation) - only the edges whose previousAddress matches, not the whole subtree beneath it. Same five-field edge shape, ordering, limit/offset defaults, and org-blind scope as get_addresses_by_origin. Part of " +
      LABEL_SNIFFER_NAMING +
      ".",
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
 * Get every included tool config for an operationId. Several tools can share
 * one operationId (e.g. search_addresses and get_auto_tracer_data both drive
 * `GET /addresses`), each with its own name/description/presetArgs.
 */
export function getIncludedToolConfigsByOperationId(operationId: string): ToolConfig[] {
  return toolConfigs.filter(
    (config) => config.operationId === operationId && config.include
  );
}

/**
 * Get tool config by tool name
 */
export function getToolConfigByName(name: string): ToolConfig | undefined {
  return toolConfigs.find((config) => config.name === name);
}
