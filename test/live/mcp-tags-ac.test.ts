import { describe, it, before } from "node:test";
import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { assertAllowedTestHost } from "../helpers/dev-endpoint.js";

/**
 * #193 segment 2 evidence harness (AC-1 / AC-2 MCP legs) against the Dev-App MCP.
 * Deliberately OUTSIDE the `test/*.test.ts` glob of `npm test`: it writes real rows on
 * dev, so run it by hand once #19 and #193 are on dev:
 *
 *   MCP_TEST_URL=http://94.130.51.230:9180/mcp \
 *   LC_API_URL=https://api-blacklist.amlbot.rocks \
 *   LC_KEY_U1=... LC_KEY_G=... LC_KEY_O=... \
 *   node --import tsx --test test/live/mcp-tags-ac.test.ts
 *
 * It FAILS (never skips) when the URL or any key is missing. The store reads
 * (address_tags / blacklist_change_log in scylla-dev) are done by the agent and pasted
 * into the workdone; this file covers the MCP-visible half and saves it to
 * workdone/193-evidence/*.json.
 */

const DEV_API_URL = "https://api-blacklist.amlbot.rocks";
const FIXTURES = ["s18t1-P", "s18t1-Q", "s18t1-T"];
const FIELDS = ["address", "network", "type"];

