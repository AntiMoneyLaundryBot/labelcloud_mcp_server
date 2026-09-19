import { describe, it } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devServerEnv } from "./helpers/dev-endpoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "index.js");

describe("MCP Tool Discovery", () => {
  it("should list all available tools via listTools()", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: devServerEnv(),
    });

    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);

      console.log("Discovering available tools via listTools()...");
      const result = await client.listTools();

      assert.ok(result, "listTools should return a result");
      assert.ok(result.tools, "Result should have tools array");
      assert.ok(Array.isArray(result.tools), "Tools should be an array");
      assert.ok(result.tools.length > 0, "Tools should not be empty");

      // Expected tools based on src/index.ts
      const expectedTools = [
        "create_address",
        "search_addresses",
        "delete_address",
        "get_entity_addresses",
        "create_entity",
        "search_entities",
        "get_entity",
        "delete_entity",
        "get_networks",
        "get_types",
        "set_auto_tracing",
        "get_auto_tracer_data",
        "get_addresses_by_origin",
        "get_addresses_by_previous",
      ];

      const toolNames = result.tools.map((t) => t.name);
      console.log(`Found ${toolNames.length} tools: ${toolNames.join(", ")}`);

      for (const expectedTool of expectedTools) {
        assert.ok(
          toolNames.includes(expectedTool),
          `Tools should include '${expectedTool}'`
        );
      }

      // Verify tool structure
      for (const tool of result.tools) {
        assert.ok(tool.name, "Tool should have a name");
        assert.ok(tool.description, "Tool should have a description");
        assert.ok(tool.inputSchema, "Tool should have an inputSchema");
        assert.strictEqual(
          tool.inputSchema.type,
          "object",
          "Input schema should be an object type"
        );
      }

      console.log("\nTool details:");
      for (const tool of result.tools) {
        const required = tool.inputSchema.required || [];
        console.log(`  - ${tool.name}: ${tool.description}`);
        if (required.length > 0) {
          console.log(`    Required params: ${required.join(", ")}`);
        }
      }

      console.log(`\n✓ Discovered ${result.tools.length} tools`);
    } finally {
      await client.close();
    }
  });
});

describe("LabelSniffer / auto-tracer tool metadata (A3 criterion 1)", () => {
  it("set_auto_tracing and get_auto_tracer_data are present with the binding naming triple, and get_auto_tracer_data exposes no `fields`", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: devServerEnv(),
    });

    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);

      const result = await client.listTools();
      const toolsByName = new Map(result.tools.map((t) => [t.name, t]));

      const namingStrings = ["LabelSniffer", "auto-tracer", "auto-label-propagation"];
      const toolsRequiringNaming = [
        "set_auto_tracing",
        "get_auto_tracer_data",
        "get_addresses_by_origin",
        "get_addresses_by_previous",
      ];

      for (const toolName of toolsRequiringNaming) {
        const tool = toolsByName.get(toolName);
        assert.ok(tool, `Tool '${toolName}' should be present`);
        for (const naming of namingStrings) {
          assert.ok(
            tool!.description.includes(naming),
            `${toolName}'s description should contain '${naming}' verbatim`
          );
        }
      }

      const setAutoTracing = toolsByName.get("set_auto_tracing")!;
      assert.deepStrictEqual(
        new Set(Object.keys(setAutoTracing.inputSchema.properties)),
        new Set(["address", "network", "enableSniffer"]),
        "set_auto_tracing's input schema should be exactly {address, network, enableSniffer}"
      );
      assert.deepStrictEqual(
        new Set(setAutoTracing.inputSchema.required || []),
        new Set(["address", "network", "enableSniffer"]),
        "set_auto_tracing should require all three of its inputs"
      );

      const getAutoTracerData = toolsByName.get("get_auto_tracer_data")!;
      assert.deepStrictEqual(
        new Set(Object.keys(getAutoTracerData.inputSchema.properties)),
        new Set(["address", "network"]),
        "get_auto_tracer_data's input schema should be exactly {address, network?}"
      );
      assert.ok(
        !("fields" in getAutoTracerData.inputSchema.properties),
        "get_auto_tracer_data must not expose a 'fields' property"
      );
      assert.deepStrictEqual(
        getAutoTracerData.inputSchema.required || [],
        ["address"],
        "get_auto_tracer_data should only require address, network is optional"
      );

      // create_address / search_addresses must no longer steer agents to the
      // full upsert as the only way to flip the flag.
      const createAddress = toolsByName.get("create_address")!;
      const searchAddresses = toolsByName.get("search_addresses")!;
      assert.ok(
        !createAddress.description.includes("no PATCH"),
        "create_address should no longer say 'no PATCH route'"
      );
      assert.ok(
        !searchAddresses.description.includes("no PATCH"),
        "search_addresses should no longer say 'no PATCH equivalent'"
      );
      assert.ok(
        createAddress.description.includes("set_auto_tracing"),
        "create_address should point flag flips at set_auto_tracing"
      );
      assert.ok(
        searchAddresses.description.includes("set_auto_tracing") ||
          searchAddresses.description.includes("get_auto_tracer_data"),
        "search_addresses should point at the new auto-tracing tools"
      );
    } finally {
      await client.close();
    }
  });
});

