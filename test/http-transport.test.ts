import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  startInProcess,
  rpc2026,
  mockUpstream,
  captureStdio,
  type MockUpstream,
} from "./helpers/http-server.js";
import type { HttpServerHandle } from "../src/index.js";

/**
 * AC-2 (wire level), AC-3, AC-4, AC-6, AC-10, C-2, C-5 (key isolation),
 * exercised over the real in-process HTTP transport against a mock Label
 * Cloud upstream. No dev/prod network calls - BLACKLIST_API_URL always
 * points at the mock server started for each test.
 */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const EXPECTED_USER_AGENT = `labelcloud-mcp/${pkg.version}`;

const READ_ONLY_TOOLS = [
  "search_addresses",
  "get_auto_tracer_data",
  "get_entity_addresses",
  "get_addresses_by_origin",
  "get_addresses_by_previous",
  "search_entities",
  "get_entity",
  "get_networks",
  "get_types",
];
const DESTRUCTIVE_TOOLS = ["delete_address", "delete_entity"];
const WRITE_TOOLS = ["create_address", "create_entity", "set_auto_tracing"];

function okJson(status = 200, jsonBody: unknown = {}) {
  return (
    _req: unknown,
    res: import("node:http").ServerResponse
  ): void => {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(jsonBody));
  };
}

let handle: HttpServerHandle;
let upstream: MockUpstream;

beforeEach(async () => {
  upstream = await mockUpstream(okJson(200, { networks: ["ethereum", "bitcoin", "tron"] }));
  process.env.BLACKLIST_API_URL = upstream.url;
  handle = await startInProcess();
});

afterEach(async () => {
  await handle.close();
  await upstream.close();
});

