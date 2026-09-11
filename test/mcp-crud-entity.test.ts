import { describe, it } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devServerEnv } from "./helpers/dev-endpoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "index.js");

/**
 * Sleep for a specified number of milliseconds.
 * Used to handle API eventual consistency.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MCP Entity CRUD Operations with Address Association", () => {
  it("should create entity, associate address, and clean up via MCP", async () => {
    const timestamp = Date.now();
    const entityName = `MCP-CRUD-Test-Entity-${timestamp}`;
    // Use a different address than mcp-crud-address.test.ts to avoid test isolation issues
    const testAddress = "TVXuWEmTkhDzZMUprz3EfZA1WHNHULivmJ";
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

    let entityId: string | undefined;

    try {
      await client.connect(transport);

      // Step 1: Create entity via POST /v1/black-list/entities
      console.log("Step 1: Creating entity via create_entity...");
      const createEntityResult = await client.callTool({
        name: "create_entity",
        arguments: {
          name: entityName,
          isPublicInfo: false,
          type: "other",
        },
      });

      assert.ok(createEntityResult, "Create entity should return a result");

      assert.ok(!createEntityResult.isError, "Create entity should not return an error");

      const createEntityContent = createEntityResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(createEntityContent, "Create entity should have text content");
      console.log("Create entity result:", createEntityContent.text);

      const createEntityParsed = JSON.parse(createEntityContent.text) as { id: string };
      entityId = createEntityParsed.id;
      assert.ok(entityId, "Create entity should return an entityId");
      console.log(`Created entity with ID: ${entityId}`);

      // Step 2: Search entity via GET /v1/black-list/entities?name=...
      console.log("\nStep 2: Searching for entity via search_entities...");
      const searchEntityResult = await client.callTool({
        name: "search_entities",
        arguments: { name: entityName },
      });

      assert.ok(searchEntityResult, "Search entity should return a result");
      assert.ok(!searchEntityResult.isError, "Search entity should not return an error");

      const searchEntityContent = searchEntityResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(searchEntityContent, "Search entity should have text content");
      console.log("Search entity result:", searchEntityContent.text);

      const searchEntityParsed = JSON.parse(searchEntityContent.text) as {
        publicList: Array<{ id: string; name: string }>;
        privateList: Array<{ id: string; name: string }>;
      };
      const allEntities = [
        ...(searchEntityParsed.publicList || []),
        ...(searchEntityParsed.privateList || []),
      ];
      const foundEntity = allEntities.find((e) => e.id === entityId);
      assert.ok(foundEntity, "Search should find the created entity");
      assert.strictEqual(foundEntity.name, entityName, "Entity name should match");

      // Step 3: Create address with entityId via POST /v1/black-list/addresses
      console.log("\nStep 3: Creating address with entityId via create_address...");
      const createAddressResult = await client.callTool({
        name: "create_address",
        arguments: {
          address: testAddress,
          network: network,
          isPublicInfo: false,
          type: "other",
          entityId: entityId,
        },
      });

      assert.ok(createAddressResult, "Create address should return a result");
      assert.ok(!createAddressResult.isError, "Create address should not return an error");

      const createAddressContent = createAddressResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(createAddressContent, "Create address should have text content");
      console.log("Create address result:", createAddressContent.text);

      // Wait for API eventual consistency before verifying address association
      console.log("\nWaiting 1 second for API consistency...");
      await sleep(1000);

      // Step 4: Get entity addresses via GET /v1/black-list/addresses/entity/{entityId}
      console.log("\nStep 4: Getting entity addresses via get_entity_addresses...");
      const getEntityAddressesResult = await client.callTool({
        name: "get_entity_addresses",
        arguments: { entityId: entityId },
      });

      assert.ok(getEntityAddressesResult, "Get entity addresses should return a result");
      assert.ok(!getEntityAddressesResult.isError, "Get entity addresses should not return an error");

      const getEntityAddressesContent = getEntityAddressesResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(getEntityAddressesContent, "Get entity addresses should have text content");
      console.log("Get entity addresses result:", getEntityAddressesContent.text);

      const entityAddressesParsed = JSON.parse(getEntityAddressesContent.text) as {
        publicBlacklist: Array<{ address: string; network: string }>;
        privateBlacklist: Array<{ address: string; network: string }>;
      };
      const allEntityAddresses = [
        ...(entityAddressesParsed.publicBlacklist || []),
        ...(entityAddressesParsed.privateBlacklist || []),
      ];
      const associatedAddress = allEntityAddresses.find(
        (a) => a.address === testAddress && a.network === network
      );
      assert.ok(associatedAddress, "Address should be associated with entity");

      // Step 5: Delete address via DELETE /v1/black-list/addresses/{address}?network=...
      console.log("\nStep 5: Deleting address via delete_address...");
      const deleteAddressResult = await client.callTool({
        name: "delete_address",
        arguments: {
          address: testAddress,
          network: network,
        },
      });

      assert.ok(deleteAddressResult, "Delete address should return a result");
      assert.ok(!deleteAddressResult.isError, "Delete address should not return an error");

      const deleteAddressContent = deleteAddressResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(deleteAddressContent, "Delete address should have text content");
      console.log("Delete address result:", deleteAddressContent.text);

      // Step 6: Verify address removed from entity
      console.log("\nStep 6: Verifying address removed from entity via get_entity_addresses...");
      const verifyAddressRemovedResult = await client.callTool({
        name: "get_entity_addresses",
        arguments: { entityId: entityId },
      });

      assert.ok(verifyAddressRemovedResult, "Verify address removed should return a result");

      const verifyAddressRemovedContent = verifyAddressRemovedResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(verifyAddressRemovedContent, "Verify address removed should have text content");
      console.log("Verify address removed result:", verifyAddressRemovedContent.text);

      const verifyEntityAddressesParsed = JSON.parse(verifyAddressRemovedContent.text) as {
        publicBlacklist: Array<{ address: string; network: string }>;
        privateBlacklist: Array<{ address: string; network: string }>;
      };
      const verifyAllEntityAddresses = [
        ...(verifyEntityAddressesParsed.publicBlacklist || []),
        ...(verifyEntityAddressesParsed.privateBlacklist || []),
      ];
      const stillAssociated = verifyAllEntityAddresses.find(
        (a) => a.address === testAddress && a.network === network
      );
      assert.ok(!stillAssociated, "Address should no longer be associated with entity");

      // Step 7: Delete entity via DELETE /v1/black-list/entities/{entityId}
      console.log("\nStep 7: Deleting entity via delete_entity...");
      const deleteEntityResult = await client.callTool({
        name: "delete_entity",
        arguments: { entityId: entityId },
      });

      assert.ok(deleteEntityResult, "Delete entity should return a result");
      assert.ok(!deleteEntityResult.isError, "Delete entity should not return an error");

      const deleteEntityContent = deleteEntityResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(deleteEntityContent, "Delete entity should have text content");
      console.log("Delete entity result:", deleteEntityContent.text);

      // Step 8: Verify entity deleted via search_entities
      console.log("\nStep 8: Verifying entity deleted via search_entities...");
      const verifyEntityDeletedResult = await client.callTool({
        name: "search_entities",
        arguments: { name: entityName },
      });

      const verifyEntityDeletedContent = verifyEntityDeletedResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(verifyEntityDeletedContent, "Verify entity deleted should have text content");
      console.log("Verify entity deleted result:", verifyEntityDeletedContent.text);

      const verifyEntityParsed = JSON.parse(verifyEntityDeletedContent.text) as {
        publicList: Array<{ id: string }>;
        privateList: Array<{ id: string }>;
      };
      const verifyAllEntities = [
        ...(verifyEntityParsed.publicList || []),
        ...(verifyEntityParsed.privateList || []),
      ];
      const entityStillExists = verifyAllEntities.find((e) => e.id === entityId);
      assert.ok(!entityStillExists, "Entity should no longer exist in search results");

      console.log("\n✓ All 8 entity CRUD operations completed successfully!");
    } finally {
      await client.close();
    }
  });
});
