import { describe, it } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "index.js");

describe("MCP Address Blocklist", () => {
  it("should find address TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp via MCP search_addresses tool", async () => {
    const address = "TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp";

    // Spawn the MCP server
    const serverProcess = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: { ...process.env },
    });

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
      serverProcess.kill();
    }
  });
});