describe("AC-2: the sent key is the key upstream sees (wire level)", () => {
  it("a Bearer key arrives at upstream as x-api-key, with the labelcloud-mcp User-Agent", async () => {
    const result = await rpc2026(handle.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: "bearer-key-1",
      mcpName: "get_networks",
      id: 1,
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(upstream.hits.length, 1);
    assert.strictEqual(upstream.hits[0]?.apiKey, "bearer-key-1");
    assert.strictEqual(upstream.hits[0]?.userAgent, EXPECTED_USER_AGENT);
  });

  it("the X-Api-Key alias is honoured the same way as Bearer", async () => {
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "get_networks",
        "X-Api-Key": "alias-key-1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_networks",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(upstream.hits.length, 1);
    assert.strictEqual(upstream.hits[0]?.apiKey, "alias-key-1");
  });

  it("two concurrent calls with different keys each carry only their own key (C-5)", async () => {
    const [r1, r2] = await Promise.all([
      rpc2026(handle.url, {
        method: "tools/call",
        params: { name: "get_networks", arguments: {} },
        key: "K1",
        mcpName: "get_networks",
        id: 10,
      }),
      rpc2026(handle.url, {
        method: "tools/call",
        params: { name: "get_networks", arguments: {} },
        key: "K2",
        mcpName: "get_networks",
        id: 11,
      }),
    ]);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(upstream.hits.length, 2);
    const seenKeys = upstream.hits.map((h) => h.apiKey).sort();
    assert.deepStrictEqual(seenKeys, ["K1", "K2"]);
  });
});

describe("AC-3: missing key -> 401, no upstream call", () => {
  it("tools/call with no auth returns 401 with WWW-Authenticate and makes no upstream call", async () => {
    const result = await rpc2026(handle.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      mcpName: "get_networks",
      id: 3,
    });
    assert.strictEqual(result.status, 401);
    const wwwAuth = result.headers.get("www-authenticate");
    assert.ok(wwwAuth && /^Bearer/.test(wwwAuth), `expected a Bearer challenge, got "${wwwAuth}"`);
    const body = result.body as { error: { code: number } };
    assert.strictEqual(body.error.code, -32001);
    assert.strictEqual(upstream.hits.length, 0, "no upstream call should be made without a key");
  });

  it("positive control: the same call with a key returns 200 and exactly 1 upstream hit", async () => {
    const result = await rpc2026(handle.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: "has-a-key",
      mcpName: "get_networks",
      id: 4,
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(upstream.hits.length, 1);
  });
});

describe("AC-4: a rejected key becomes a tool error, not an HTTP failure", () => {
  it("upstream 403 surfaces as HTTP 200 with result.isError and the 403 text", async () => {
    await upstream.close();
    upstream = await mockUpstream((req, res) => {
      const apiKey = req.headers["x-api-key"];
      if (apiKey === "bogus") {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    process.env.BLACKLIST_API_URL = upstream.url;
    await handle.close();
    handle = await startInProcess();

    const result = await rpc2026(handle.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: "bogus",
      mcpName: "get_networks",
      id: 5,
    });
    assert.strictEqual(result.status, 200);
    const body = result.body as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.strictEqual(body.result.isError, true);
    assert.match(body.result.content[0]?.text ?? "", /API error 403/);
  });
});

describe("AC-6: 2026-07-28 served statelessly, no initialize", () => {
  it("(a) server/discover lists 2026-07-28 in supportedVersions", async () => {
    const result = await rpc2026(handle.url, { method: "server/discover", id: 6 });
    assert.strictEqual(result.status, 200);
    const body = result.body as { result: { supportedVersions: string[] } };
    assert.ok(body.result.supportedVersions.includes("2026-07-28"));
  });

  it("(b) tools/call with matching Mcp-Name succeeds with resultType complete", async () => {
    const result = await rpc2026(handle.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: "matching-name-key",
      mcpName: "get_networks",
      id: 7,
    });
    assert.strictEqual(result.status, 200);
    const body = result.body as { result: { resultType: string } };
    assert.strictEqual(body.result.resultType, "complete");
  });

  it("(c) tools/call with a mismatched Mcp-Name is rejected 400 / -32020, no upstream call", async () => {
    const result = await rpc2026(handle.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: "mismatched-name-key",
      mcpName: "search_addresses",
      id: 8,
    });
    assert.strictEqual(result.status, 400);
    const body = result.body as { error: { code: number } };
    assert.strictEqual(body.error.code, -32020);
    assert.strictEqual(upstream.hits.length, 0);
  });
});

describe("AC-10: 2.x optimisations are present on the wire", () => {
  it("2026 tools/list carries ttlMs 3600000 and cacheScope public", async () => {
    const result = await rpc2026(handle.url, { method: "tools/list", id: 9 });
    assert.strictEqual(result.status, 200);
    const body = result.body as {
      result: { tools: unknown[] };
      _meta?: Record<string, { ttlMs?: number; cacheScope?: string }>;
    };
    const cacheMeta = (result.body as Record<string, unknown>)["_meta"] as
      | Record<string, unknown>
      | undefined;
    // The cache fields land in the top-level response _meta under the
    // reserved io.modelcontextprotocol namespace on 2026-07-28.
    const flatMeta = JSON.stringify(result.body);
    assert.match(flatMeta, /"ttlMs":3600000/);
    assert.match(flatMeta, /"cacheScope":"public"/);
    void body;
    void cacheMeta;
  });

  it("annotations: readOnlyHint/destructiveHint match the 9/2/3 split exactly", async () => {
    const result = await rpc2026(handle.url, { method: "tools/list", id: 12 });
    const body = result.body as {
      result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> };
    };
    const byName = new Map(body.result.tools.map((t) => [t.name, t.annotations]));

    for (const name of READ_ONLY_TOOLS) {
      assert.strictEqual(byName.get(name)?.readOnlyHint, true, `${name} should be readOnlyHint:true`);
    }
    for (const name of DESTRUCTIVE_TOOLS) {
      assert.strictEqual(byName.get(name)?.destructiveHint, true, `${name} should be destructiveHint:true`);
    }
    for (const name of WRITE_TOOLS) {
      const annotations = byName.get(name);
      assert.notStrictEqual(annotations?.readOnlyHint, true, `${name} should not be readOnlyHint:true`);
      assert.strictEqual(annotations?.destructiveHint, false, `${name} should be destructiveHint:false`);
    }
  });

  it("a 2026 tools/call response has a JSON content-type", async () => {
    const result = await rpc2026(handle.url, {
      method: "tools/call",
      params: { name: "get_networks", arguments: {} },
      key: "content-type-key",
      mcpName: "get_networks",
      id: 13,
    });
    const contentType = result.headers.get("content-type") ?? "";
    assert.ok(contentType.startsWith("application/json"), `expected application/json, got "${contentType}"`);
  });

  it("selector control: a legacy (2025-11-25-era) call gets an SSE reply, not JSON", async () => {
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 14, method: "tools/list", params: {} }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    assert.ok(
      contentType.startsWith("text/event-stream"),
      `expected the legacy-era SSE reply, got "${contentType}"`
    );
    const text = await response.text();
    assert.ok(!text.includes('"ttlMs"'), "the legacy-era tools/list must carry no ttlMs (C-10 guard)");
    assert.ok(!text.includes('"cacheScope"'), "the legacy-era tools/list must carry no cacheScope (C-10 guard)");
  });
});

describe("C-2: the key is never logged", () => {
  it("a keyed create_address never puts the key string on stdout or stderr", async () => {
    await upstream.close();
    upstream = await mockUpstream(okJson(200, { id: "scratch-entity" }));
    process.env.BLACKLIST_API_URL = upstream.url;
    await handle.close();
    handle = await startInProcess();

    const secretKey = "c2-secret-key-should-never-be-logged";
    const capture = captureStdio();
    try {
      const result = await rpc2026(handle.url, {
        method: "tools/call",
        params: {
          name: "create_address",
          arguments: {
            address: "TC2LogCheck",
            network: "tron",
            isPublicInfo: false,
            type: "other",
            enableSniffer: false,
          },
        },
        key: secretKey,
        mcpName: "create_address",
        id: 15,
      });
      assert.strictEqual(result.status, 200);
    } finally {
      capture.restore();
    }
    assert.ok(!capture.output().includes(secretKey), "the API key must never appear on stdout/stderr");
  });
});
