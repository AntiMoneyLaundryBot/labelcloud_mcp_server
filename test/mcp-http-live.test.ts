import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { rpc2026 } from "./helpers/http-server.js";
import { startDevServer, type DevServerHandle } from "./helpers/dev-endpoint.js";

/**
 * Dev-pinned live proof of the HTTP transport itself, over the real dev
 * Label Cloud API - AC-2 (the sent key reaches upstream), AC-4 (a rejected
 * key becomes a tool error), AC-6b (a matching Mcp-Name succeeds
 * statelessly) and the AC-10 JSON Content-Type check. Runs in-process by
 * default, or against a deployed instance when MCP_TEST_URL is set.
 */

let server: DevServerHandle;
let devKey: string;

before(async () => {
  devKey = process.env.BLACKLIST_API_KEY!;
  server = await startDevServer();
});

after(async () => {
  await server.close();
});

describe("AC-2 (live): the sent key reaches the real dev Label Cloud API", () => {
  it("search_addresses with the dev key finds the known fixture row", async () => {
    const result = await rpc2026(server.url, {
      method: "tools/call",
      params: { name: "search_addresses", arguments: { address: "TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp" } },
      key: devKey,
      mcpName: "search_addresses",
      id: 1,
    });
    assert.strictEqual(result.status, 200);
    const body = result.body as { result: { isError?: boolean; content: Array<{ text: string }> } };
    assert.ok(!body.result.isError, `search_addresses should not error: ${JSON.stringify(body.result)}`);
    const parsed = JSON.parse(body.result.content[0]?.text ?? "{}") as {
      publicBlacklist: Array<{ address: string; network: string }>;
      privateBlacklist: Array<{ address: string; network: string }>;
    };
    const all = [...(parsed.publicBlacklist || []), ...(parsed.privateBlacklist || [])];
    const found = all.find((r) => r.address === "TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp");
    assert.ok(found, "the fixture address should be found via the real dev API");
    assert.strictEqual(found.network, "tron");
  });
});

describe("AC-4 (live): a rejected key becomes a tool error, not an HTTP failure", () => {
  it("a bogus key against the real dev API surfaces as isError with the 403 text", async () => {
    const result = await rpc2026(server.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: "definitely-not-a-real-labelcloud-key",
      mcpName: "get_networks",
      id: 2,
    });
    assert.strictEqual(result.status, 200);
    const body = result.body as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.strictEqual(body.result.isError, true);
    assert.match(body.result.content[0]?.text ?? "", /API error/);
  });
});

describe("AC-6b (live): tools/call with a matching Mcp-Name succeeds statelessly", () => {
  it("get_networks with a matching Mcp-Name returns resultType complete", async () => {
    const result = await rpc2026(server.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: devKey,
      mcpName: "get_networks",
      id: 3,
    });
    assert.strictEqual(result.status, 200);
    const body = result.body as { result: { resultType: string } };
    assert.strictEqual(body.result.resultType, "complete");
  });
});

describe("AC-10 (live): a 2026 tools/call response has a JSON content-type", () => {
  it("content-type starts with application/json against the real dev backend", async () => {
    const result = await rpc2026(server.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: devKey,
      mcpName: "get_networks",
      id: 4,
    });
    const contentType = result.headers.get("content-type") ?? "";
    assert.ok(contentType.startsWith("application/json"), `expected application/json, got "${contentType}"`);
  });
});