let mcpUrl: string;
let apiUrl: string;
const keys = { U1: "", G: "", O: "" };
const evidence: Record<string, unknown> = {};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required: this evidence suite fails rather than skips`);
  }
  return value;
}

interface ToolResult {
  content: Array<{ text: string }>;
  isError?: boolean;
}

async function callTool(
  key: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean; json: unknown }> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = (await response.json()) as { result?: ToolResult };
  assert.ok(body.result, `no result from ${name}: HTTP ${response.status}`);
  const text = body.result.content[0]?.text ?? "";
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // an "Error: ..." text is not JSON
  }
  return { text, isError: body.result.isError === true, json };
}

async function httpSearch(key: string, address: string, withFields: boolean): Promise<unknown> {
  const query = new URLSearchParams({ address });
  if (withFields) for (const f of FIELDS) query.append("fields", f);
  const response = await fetch(`${apiUrl}/v1/black-list/addresses?${query}`, {
    headers: { "X-API-KEY": key },
  });
  assert.strictEqual(response.status, 200, `HTTP GET ${address} -> ${response.status}`);
  return response.json();
}

before(() => {
  mcpUrl = requireEnv("MCP_TEST_URL");
  assertAllowedTestHost(mcpUrl);
  apiUrl = requireEnv("LC_API_URL");
  assert.strictEqual(apiUrl, DEV_API_URL, `LC_API_URL must be exactly ${DEV_API_URL}`);
  keys.U1 = requireEnv("LC_KEY_U1");
  keys.G = requireEnv("LC_KEY_G");
  keys.O = requireEnv("LC_KEY_O");
});

describe("#193 AC-1: the tools write what HTTP writes (MCP legs)", () => {
  const nonce = randomBytes(3).toString("hex");
  const X = `s18t2-X-${nonce}`;
  const evmLower = `0x${randomBytes(20).toString("hex")}`;
  const evmChecksumStyle = `0x${evmLower
    .slice(2)
    .split("")
    .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
    .join("")}`;

  it("seed: U1 creates a public label on X so the labelled-address branch is exercised", async () => {
    const r = await callTool(keys.U1, "create_address", {
      address: X,
      network: "bitcoin",
      isPublicInfo: true,
      type: "scam",
    });
    evidence["seed"] = { X, ...r };
    assert.strictEqual(r.isError, false, r.text);
  });

  it("AC-1a: U1 add -> added:true, then a repeat -> added:false", async () => {
    const args = { address: X, network: "bitcoin", tag: "geo.uk.london" };
    const first = await callTool(keys.U1, "add_address_tag", args);
    evidence["AC-1a-first"] = first;
    assert.strictEqual(first.isError, false, first.text);
    assert.deepStrictEqual(first.json, { ...args, added: true });

    const repeat = await callTool(keys.U1, "add_address_tag", args);
    evidence["AC-1a-repeat"] = repeat;
    assert.strictEqual(repeat.isError, false, repeat.text);
    assert.deepStrictEqual(repeat.json, { ...args, added: false });
  });

  it("AC-1b: G remove -> null, then a repeat -> isError with API error 404", async () => {
    const args = { address: X, network: "bitcoin", tag: "geo.uk.london" };
    const removed = await callTool(keys.G, "remove_address_tag", args);
    evidence["AC-1b-remove"] = removed;
    assert.strictEqual(removed.isError, false, removed.text);
    assert.strictEqual(removed.text, "null");

    const repeat = await callTool(keys.G, "remove_address_tag", args);
    evidence["AC-1b-repeat"] = repeat;
    assert.strictEqual(repeat.isError, true);
    assert.match(repeat.text, /API error 404/);
  });

  it("AC-1c: a checksummed EVM add is readable by the lowercase form", async () => {
    const before = await callTool(keys.U1, "search_addresses", { address: evmLower });
    evidence["AC-1c-before"] = before;
    assert.deepStrictEqual((before.json as { tags?: unknown }).tags, []);

    const added = await callTool(keys.U1, "add_address_tag", {
      address: evmChecksumStyle,
      network: "ethereum",
      tag: "geo.uk",
    });
    evidence["AC-1c-add"] = added;
    assert.strictEqual(added.isError, false, added.text);
    assert.deepStrictEqual(added.json, {
      address: evmLower,
      network: "evm_eoa",
      tag: "geo.uk",
      added: true,
    });

    const after = await callTool(keys.U1, "search_addresses", { address: evmLower });
    evidence["AC-1c-after"] = after;
    assert.deepStrictEqual((after.json as { tags?: unknown }).tags, [
      { network: "evm_eoa", tag: "geo.uk" },
    ]);

    const cleanup = await callTool(keys.U1, "remove_address_tag", {
      address: evmChecksumStyle,
      network: "evm_eoa",
      tag: "geo.uk",
    });
    evidence["AC-1c-cleanup"] = cleanup;
    assert.strictEqual(cleanup.text, "null");
  });

  it("AC-1d: an invalid tag is isError with API error 400 and writes nothing", async () => {
    const r = await callTool(keys.U1, "add_address_tag", {
      address: X,
      network: "bitcoin",
      tag: "Geo UK",
    });
    evidence["AC-1d"] = r;
    assert.strictEqual(r.isError, true);
    assert.ok(r.text.startsWith("Error: API error 400: "), r.text);
    assert.ok(r.text.includes("tag must match"), r.text);
  });
});

describe("#193 AC-2: search_addresses tags == HTTP v1 GET tags, with and without fields", () => {
  for (const withFields of [false, true]) {
    for (const [who, key] of [
      ["O", () => keys.O],
      ["U1", () => keys.U1],
    ] as const) {
      for (const fixture of FIXTURES) {
        it(`AC-2${withFields ? "b" : "a"}: ${who} x ${fixture}`, async () => {
          const mcp = await callTool(key(), "search_addresses", {
            address: fixture,
            ...(withFields ? { fields: FIELDS } : {}),
          });
          const http = await httpSearch(key(), fixture, withFields);
          evidence[`AC-2${withFields ? "b" : "a"}-${who}-${fixture}`] = { mcp: mcp.json, http };

          const mcpTags = (mcp.json as { tags?: unknown }).tags;
          const httpTags = (http as { tags?: unknown }).tags;
          assert.ok(Array.isArray(mcpTags), "MCP result must carry a tags array");
          assert.ok(Array.isArray(httpTags), "HTTP body must carry a tags array");
          assert.deepStrictEqual(mcp.json, http);
        });
      }
    }
  }

  it("expected tags per cell: O sees P and T tags but not Q; U1 sees all three", async () => {
    const tagsOf = async (key: string, fixture: string) =>
      ((await callTool(key, "search_addresses", { address: fixture })).json as { tags: unknown[] })
        .tags;
    const geoUk = [{ network: "bitcoin", tag: "geo.uk" }];
    assert.deepStrictEqual(await tagsOf(keys.O, "s18t1-P"), geoUk);
    assert.deepStrictEqual(await tagsOf(keys.O, "s18t1-T"), geoUk);
    assert.deepStrictEqual(await tagsOf(keys.O, "s18t1-Q"), []);
    for (const fixture of FIXTURES) {
      assert.deepStrictEqual(await tagsOf(keys.U1, fixture), geoUk);
    }
  });

  it("fields really applied: P's rows only carry the requested keys with fields, more without", async () => {
    const withF = (await callTool(keys.U1, "search_addresses", {
      address: "s18t1-P",
      fields: FIELDS,
    })) as { json: { publicBlacklist: Array<Record<string, unknown>> } };
    const without = (await callTool(keys.U1, "search_addresses", {
      address: "s18t1-P",
    })) as { json: { publicBlacklist: Array<Record<string, unknown>> } };
    for (const row of withF.json.publicBlacklist) {
      for (const k of Object.keys(row)) assert.ok(FIELDS.includes(k), `unexpected key ${k}`);
    }
    assert.ok(
      without.json.publicBlacklist.some((row) => "description" in row || "reference" in row),
      "default fields should include description/reference"
    );
  });

  it("writes the evidence file", () => {
    mkdirSync("workdone/193-evidence", { recursive: true });
    writeFileSync("workdone/193-evidence/mcp-tags-ac.json", JSON.stringify(evidence, null, 2));
  });
});
