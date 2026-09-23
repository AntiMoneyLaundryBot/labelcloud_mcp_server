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

describe("MCP Address Blocklist", () => {
  it("should find address TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp via MCP search_addresses tool", async () => {
    const address = "TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp";

    const transport = devTransport(server.url);

    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);

      // Call the search_addresses tool
      const result = await client.callTool({
        name: "search_addresses",
        arguments: { address },
      });

      assert.ok(result, "Tool should return a result");
      assert.ok(result.content, "Result should have content");
      assert.ok(Array.isArray(result.content), "Content should be an array");

      const textContent = result.content.find(
        (c): c is { type: "text"; text: string } => c.type === "text"
      );
      assert.ok(textContent, "Should have text content");

      const parsed = JSON.parse(textContent.text) as {
        publicBlacklist: Array<{ address: string; network: string }>;
        privateBlacklist: Array<{ address: string; network: string }>;
      };
      assert.ok(parsed.publicBlacklist || parsed.privateBlacklist, "Response should have blacklist arrays");

      const allAddresses = [...(parsed.publicBlacklist || []), ...(parsed.privateBlacklist || [])];
      assert.ok(allAddresses.length > 0, "Response should contain at least one address");

      const found = allAddresses.find(r => r.address === address);
      assert.ok(found, "Response should contain the searched address");
      assert.strictEqual(found.network, "tron", "Address should be on tron network");

      console.log("MCP search result:", JSON.stringify(parsed, null, 2));
    } finally {
      await client.close();
    }
  });
});
