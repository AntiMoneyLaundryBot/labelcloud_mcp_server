/**
 * OpenAPI to MCP tool generator
 *
 * Parses an OpenAPI 3.0 spec and generates MCP tool definitions
 * based on the tool configuration.
 */

import {
  getIncludedToolConfigs,
  getIncludedToolConfigsByOperationId,
  type ToolConfig,
} from "./tool-config.js";

/**
 * Parameter description overrides to enhance OpenAPI descriptions for LLM clarity.
 * These provide explicit format hints and usage guidance that the OpenAPI spec lacks.
 */
const paramDescriptionOverrides: Record<string, string> = {
  entityId:
    "Entity UUID (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Get this from search_entities response 'id' field, not the entity name.",
  address:
    "Blockchain address hash (e.g., '0x1234...' for Ethereum, 'T...' for Tron). Not an entity name.",
};

// OpenAPI types (simplified for our use case)
interface OpenAPIParameter {
  name: string;
  required: boolean;
  in: "path" | "query" | "header";
  description?: string;
  schema: {
    type: string;
    enum?: string[];
    items?: { type: string; enum?: string[] };
  };
}

interface OpenAPIRequestBody {
  required: boolean;
  content: {
    "application/json": {
      schema: { $ref: string } | Record<string, unknown>;
    };
  };
}

interface OpenAPIOperation {
  operationId: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, unknown>;
  tags?: string[];
}

interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  delete?: OpenAPIOperation;
}

interface OpenAPISchema {
  type: string;
  properties?: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    items?: { type: string; enum?: string[] };
  }>;
  required?: string[];
}

interface OpenAPISpec {
  openapi: string;
  paths: Record<string, OpenAPIPathItem>;
  components: {
    schemas: Record<string, OpenAPISchema>;
  };
}

// MCP Tool types
export interface MCPToolInputSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    items?: { type: string; enum?: string[] };
  }>;
  required: string[];
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
}

// Internal type for tracking operation metadata
export interface OperationInfo {
  operationId: string;
  method: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  bodyParams: string[];
  /** Exposed input property name -> underlying OpenAPI param/body-property name. */
  argAliases?: Record<string, string>;
  /** Underlying names (from argAliases) that must be wrapped as a single-element array
   *  when the caller supplies a scalar value through the alias. */
  arrayAliasTargets?: string[];
  /** Fixed values merged into every call, hidden from the exposed schema. */
  presetArgs?: Record<string, unknown>;
}

/**
 * Resolve a $ref to its schema
 */
function resolveRef(ref: string, spec: OpenAPISpec): OpenAPISchema | undefined {
  // Format: "#/components/schemas/CreateAddressDto"
  const parts = ref.split("/");
  const schemaName = parts[parts.length - 1];
  return spec.components?.schemas?.[schemaName];
}

/**
 * Get enhanced description for a parameter, using override if available
 */
function getEnhancedDescription(
  paramName: string,
  originalDescription?: string
): string | undefined {
  const override = paramDescriptionOverrides[paramName];
  if (override) {
    return override;
  }
  return originalDescription;
}

/**
 * Convert OpenAPI parameter to MCP property. `exposedName`/`asSingleValue` let a
 * ToolConfig's argAliases rename a param and, for an array-typed param aliased to
 * a scalar (e.g. `blockchains` -> `network`), expose it as a single value.
 */
function parameterToProperty(
  param: OpenAPIParameter,
  exposedName: string,
  asSingleValue: boolean
): {
  name: string;
  property: MCPToolInputSchema["properties"][string];
  required: boolean;
} {
  const property: MCPToolInputSchema["properties"][string] = {
    type: asSingleValue ? "string" : param.schema.type,
    description: getEnhancedDescription(exposedName, param.description),
  };

  if (asSingleValue) {
    if (param.schema.items?.enum) {
      property.enum = param.schema.items.enum;
    }
  } else {
    if (param.schema.enum) {
      property.enum = param.schema.enum;
    }
    if (param.schema.items) {
      property.items = param.schema.items;
    }
  }

  return {
    name: exposedName,
    property,
    required: param.required,
  };
}

/**
 * Build MCP input schema from OpenAPI operation, applying one ToolConfig's
 * presetArgs (hidden, fixed values), argAliases (renamed/simplified exposed
 * properties) and omitArgs (hidden, caller can never set them).
 */
