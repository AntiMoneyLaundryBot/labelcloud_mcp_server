import { describe, it, before } from "node:test";
import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assertAllowedTestHost, assertExactDevAppUrl } from "../helpers/dev-endpoint.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

/**
 * #279 / #285 AC-8 evidence harness: the 8 incident tools of the Dev-App MCP versus the dev
 * backend's HTTP API. Deliberately OUTSIDE the `test/*.test.ts` glob of `npm test`: it writes real
 * rows on dev. Written in C2, run by hand in C4 once the backend incident routes are on dev:
 *
 *   MCP_TEST_URL=http://94.130.51.230:9180/mcp \
 *   LC_API_URL=https://api-blacklist.amlbot.rocks \
 *   LC_KEY_A_FILE=/path/to/mode-600/key-file \
 *   node --import tsx --test test/live/mcp-incidents-ac.test.ts
 *
 * The key (s33 key A, ORGANIZATION_USER, R9a) comes ONLY from the file named by LC_KEY_A_FILE: the
 * file must be a regular file with mode 600 (no group/other bits). The key is never typed, never
 * logged, never put in the evidence file. The `before` hook is the guard; ANY failure stops
 * every write:
 *   (a) MCP_TEST_URL is exactly the Dev-App URL and LC_API_URL exactly the dev API;
 *   (b) the dev MCP reports serverInfo.version === 2.2.0 (== package.json) and lists exactly 24
 *       tools. Today's dev MCP is v2.1.0 / 16 tools: this suite then FAILS before any write.
 *
 * It FAILS (never skips) on a missing URL / key file. Evidence: workdone/285-evidence/mcp-incidents-ac.json.
 */

const DEV_API_URL = "https://api-blacklist.amlbot.rocks";
const EXPECTED_VERSION = "2.2.0";
const EXPECTED_TOOLS = 24;
const INCIDENT_DATE = "2026-11-06";
const MAX_PAGES = 500;

const nonce = process.env.AC285_NONCE ?? randomBytes(3).toString("hex");
const BTC_ADDRESS = `s33t2-X-${nonce}`;
const EVM_LOWER = `0x${randomBytes(20).toString("hex")}`;
const EVM_CHECKSUM_STYLE = `0x${EVM_LOWER.slice(2)
  .split("")
  .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
  .join("")}`;
const INCIDENT_NAME = `s33t2-ac8-${nonce}`;

let mcpUrl: string;
let apiUrl: string;
let key = "";
const evidence: Record<string, unknown> = {};

