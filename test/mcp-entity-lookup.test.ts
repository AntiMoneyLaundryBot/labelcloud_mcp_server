import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startDevServer, devTransport, type DevServerHandle } from "./helpers/dev-endpoint.js";

let server: DevServerHandle;

before(async () => {
  server = await startDevServer();
});

after(async () => {
  await server.close();
});

describe("MCP Entity Lookup and Address Discovery", () => {
  it("should find entity by name and retrieve its addresses via MCP", async () => {
    const timestamp = Date.now();
    const entityName = `MCP-Lookup-Test-Entity-${timestamp}`;
    const testAddress1 = "TN2x7rKhBHLPGWRWfjWKPHcaC5t8RXgA2i";
    const testAddress2 = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
    const network = "tron";

    const transport = devTransport(server.url);

    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    let entityId: string | undefined;

    try {
      await client.connect(transport);

      // Step 1: Create an entity with a unique name
      console.log("Step 1: Creating test entity...");
      const createEntityResult = await client.callTool({
        name: "create_entity",
        arguments: {
          name: entityName,
          isPublicInfo: false,
          type: "other",
          description: "Test entity for lookup workflow",
        },
      });

      assert.ok(!createEntityResult.isError, "Create entity should not return an error");
      const createEntityContent = createEntityResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      const createEntityParsed = JSON.parse(createEntityContent!.text) as { id: string };
      entityId = createEntityParsed.id;
      console.log(`Created entity "${entityName}" with ID: ${entityId}`);

      // Step 2: Add multiple addresses to this entity
      console.log("\nStep 2: Adding addresses to the entity...");

      const createAddress1Result = await client.callTool({
        name: "create_address",
        arguments: {
          address: testAddress1,
          network: network,
          isPublicInfo: false,
          type: "other",
          entityId: entityId,
        },
      });
      assert.ok(!createAddress1Result.isError, "Create address 1 should not return an error");
      console.log(`Added address: ${testAddress1}`);

      const createAddress2Result = await client.callTool({
        name: "create_address",
        arguments: {
          address: testAddress2,
          network: network,
          isPublicInfo: false,
          type: "other",
          entityId: entityId,
        },
      });
      assert.ok(!createAddress2Result.isError, "Create address 2 should not return an error");
      console.log(`Added address: ${testAddress2}`);

      // Step 3: Search for entity by name (simulating only knowing the name)
      console.log("\nStep 3: Searching for entity by name...");
      const searchEntityResult = await client.callTool({
        name: "search_entities",
        arguments: { name: entityName },
      });

      assert.ok(!searchEntityResult.isError, "Search entity should not return an error");
      const searchEntityContent = searchEntityResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      const searchEntityParsed = JSON.parse(searchEntityContent!.text) as {
        publicList: Array<{ id: string; name: string }>;
        privateList: Array<{ id: string; name: string }>;
      };

      const allEntities = [
        ...(searchEntityParsed.publicList || []),
        ...(searchEntityParsed.privateList || []),
      ];
      const foundEntity = allEntities.find((e) => e.name === entityName);
      assert.ok(foundEntity, "Should find the entity by name");
      console.log(`Found entity: ${foundEntity.name} (ID: ${foundEntity.id})`);

      // Step 4: Use the found entity ID to get all associated addresses
      console.log("\nStep 4: Getting addresses for the entity (by ID only, no address knowledge)...");
      const getAddressesResult = await client.callTool({
        name: "get_entity_addresses",
        arguments: { entityId: foundEntity.id },
      });

      assert.ok(!getAddressesResult.isError, "Get entity addresses should not return an error");
      const getAddressesContent = getAddressesResult.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      console.log("Entity addresses result:", getAddressesContent!.text);

      const addressesParsed = JSON.parse(getAddressesContent!.text) as {
        publicBlacklist: Array<{ address: string; network: string }>;
        privateBlacklist: Array<{ address: string; network: string }>;
      };
      const allAddresses = [
        ...(addressesParsed.publicBlacklist || []),
        ...(addressesParsed.privateBlacklist || []),
      ];

      // Verify we found both addresses
      assert.ok(allAddresses.length >= 2, `Should find at least 2 addresses, found ${allAddresses.length}`);

      const foundAddress1 = allAddresses.find((a) => a.address === testAddress1);
      const foundAddress2 = allAddresses.find((a) => a.address === testAddress2);

      assert.ok(foundAddress1, `Should find address ${testAddress1}`);
      assert.ok(foundAddress2, `Should find address ${testAddress2}`);

      console.log(`\nDiscovered ${allAddresses.length} addresses for entity "${entityName}":`);
      allAddresses.forEach((addr) => {
        console.log(`  - ${addr.address} (${addr.network})`);
      });

      // Cleanup: Delete addresses and entity
      console.log("\nStep 5: Cleaning up...");
      await client.callTool({
        name: "delete_address",
        arguments: { address: testAddress1, network: network },
      });
      await client.callTool({
        name: "delete_address",
        arguments: { address: testAddress2, network: network },
      });
      await client.callTool({
        name: "delete_entity",
        arguments: { entityId: entityId },
      });
      console.log("Cleanup complete.");

      console.log("\n✓ Entity lookup and address discovery workflow completed successfully!");
    } finally {
      await client.close();
    }
  });
});
