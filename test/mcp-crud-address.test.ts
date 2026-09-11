import { describe, it } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devServerEnv } from "./helpers/dev-endpoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "index.js");

describe("MCP Address CRUD Operations", () => {
  it("should insert, verify, and delete address TUzMcqv8a2pKy9tpyjEk27MELRujuS9BrY via MCP", async () => {
    const testAddress = "TUzMcqv8a2pKy9tpyjEk27MELRujuS9BrY";
    const network = "tron";

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

      // Step 1: Create address in blacklist via POST /v1/black-list/addresses
      console.log("Step 1: Creating address in blacklist via POST /v1/black-list/addresses...");
      const createResult = await client.callTool({
        name: "create_address",
        arguments: {
          address: testAddress,
          network: network,
          isPublicInfo: false,
          description: "Test address for MCP CRUD test",
          type: "other",
        },
      });

      assert.ok(createResult, "Create should return a result");
      assert.ok(!createResult.isError, "Create should not return an error");

      const createContent = createResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(createContent, "Create should have text content");
      console.log("Create result:", createContent.text);

      // Step 2: Verify address exists via GET /v1/black-list/addresses?address=...
      console.log("\nStep 2: Verifying address exists via GET /v1/black-list/addresses?address=...");
      const searchResult = await client.callTool({
        name: "search_addresses",
        arguments: { address: testAddress },
      });

      assert.ok(searchResult, "Search should return a result");
      assert.ok(!searchResult.isError, "Search should not return an error");

      const searchContent = searchResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(searchContent, "Search should have text content");

      const searchParsed = JSON.parse(searchContent.text) as {
        publicBlacklist: Array<{ address: string; network: string }>;
        privateBlacklist: Array<{ address: string; network: string }>;
      };
      assert.ok(searchParsed.publicBlacklist || searchParsed.privateBlacklist, "Search result should have blacklist arrays");

      const allAddresses = [...(searchParsed.publicBlacklist || []), ...(searchParsed.privateBlacklist || [])];
      assert.ok(allAddresses.length > 0, "Search result should contain at least one address");

      const foundAddress = allAddresses.find(r => r.address === testAddress);
      assert.ok(foundAddress, "Search should find the created address");
      assert.strictEqual(foundAddress.network, network, "Address should be on correct network");
      console.log("Search result:", JSON.stringify(searchParsed, null, 2));

      // Step 3: Delete address via DELETE /v1/black-list/addresses/{address}?network=...
      console.log("\nStep 3: Deleting address via DELETE /v1/black-list/addresses/{address}?network=...");
      const deleteResult = await client.callTool({
        name: "delete_address",
        arguments: {
          address: testAddress,
          network: network,
        },
      });

      assert.ok(deleteResult, "Delete should return a result");
      assert.ok(!deleteResult.isError, "Delete should not return an error");

      const deleteContent = deleteResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(deleteContent, "Delete should have text content");
      console.log("Delete result:", deleteContent.text);

      // Step 4: Verify address no longer exists (or has DELETED status)
      console.log("\nStep 4: Verifying address no longer exists...");
      const verifyResult = await client.callTool({
        name: "search_addresses",
        arguments: { address: testAddress },
      });

      const verifyContent = verifyResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(verifyContent, "Verify search should have text content");
      console.log("Verify result:", verifyContent.text);

      // Address should either be empty or not found
      const verifyParsed = JSON.parse(verifyContent.text) as {
        publicBlacklist: Array<{ address: string }>;
        privateBlacklist: Array<{ address: string }>;
      };
      const verifyAll = [...(verifyParsed.publicBlacklist || []), ...(verifyParsed.privateBlacklist || [])];
      const stillExists = verifyAll.some(r => r.address === testAddress);

      assert.ok(!stillExists || verifyResult.isError,
        "Address should no longer be active in blacklist");

      console.log("\n✓ All CRUD operations completed successfully!");
    } finally {
      await client.close();
    }
  });
});