function buildInputSchema(
  operation: OpenAPIOperation,
  spec: OpenAPISpec,
  config: ToolConfig
): { schema: MCPToolInputSchema; operationInfo: OperationInfo; path: string; method: string } {
  const properties: MCPToolInputSchema["properties"] = {};
  const required: string[] = [];
  const pathParams: string[] = [];
  const queryParams: string[] = [];
  const bodyParams: string[] = [];
  const arrayAliasTargets: string[] = [];

  const argAliases = config.argAliases ?? {};
  const underlyingToExposed = new Map(
    Object.entries(argAliases).map(([exposed, underlying]) => [underlying, exposed])
  );
  const hiddenParams = new Set([
    ...(config.omitArgs ?? []),
    ...Object.keys(config.presetArgs ?? {}),
  ]);

  // Process path and query parameters
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === "header") continue; // Skip header params (like API key)

      const alias = underlyingToExposed.get(param.name);
      if (!alias && hiddenParams.has(param.name)) {
        // Hidden: either a fixed presetArgs value or explicitly omitted -
        // never shown to the caller.
      } else {
        const asSingleValue = Boolean(alias) && param.schema.type === "array";
        if (asSingleValue) {
          arrayAliasTargets.push(param.name);
        }
        const { name, property, required: isRequired } = parameterToProperty(
          param,
          alias ?? param.name,
          asSingleValue
        );
        properties[name] = property;
        if (isRequired) {
          required.push(name);
        }
      }

      if (param.in === "path") {
        pathParams.push(param.name);
      } else if (param.in === "query") {
        queryParams.push(param.name);
      }
    }
  }

  // Process request body
  if (operation.requestBody?.content?.["application/json"]?.schema) {
    const bodySchema = operation.requestBody.content["application/json"].schema;

    let resolvedSchema: OpenAPISchema | undefined;
    if ("$ref" in bodySchema && typeof bodySchema.$ref === "string") {
      resolvedSchema = resolveRef(bodySchema.$ref, spec);
    }

    if (resolvedSchema?.properties) {
      for (const [propName, propSchema] of Object.entries(resolvedSchema.properties)) {
        const alias = underlyingToExposed.get(propName);
        if (!alias && hiddenParams.has(propName)) {
          bodyParams.push(propName);
          continue;
        }

        const exposedName = alias ?? propName;
        properties[exposedName] = {
          type: propSchema.type,
          description: getEnhancedDescription(exposedName, propSchema.description),
        };

        if (propSchema.enum) {
          properties[exposedName].enum = propSchema.enum;
        }

        if (propSchema.items) {
          properties[exposedName].items = propSchema.items;
        }

        bodyParams.push(propName);
      }

      // Add required fields from body schema
      if (resolvedSchema.required) {
        for (const reqField of resolvedSchema.required) {
          const exposedField = underlyingToExposed.get(reqField) ?? reqField;
          if (!hiddenParams.has(reqField) && !required.includes(exposedField)) {
            required.push(exposedField);
          }
        }
      }
    }
  }

  return {
    schema: {
      type: "object" as const,
      properties,
      required,
    },
    operationInfo: {
      operationId: operation.operationId,
      method: "",
      path: "",
      pathParams,
      queryParams,
      bodyParams,
      ...(Object.keys(argAliases).length > 0 ? { argAliases } : {}),
      ...(arrayAliasTargets.length > 0 ? { arrayAliasTargets } : {}),
      ...(config.presetArgs ? { presetArgs: config.presetArgs } : {}),
    },
    path: "",
    method: "",
  };
}

/**
 * Generate MCP tools from OpenAPI spec
 */
export function generateToolsFromSpec(spec: OpenAPISpec): {
  tools: MCPTool[];
  operationMap: Map<string, OperationInfo>;
} {
  const tools: MCPTool[] = [];
  const operationMap = new Map<string, OperationInfo>();
  const includedConfigs = getIncludedToolConfigs();

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const methods: Array<{ method: string; operation: OpenAPIOperation | undefined }> = [
      { method: "get", operation: pathItem.get },
      { method: "post", operation: pathItem.post },
      { method: "put", operation: pathItem.put },
      { method: "delete", operation: pathItem.delete },
    ];

    for (const { method, operation } of methods) {
      if (!operation) continue;

      const configs = getIncludedToolConfigsByOperationId(operation.operationId);

      for (const config of configs) {
        const { schema, operationInfo } = buildInputSchema(operation, spec, config);

        // Update operation info with path and method
        operationInfo.method = method.toUpperCase();
        operationInfo.path = path;

        const tool: MCPTool = {
          name: config.name,
          description: config.description,
          inputSchema: schema,
        };

        tools.push(tool);
        operationMap.set(config.name, operationInfo);
      }
    }
  }

  // Sort tools by the order in config
  const configOrder = new Map(includedConfigs.map((c, i) => [c.name, i]));
  tools.sort((a, b) => (configOrder.get(a.name) ?? 999) - (configOrder.get(b.name) ?? 999));

  return { tools, operationMap };
}

/**
 * Build URL path with path parameters substituted
 */
export function buildPath(
  template: string,
  pathParams: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(pathParams)) {
    result = result.replace(`{${key}}`, encodeURIComponent(value));
  }
  return result;
}

/**
 * Build query string from parameters
 */
export function buildQueryString(
  params: Record<string, unknown>,
  queryParamNames: string[]
): string {
  const searchParams = new URLSearchParams();

  for (const name of queryParamNames) {
    const value = params[name];
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(name, String(item));
      }
    } else {
      searchParams.set(name, String(value));
    }
  }

  return searchParams.toString();
}

/**
 * Build request body from parameters
 */
export function buildRequestBody(
  params: Record<string, unknown>,
  bodyParamNames: string[]
): Record<string, unknown> | undefined {
  if (bodyParamNames.length === 0) return undefined;

  const body: Record<string, unknown> = {};
  for (const name of bodyParamNames) {
    if (params[name] !== undefined) {
      body[name] = params[name];
    }
  }

  return Object.keys(body).length > 0 ? body : undefined;
}