describe("MCP Metadata Operations", () => {
  it("should get available networks via get_networks", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: devServerEnv(),
    });

    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);

      console.log("Getting available networks via get_networks...");
      const result = await client.callTool({
        name: "get_networks",
        arguments: {},
      });

      assert.ok(result, "get_networks should return a result");
      assert.ok(!result.isError, "get_networks should not return an error");

      const content = result.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(content, "get_networks should have text content");
      console.log("Networks result:", content.text);

      const parsed = JSON.parse(content.text) as { networks: string[] };
      assert.ok(parsed.networks, "Response should have networks property");
      assert.ok(Array.isArray(parsed.networks), "Networks should be an array");
      assert.ok(parsed.networks.length > 0, "Networks should not be empty");

      // Verify some common networks are present
      const commonNetworks = ["ethereum", "bitcoin", "tron"];
      for (const network of commonNetworks) {
        assert.ok(
          parsed.networks.includes(network),
          `Networks should include '${network}'`
        );
      }

      console.log(`✓ Found ${parsed.networks.length} networks`);
    } finally {
      await client.close();
    }
  });

  it("should get available types via get_types", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: devServerEnv(),
    });

    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);

      console.log("Getting available types via get_types...");
      const result = await client.callTool({
        name: "get_types",
        arguments: {},
      });

      assert.ok(result, "get_types should return a result");
      assert.ok(!result.isError, "get_types should not return an error");

      const content = result.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(content, "get_types should have text content");
      console.log("Types result:", content.text);

      interface TypeInfo {
        category_type: string;
        description: string;
        code: string;
        severity: number;
      }

      const parsed = JSON.parse(content.text) as { types: TypeInfo[] };
      assert.ok(parsed.types, "Response should have types property");
      assert.ok(Array.isArray(parsed.types), "Types should be an array");
      assert.ok(parsed.types.length > 0, "Types should not be empty");

      // Verify the "other" type is present (used in entity/address creation)
      const otherType = parsed.types.find((t) => t.category_type === "other");
      assert.ok(otherType, "Types should include 'other' category");

      // Verify type structure
      const firstType = parsed.types[0];
      assert.ok(firstType.category_type, "Type should have category_type");
      assert.ok(firstType.description, "Type should have description");
      assert.ok(firstType.code, "Type should have code");
      assert.ok(typeof firstType.severity === "number", "Type should have numeric severity");

      console.log(`✓ Found ${parsed.types.length} types`);
    } finally {
      await client.close();
    }
  });
});
