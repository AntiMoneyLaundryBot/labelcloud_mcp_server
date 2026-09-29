import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  startInProcess,
  rpc2026,
  mockUpstream,
  type MockUpstream,
} from "./helpers/http-server.js";
import type { HttpServerHandle } from "../src/index.js";

/**
 * #193: add_address_tag / remove_address_tag and `tags` on search_addresses,
 * over the real in-process HTTP transport against a mock Label Cloud upstream.
 * No dev/prod network calls - BLACKLIST_API_URL points at the mock.
 */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const EXPECTED_USER_AGENT = `labelcloud-mcp/${pkg.version}`;

const KEY = "tag-test-key";
const CHECKSUMMED = "0x6Fe9Ef9d42595682A555698b6b2a68bd4495AeA3";
const LOWERCASE = CHECKSUMMED.toLowerCase();
const BTC = "s18t2-X";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function reply(status: number, jsonBody?: unknown): Handler {
  return (_req, res) => {
    if (jsonBody === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(jsonBody));
  };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let handle: HttpServerHandle;
let upstream: MockUpstream;

async function startWith(handler: Handler): Promise<void> {
  upstream = await mockUpstream(handler);
  process.env.BLACKLIST_API_URL = upstream.url;
  handle = await startInProcess();
}

async function call(name: string, args: Record<string, unknown>, id = 1): Promise<ToolResult> {
  const result = await rpc2026(handle.url, {
    method: "tools/call",
    params: { name, arguments: args },
    key: KEY,
    mcpName: name,
    id,
  });
  assert.strictEqual(result.status, 200);
  const body = result.body as { result?: ToolResult; error?: unknown };
  assert.ok(body.result, `tools/call returned no result: ${JSON.stringify(body)}`);
  return body.result;
}

afterEach(async () => {
  await handle.close();
  await upstream.close();
});

describe("#193 tools/list", () => {
  beforeEach(async () => {
    await startWith(reply(200, {}));
  });

  it("1: both tag tools are listed with required {address, tag, network}, the network enum and the right annotations", async () => {
    const result = await rpc2026(handle.url, { method: "tools/list", id: 1 });
    const body = result.body as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: {
            properties: Record<string, { enum?: string[] }>;
            required?: string[];
          };
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
        }>;
      };
    };
    const byName = new Map(body.result.tools.map((t) => [t.name, t]));

    for (const name of ["add_address_tag", "remove_address_tag"]) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} should be listed`);
      assert.deepStrictEqual(Object.keys(tool.inputSchema.properties).sort(), [
        "address",
        "network",
        "tag",
      ]);
      assert.deepStrictEqual([...(tool.inputSchema.required ?? [])].sort(), [
        "address",
        "network",
        "tag",
      ]);
      assert.strictEqual(tool.inputSchema.properties.network?.enum?.length, 65);
    }
    assert.deepStrictEqual(byName.get("add_address_tag")?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
    });
    assert.deepStrictEqual(byName.get("remove_address_tag")?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
    });

    // Positive control: the same lookup on a name that is not a tool finds nothing.
    assert.strictEqual(byName.get("rename_address_tag"), undefined);
  });
});

describe("#193 add_address_tag / remove_address_tag over the wire", () => {
  it("2: add on a checksummed EVM address lowercases the path, sends no body, and passes the 200 through", async () => {
    const stored = { address: LOWERCASE, network: "evm_eoa", tag: "geo.uk.london", added: true };
    await startWith(reply(200, stored));

    const result = await call("add_address_tag", {
      address: CHECKSUMMED,
      network: "ethereum",
      tag: "geo.uk.london",
    });

    assert.strictEqual(result.isError, undefined);
    assert.deepStrictEqual(JSON.parse(result.content[0]!.text), stored);
    assert.strictEqual(upstream.hits.length, 1);
    const hit = upstream.hits[0]!;
    assert.strictEqual(hit.method, "PUT");
    assert.strictEqual(
      hit.url,
      `/v1/black-list/addresses/${LOWERCASE}/tags/geo.uk.london?network=ethereum`
    );
    assert.strictEqual(hit.body.length, 0);
    assert.strictEqual(hit.apiKey, KEY);
    assert.strictEqual(hit.userAgent, EXPECTED_USER_AGENT);

    // Positive control: on a non-EVM network the checksummed bytes stay in the path.
    await call("add_address_tag", { address: CHECKSUMMED, network: "tron", tag: "geo.uk" }, 2);
    assert.strictEqual(
      upstream.hits[1]?.url,
      `/v1/black-list/addresses/${CHECKSUMMED}/tags/geo.uk?network=tron`
    );
  });

  it("3: remove with an upstream 204 returns the text \"null\" and no isError", async () => {
    await startWith(reply(204));

    const result = await call("remove_address_tag", {
      address: BTC,
      network: "bitcoin",
      tag: "geo.uk.london",
    });

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, "null");
    assert.strictEqual(upstream.hits.length, 1);
    assert.strictEqual(upstream.hits[0]?.method, "DELETE");
    assert.strictEqual(
      upstream.hits[0]?.url,
      `/v1/black-list/addresses/${BTC}/tags/geo.uk.london?network=bitcoin`
    );
    assert.strictEqual(upstream.hits[0]?.body.length, 0);
  });

  it("3b: control - the same remove against an upstream 404 is isError with API error 404", async () => {
    await startWith(reply(404, { message: "Not Found", statusCode: 404 }));

    const result = await call("remove_address_tag", {
      address: BTC,
      network: "bitcoin",
      tag: "geo.uk.london",
    });

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]!.text, /API error 404/);
  });

  it("4: an upstream 400 is surfaced as isError with API error 400 and the body", async () => {
    const errBody = {
      message: ["tag must match /^[a-z0-9_]+(\\.[a-z0-9_]+)*$/ regular expression"],
      error: "Bad Request",
      statusCode: 400,
    };
    await startWith(reply(400, errBody));

    const result = await call("add_address_tag", { address: BTC, network: "bitcoin", tag: "x" });

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0]!.text.startsWith("Error: API error 400: "));
    assert.ok(result.content[0]!.text.includes("tag must match"));

    // Positive control: a 200 upstream on the same call is not an error.
    await handle.close();
    await upstream.close();
    await startWith(reply(200, { address: BTC, network: "bitcoin", tag: "x", added: true }));
    const ok = await call("add_address_tag", { address: BTC, network: "bitcoin", tag: "x" }, 2);
    assert.strictEqual(ok.isError, undefined);
  });

  it("5: the tag is forwarded verbatim - no client-side lowercasing or validation", async () => {
    await startWith(reply(400, { statusCode: 400 }));

    const result = await call("add_address_tag", {
      address: BTC,
      network: "bitcoin",
      tag: "Geo UK",
    });

    assert.strictEqual(upstream.hits.length, 1);
    assert.strictEqual(
      upstream.hits[0]?.url,
      `/v1/black-list/addresses/${BTC}/tags/Geo%20UK?network=bitcoin`
    );
    // The 400 comes from the (mock) backend, not from a local check.
    assert.match(result.content[0]!.text, /^Error: API error 400/);
  });

  it("6: dot-segment path pieces are rejected locally with zero upstream calls", async () => {
    await startWith(reply(200, { added: true }));

    let id = 10;
    for (const tool of ["remove_address_tag", "add_address_tag"]) {
      for (const tag of ["..", ".", "../x", "a/.."]) {
        const result = await call(tool, { address: BTC, network: "bitcoin", tag }, id++);
        assert.strictEqual(result.isError, true, `${tool} tag=${tag} should be isError`);
        assert.match(result.content[0]!.text, /Invalid path parameter/);
      }
    }
    const addressResult = await call(
      "remove_address_tag",
      { address: "..", network: "bitcoin", tag: "geo.uk" },
      id++
    );
    assert.strictEqual(addressResult.isError, true);
    assert.match(addressResult.content[0]!.text, /Invalid path parameter/);
    assert.strictEqual(upstream.hits.length, 0, "no request may reach the upstream");

    // Positive control: a normal tag on the same tool makes exactly one call.
    const ok = await call(
      "remove_address_tag",
      { address: BTC, network: "bitcoin", tag: "geo.uk" },
      id++
    );
    assert.strictEqual(ok.isError, undefined);
    assert.strictEqual(upstream.hits.length, 1);

    // The guard is not a blanket ban: a slash inside a piece is still encoded and sent.
    await call("remove_address_tag", { address: BTC, network: "bitcoin", tag: "a/b" }, id++);
    assert.strictEqual(upstream.hits.length, 2);
    assert.strictEqual(
      upstream.hits[1]?.url,
      `/v1/black-list/addresses/${BTC}/tags/a%2Fb?network=bitcoin`
    );
  });
});

describe("#193 tags pass through search_addresses and get_auto_tracer_data", () => {
  const withTags = {
    publicBlacklist: [],
    privateBlacklist: [],
    tags: [{ network: "bitcoin", tag: "geo.uk" }],
  };

  it("7: search_addresses returns the upstream body unchanged, with and without fields", async () => {
    await startWith(reply(200, withTags));

    const plain = await call("search_addresses", { address: BTC });
    assert.deepStrictEqual(JSON.parse(plain.content[0]!.text), withTags);

    const withFields = await call(
      "search_addresses",
      { address: BTC, fields: ["address", "network", "type"] },
      2
    );
    assert.deepStrictEqual(JSON.parse(withFields.content[0]!.text), withTags);
    assert.ok(
      upstream.hits[1]?.url.includes("fields=address&fields=network&fields=type"),
      `fields should reach the query, got ${upstream.hits[1]?.url}`
    );

    // Positive control: an upstream body without tags yields a result without tags.
    await handle.close();
    await upstream.close();
    await startWith(reply(200, { publicBlacklist: [], privateBlacklist: [] }));
    const bare = await call("search_addresses", { address: BTC }, 3);
    assert.strictEqual("tags" in JSON.parse(bare.content[0]!.text), false);
  });

  it("8: get_auto_tracer_data also returns the top-level tags (spec A3)", async () => {
    await startWith(reply(200, withTags));

    const result = await call("get_auto_tracer_data", { address: BTC, network: "bitcoin" });

    assert.deepStrictEqual(JSON.parse(result.content[0]!.text).tags, withTags.tags);
    assert.ok(upstream.hits[0]?.url.includes("blockchains=bitcoin"));
  });
});

describe("#193 C2: set_auto_tracing never sends tags", () => {
  it("9: the POST body has no tags key even when the GET body carries tags", async () => {
    const row = {
      address: BTC,
      network: "bitcoin",
      organization: "org",
      type: "scam",
      publicInfo: true,
      description: null,
      subType: null,
      reference: null,
      entity_id: null,
      enableSniffer: false,
    };
    await startWith((req, res) => {
      if (req.method === "GET") {
        reply(200, {
          publicBlacklist: [row],
          privateBlacklist: [],
          tags: [{ network: "bitcoin", tag: "geo.uk" }],
        })(req, res);
      } else {
        reply(200, {})(req, res);
      }
    });

    const result = await call("set_auto_tracing", {
      address: BTC,
      network: "bitcoin",
      enableSniffer: true,
    });
    assert.strictEqual(result.isError, undefined, result.content[0]?.text);

    const post = upstream.hits.find((h) => h.method === "POST");
    assert.ok(post, "set_auto_tracing should POST an upsert");
    const postBody = JSON.parse(post.body) as Record<string, unknown>;
    assert.strictEqual("tags" in postBody, false);
    // Positive control: the body really is captured.
    assert.strictEqual(postBody.enableSniffer, true);
  });
});
