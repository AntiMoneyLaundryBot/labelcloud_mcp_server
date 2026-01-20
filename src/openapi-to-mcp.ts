/**
 * OpenAPI to MCP tool generator
 *
 * Parses an OpenAPI 3.0 spec and generates MCP tool definitions
 * based on the tool configuration.
 */

import { getIncludedToolConfigs, getToolConfigByOperationId } from "./tool-config.js";

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
 * Convert OpenAPI parameter to MCP property
 */
function parameterToProperty(param: OpenAPIParameter): {
  name: string;
  property: MCPToolInputSchema["properties"][string];
  required: boolean;
} {
  const property: MCPToolInputSchema["properties"][string] = {
    type: param.schema.type,
    description: getEnhancedDescription(param.name, param.description),
  };

  if (param.schema.enum) {
    property.enum = param.schema.enum;
  }

  if (param.schema.items) {
    property.items = param.schema.items;
  }

  return {
    name: param.name,
    property,
    required: param.required,
  };
}

/**
 * Build MCP input schema from OpenAPI operation
 */
function buildInputSchema(
  operation: OpenAPIOperation,
  spec: OpenAPISpec
): { schema: MCPToolInputSchema; operationInfo: OperationInfo; path: string; method: string } {
  const properties: MCPToolInputSchema["properties"] = {};
  const required: string[] = [];
  const pathParams: string[] = [];
  const queryParams: string[] = [];
  const bodyParams: string[] = [];

  // Process path and query parameters
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === "header") continue; // Skip header params (like API key)

      const { name, property, required: isRequired } = parameterToProperty(param);
      properties[name] = property;

      if (isRequired) {
        required.push(name);
      }

      if (param.in === "path") {
        pathParams.push(name);
      } else if (param.in === "query") {
        queryParams.push(name);
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
        properties[propName] = {
          type: propSchema.type,
          description: getEnhancedDescription(propName, propSchema.description),
        };

        if (propSchema.enum) {
          properties[propName].enum = propSchema.enum;
        }

        if (propSchema.items) {
          properties[propName].items = propSchema.items;
        }

        bodyParams.push(propName);
      }

      // Add required fields from body schema
      if (resolvedSchema.required) {
        for (const reqField of resolvedSchema.required) {
          if (!required.includes(reqField)) {
            required.push(reqField);
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

      const config = getToolConfigByOperationId(operation.operationId);
      if (!config || !config.include) continue;

      const { schema, operationInfo } = buildInputSchema(operation, spec);

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