// created state shared between the ordered tests
let incidentId = "";
let incidentTag = "";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required: this evidence suite fails rather than skips`);
  return value;
}

/** Read the key from a mode-600 regular file; the value never leaves this function except as the return. */
function readKeyFile(path: string): string {
  const st = statSync(path);
  assert.ok(st.isFile(), "LC_KEY_A_FILE must be a regular file");
  assert.strictEqual(st.mode & 0o077, 0, "LC_KEY_A_FILE must be mode 600 (no group/other access)");
  const value = readFileSync(path, "utf8").trim();
  assert.ok(value.length > 0, "LC_KEY_A_FILE is empty");
  return value;
}

interface ToolResult {
  content: Array<{ text: string }>;
  isError?: boolean;
}

async function callTool(name: string, args: Record<string, unknown>) {
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

/** Direct dev-API call, pinned to the dev host (apiUrl is asserted in `before`). */
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "X-API-KEY": key,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { status: response.status, json, text };
}

function sseOrJson(raw: string): string {
  return raw.startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
}

async function mcpRpc(method: string, params: unknown, withKey: boolean) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(withKey ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return JSON.parse(sseOrJson(await response.text())) as {
    result?: { serverInfo?: { version?: string }; tools?: unknown[] };
  };
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Follow nextCursor to null (a page may be short or empty before the end); fail on a runaway cursor. */
async function followAll<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    assert.ok(Array.isArray(result.items), "page has no items array");
    all.push(...result.items);
    if (result.nextCursor === null) return all;
    assert.strictEqual(typeof result.nextCursor, "string", "nextCursor must be a string or null");
    cursor = result.nextCursor;
  }
  throw new Error(`cursor did not reach null within ${MAX_PAGES} pages`);
}

const mcpSearch = (args: Record<string, unknown>) =>
  followAll<Record<string, unknown>>(async (cursor) => {
    const r = await callTool("search_incidents", { ...args, limit: 5, ...(cursor ? { cursor } : {}) });
    assert.strictEqual(r.isError, false, r.text);
    return r.json as Page<Record<string, unknown>>;
  });

const apiSearch = (params: Record<string, string>) =>
  followAll<Record<string, unknown>>(async (cursor) => {
    const q = new URLSearchParams({ ...params, limit: "5", ...(cursor ? { cursor } : {}) });
    const r = await api("GET", `/v1/black-list/incidents?${q}`);
    assert.strictEqual(r.status, 200, r.text);
    return r.json as Page<Record<string, unknown>>;
  });

const byId = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  String(a.id).localeCompare(String(b.id));

before(async () => {
  mcpUrl = requireEnv("MCP_TEST_URL");
  assertAllowedTestHost(mcpUrl);
  assertExactDevAppUrl(mcpUrl);
  apiUrl = requireEnv("LC_API_URL");
  assert.strictEqual(apiUrl, DEV_API_URL, `LC_API_URL must be exactly ${DEV_API_URL}`);
  key = readKeyFile(requireEnv("LC_KEY_A_FILE"));
  assert.match(nonce, /^[0-9a-f]{6}$/, "AC285_NONCE must be 6 lowercase hex characters");
  assert.strictEqual(pkg.version, EXPECTED_VERSION, `package.json version must be ${EXPECTED_VERSION}`);

  // Refuse to run (fail world: dev MCP v2.1.0 / 16 tools) unless the dev MCP is v2.2.0 with 24 tools.
  const init = await mcpRpc(
    "initialize",
    { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ac285-guard", version: "0" } },
    true
  );
  const version = init.result?.serverInfo?.version;
  assert.strictEqual(version, EXPECTED_VERSION, `dev MCP reports v${version}, need v${EXPECTED_VERSION}: no write sent`);
  const list = await mcpRpc("tools/list", {}, true);
  assert.strictEqual(
    list.result?.tools?.length,
    EXPECTED_TOOLS,
    `dev MCP lists ${list.result?.tools?.length} tools, need ${EXPECTED_TOOLS}: no write sent`
  );
  evidence["guard"] = { version, tools: list.result?.tools?.length };
});

describe("#285 AC-8: incident tools through the dev MCP == the dev API", () => {
  it("seed: create a private incident and two labelled addresses (bitcoin + EVM)", async () => {
    const created = await callTool("create_incident", {
      name: INCIDENT_NAME,
      incidentDate: INCIDENT_DATE,
      description: "S33 T2 AC-8 live check",
    });
    evidence["create_incident"] = created;
    assert.strictEqual(created.isError, false, created.text);
    const inc = created.json as Record<string, unknown>;
    incidentId = String(inc.id);
    incidentTag = String(inc.tag);
    assert.ok(incidentId, "create_incident returned no id");
    assert.match(incidentTag, /^incident\..+\.20261106$/);
    assert.strictEqual(inc.isPublicInfo, false);
    assert.strictEqual(inc.status, "ACTIVE");

    for (const [address, network] of [
      [BTC_ADDRESS, "bitcoin"],
      [EVM_CHECKSUM_STYLE, "ethereum"],
    ] as const) {
      const label = await callTool("create_address", { address, network, isPublicInfo: false, type: "scam" });
      assert.strictEqual(label.isError, false, label.text);
      const tagged = await callTool("add_address_tag", { address, network, tag: incidentTag });
      evidence[`tag-${network}`] = tagged;
      assert.strictEqual(tagged.isError, false, tagged.text);
    }
  });

  it("get_incident and get_incident_by_tag == the API fetched by id / by tag", async () => {
    const viaMcp = await callTool("get_incident", { id: incidentId });
    const direct = await api("GET", `/v1/black-list/incidents/${incidentId}`);
    evidence["get_incident"] = { mcp: viaMcp.json, api: direct.json };
    assert.strictEqual(direct.status, 200);
    assert.deepStrictEqual(viaMcp.json, direct.json);

    const byTag = await callTool("get_incident_by_tag", { tag: incidentTag });
    const directByTag = await api("GET", `/v1/black-list/incidents/by-tag/${encodeURIComponent(incidentTag)}`);
    evidence["get_incident_by_tag"] = { mcp: byTag.json, api: directByTag.json };
    assert.strictEqual(directByTag.status, 200);
    assert.deepStrictEqual(byTag.json, directByTag.json);
    assert.deepStrictEqual(byTag.json, direct.json);
  });

  it("get_incident_addresses: follow cursor to null; EVM is evm_eoa lowercase; == API", async () => {
    const viaMcp = await followAll<Record<string, unknown>>(async (cursor) => {
      const r = await callTool("get_incident_addresses", { id: incidentId, limit: 1, ...(cursor ? { cursor } : {}) });
      assert.strictEqual(r.isError, false, r.text);
      return r.json as Page<Record<string, unknown>>;
    });
    const viaApi = await followAll<Record<string, unknown>>(async (cursor) => {
      const q = new URLSearchParams({ limit: "1", ...(cursor ? { cursor } : {}) });
      const r = await api("GET", `/v1/black-list/incidents/${incidentId}/addresses?${q}`);
      assert.strictEqual(r.status, 200, r.text);
      return r.json as Page<Record<string, unknown>>;
    });
    evidence["get_incident_addresses"] = { mcp: viaMcp, api: viaApi };
    const norm = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => `${r.network}|${r.address}|${r.tag}`).sort();
    assert.deepStrictEqual(norm(viaMcp), norm(viaApi));
    assert.deepStrictEqual(
      norm(viaMcp),
      [`bitcoin|${BTC_ADDRESS}|${incidentTag}`, `evm_eoa|${EVM_LOWER}|${incidentTag}`].sort()
    );
  });

  it("get_address_incidents for both addresses: incident == the API's incident fetched by id", async () => {
    const direct = (await api("GET", `/v1/black-list/incidents/${incidentId}`)).json;
    for (const [address, network, expectNetwork] of [
      [BTC_ADDRESS, "bitcoin", "bitcoin"],
      [EVM_CHECKSUM_STYLE, "ethereum", "evm_eoa"],
    ] as const) {
      const r = await callTool("get_address_incidents", { address, network: expectNetwork });
      evidence[`get_address_incidents-${network}`] = r;
      assert.strictEqual(r.isError, false, r.text);
      const items = (r.json as { items: Array<{ network: string; tag: string; incident: unknown }> }).items;
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0]!.network, expectNetwork);
      assert.strictEqual(items[0]!.tag, incidentTag);
      assert.deepStrictEqual(items[0]!.incident, direct);
    }
  });

  it("search_incidents by name: follow cursor to null; MCP == API; finds the new incident", async () => {
    const viaMcp = await mcpSearch({ name: INCIDENT_NAME });
    const viaApi = await apiSearch({ name: INCIDENT_NAME });
    evidence["search_incidents-name"] = { mcp: viaMcp, api: viaApi };
    assert.deepStrictEqual([...viaMcp].sort(byId), [...viaApi].sort(byId));
    assert.ok(viaMcp.some((i) => i.id === incidentId), "new incident not found by name");
  });

  it("search_incidents isPublicInfo:false: only private incidents, includes ours; MCP == API", async () => {
    const viaMcp = await mcpSearch({ isPublicInfo: false });
    const viaApi = await apiSearch({ isPublicInfo: "false" });
    evidence["search_incidents-private"] = { mcp: viaMcp.length, api: viaApi.length };
    assert.deepStrictEqual([...viaMcp].sort(byId), [...viaApi].sort(byId));
    assert.ok(viaMcp.length > 0);
    assert.ok(viaMcp.every((i) => i.isPublicInfo === false), "isPublicInfo:false returned a public incident");
    assert.ok(viaMcp.some((i) => i.id === incidentId), "private search misses the new private incident");

    const publicOnly = await mcpSearch({ isPublicInfo: true });
    assert.ok(publicOnly.every((i) => i.isPublicInfo === true));
    assert.ok(!publicOnly.some((i) => i.id === incidentId), "private incident leaked into isPublicInfo:true");
  });

  it("update_incident changes the named fields only; API read-back by id agrees", async () => {
    const r = await callTool("update_incident", { id: incidentId, description: `updated ${nonce}` });
    evidence["update_incident"] = r;
    assert.strictEqual(r.isError, false, r.text);
    const direct = await api("GET", `/v1/black-list/incidents/${incidentId}`);
    const inc = direct.json as Record<string, unknown>;
    assert.strictEqual(inc.description, `updated ${nonce}`);
    assert.strictEqual(inc.name, INCIDENT_NAME);
    assert.strictEqual(inc.tag, incidentTag);
    assert.deepStrictEqual(r.json, inc);
  });

  it("control: update_incident exposes no `tag` input; an extra `tag` never changes the stored tag", async () => {
    // (i) AC-8 text: tools/list shows no `tag` property on update_incident.
    const list = await mcpRpc("tools/list", {}, true);
    const tool = (list.result?.tools as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>).find(
      (t) => t.name === "update_incident"
    );
    assert.ok(tool, "update_incident missing from tools/list");
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    evidence["update_incident-schema-properties"] = props;
    assert.ok(props.length > 0 && props.includes("id"), "update_incident schema has no properties");
    assert.ok(!props.includes("tag"), "update_incident must not expose a `tag` property");

    // (ii) an extra `tag` is either rejected by the MCP schema or ignored: the backend row's tag is unchanged on re-GET.
    // (omitArgs:["tag"] means it can never reach the backend; a PATCH incidentDate change -> 400 is a backend rule, not tested here.)
    const viaMcp = await callTool("update_incident", { id: incidentId, tag: "incident.hijack.20261106" });
    evidence["update_incident-tag-mcp"] = viaMcp;
    const after = (await api("GET", `/v1/black-list/incidents/${incidentId}`)).json as Record<string, unknown>;
    evidence["update_incident-tag-after"] = { isError: viaMcp.isError, tag: after.tag };
    assert.strictEqual(after.tag, incidentTag, "backend tag changed after an update_incident call carrying `tag`");
  });

  it("delete_incident -> null, idempotent; DELETED visible via get and status filter, hidden by default", async () => {
    const first = await callTool("delete_incident", { id: incidentId });
    evidence["delete_incident"] = first;
    assert.strictEqual(first.isError, false, first.text);
    assert.strictEqual(first.text, "null");
    const repeat = await callTool("delete_incident", { id: incidentId });
    assert.strictEqual(repeat.isError, false, repeat.text);

    const viaMcp = await callTool("get_incident", { id: incidentId });
    const direct = await api("GET", `/v1/black-list/incidents/${incidentId}`);
    assert.strictEqual((direct.json as { status: string }).status, "DELETED");
    assert.deepStrictEqual(viaMcp.json, direct.json);

    const active = await mcpSearch({ name: INCIDENT_NAME });
    assert.ok(!active.some((i) => i.id === incidentId), "DELETED incident in the default (ACTIVE) search");
    const deleted = await mcpSearch({ name: INCIDENT_NAME, status: "DELETED" });
    const deletedApi = await apiSearch({ name: INCIDENT_NAME, status: "DELETED" });
    assert.ok(deleted.some((i) => i.id === incidentId));
    assert.deepStrictEqual([...deleted].sort(byId), [...deletedApi].sort(byId));
  });

  it("cleanup: remove the tags and the two labels (best effort) and write the evidence file", async () => {
    for (const [address, network] of [
      [BTC_ADDRESS, "bitcoin"],
      [EVM_CHECKSUM_STYLE, "evm_eoa"],
    ] as const) {
      const removed = await callTool("remove_address_tag", { address, network, tag: incidentTag });
      evidence[`cleanup-tag-${network}`] = removed;
      const deleted = await callTool("delete_address", { address, network });
      evidence[`cleanup-address-${network}`] = deleted;
    }
    mkdirSync("workdone/285-evidence", { recursive: true });
    writeFileSync("workdone/285-evidence/mcp-incidents-ac.json", JSON.stringify(evidence, null, 2));
  });
});
