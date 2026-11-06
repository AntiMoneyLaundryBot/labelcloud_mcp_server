import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { startInProcess, rpc2026, mockUpstream, type MockUpstream } from "./helpers/http-server.js";
import type { HttpServerHandle } from "../src/index.js";
import { generateToolsFromSpec } from "../src/openapi-to-mcp.js";

/**
 * #285 (#279 C1): the 8 incident tools over the real in-process HTTP transport
 * against a mock Label Cloud upstream. No dev/prod network calls.
 */

const KEY = "incident-test-key";
const CHECKSUMMED = "0x6Fe9Ef9d42595682A555698b6b2a68bd4495AeA3";
const LOWERCASE = CHECKSUMMED.toLowerCase();
const INCIDENT_ID = "11111111-2222-3333-4444-555555555555";

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
  const body = result.body as { result?: ToolResult };
  assert.ok(body.result, `tools/call returned no result: ${JSON.stringify(body)}`);
  return body.result;
}

afterEach(async () => {
  await handle.close();
  await upstream.close();
});

interface ListedTool {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

describe("#285 tools/list", () => {
  it("T-L: 8 incident tools, required sets, update has no tag, annotations, count 24", async () => {
    await startWith(reply(200, {}));
    const result = await rpc2026(handle.url, { method: "tools/list", id: 1 });
    const tools = (result.body as { result: { tools: ListedTool[] } }).result.tools;
    assert.strictEqual(tools.length, 24);
    const byName = new Map(tools.map((t) => [t.name, t]));

    const required: Record<string, string[]> = {
      create_incident: ["incidentDate", "name"],
      get_incident: ["incidentId"],
      get_incident_by_tag: ["tag"],
      search_incidents: [],
      update_incident: ["incidentId"],
      delete_incident: ["incidentId"],
      get_incident_addresses: ["incidentId"],
      get_address_incidents: ["address"],
    };
    for (const [name, req] of Object.entries(required)) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} should be listed`);
      assert.deepStrictEqual([...(tool.inputSchema.required ?? [])].sort(), req, name);
    }

    // Selector control: create_incident DOES expose tag, so "update has no tag" can fail.
    assert.ok("tag" in byName.get("create_incident")!.inputSchema.properties);
    assert.ok(!("tag" in byName.get("update_incident")!.inputSchema.properties));
    assert.deepStrictEqual(Object.keys(byName.get("search_incidents")!.inputSchema.properties).sort(), [
      "cursor",
      "isPublicInfo",
      "limit",
      "name",
      "status",
    ]);

    for (const name of ["get_incident", "get_incident_by_tag", "search_incidents", "get_incident_addresses", "get_address_incidents"]) {
      assert.strictEqual(byName.get(name)!.annotations?.readOnlyHint, true, name);
    }
    for (const name of ["create_incident", "update_incident"]) {
      assert.deepStrictEqual(byName.get(name)!.annotations, { readOnlyHint: false, destructiveHint: false }, name);
    }
    assert.deepStrictEqual(byName.get("delete_incident")!.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
    });

    const create = byName.get("create_incident")!.description;
    assert.ok(create.includes("LabelSniffer carries only public incidents and private incidents owned by the org `amlbot`."));
    assert.ok(create.includes("LabelSniffer (a.k.a. auto-tracer, a.k.a. auto-label-propagation)"));
    assert.ok(create.includes("its date part must equal `incidentDate` written as yyyymmdd"));
    assert.strictEqual(byName.get("rename_incident"), undefined);
  });
});

describe("#285 wire shapes", () => {
  it("T-B: create_incident POSTs all 6 fields as the JSON body", async () => {
    await startWith(reply(201, { id: INCIDENT_ID }));
    const args = {
      name: "S33 test",
      incidentDate: "2026-11-06",
      isPublicInfo: false,
      description: "d",
      reference: "https://example.org/r",
      tag: "incident.s33_test.20261106",
    };
    const result = await call("create_incident", args);
    assert.strictEqual(result.isError, undefined);
    const hit = upstream.hits[0]!;
    assert.strictEqual(hit.method, "POST");
    assert.strictEqual(hit.url, "/v1/black-list/incidents");
    assert.deepStrictEqual(JSON.parse(hit.body), args);
  });

  it("T-B control: an inline (non-$ref) body schema yields no properties", async () => {
    await startWith(reply(200, {})); // only so the shared afterEach has a server to close
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/v1/black-list/incidents": {
          post: {
            operationId: "IncidentsController_create",
            parameters: [],
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } },
            },
            responses: {},
          },
        },
      },
      components: { schemas: {} },
    };
    const { tools } = generateToolsFromSpec(spec);
    const tool = tools.find((t) => t.name === "create_incident")!;
    assert.deepStrictEqual(Object.keys(tool.inputSchema.properties), []);
  });

  it("T-U: update_incident PATCHes only the passed fields to the id path", async () => {
    await startWith(reply(200, { id: INCIDENT_ID }));
    await call("update_incident", { incidentId: INCIDENT_ID, description: "new" });
    const hit = upstream.hits[0]!;
    assert.strictEqual(hit.method, "PATCH");
    assert.strictEqual(hit.url, `/v1/black-list/incidents/${INCIDENT_ID}`);
    assert.deepStrictEqual(JSON.parse(hit.body), { description: "new" });
  });

  it("T-T: get_incident_by_tag sends a dotted tag as-is; '..' is refused locally", async () => {
    await startWith(reply(200, { id: INCIDENT_ID }));
    await call("get_incident_by_tag", { tag: "incident.binance_hack.20261030" });
    assert.strictEqual(upstream.hits[0]!.method, "GET");
    assert.strictEqual(upstream.hits[0]!.url, "/v1/black-list/incidents/by-tag/incident.binance_hack.20261030");

    const bad = await call("get_incident_by_tag", { tag: ".." }, 2);
    assert.strictEqual(bad.isError, true);
    assert.strictEqual(upstream.hits.length, 1);
  });

  it("T-S: search_incidents forwards status, limit and cursor; the {items,nextCursor} body passes through", async () => {
    const page = { items: [], nextCursor: "a+b/c==" };
    await startWith(reply(200, page));
    const result = await call("search_incidents", {
      status: "DELETED",
      limit: 7,
      cursor: "x+y/z==",
      isPublicInfo: false,
      name: "s33",
    });
    assert.deepStrictEqual(JSON.parse(result.content[0]!.text), page);
    const url = new URL(upstream.hits[0]!.url, "http://x");
    assert.strictEqual(url.pathname, "/v1/black-list/incidents");
    assert.strictEqual(url.searchParams.get("status"), "DELETED");
    assert.strictEqual(url.searchParams.get("limit"), "7");
    assert.strictEqual(url.searchParams.get("cursor"), "x+y/z==");
    assert.strictEqual(url.searchParams.get("isPublicInfo"), "false");
    assert.strictEqual(url.searchParams.get("name"), "s33");
  });

  it("T-C: get_incident_addresses round-trips a cursor with +/= exactly and forwards limit", async () => {
    await startWith(reply(200, { items: [], nextCursor: null }));
    await call("get_incident_addresses", { incidentId: INCIDENT_ID, limit: 5, cursor: "ab+/cd==" });
    const hit = upstream.hits[0]!;
    const url = new URL(hit.url, "http://x");
    assert.strictEqual(url.pathname, `/v1/black-list/incidents/${INCIDENT_ID}/addresses`);
    assert.strictEqual(url.searchParams.get("cursor"), "ab+/cd==");
    assert.strictEqual(url.searchParams.get("limit"), "5");
  });

  it("T-A: get_address_incidents lowercases a checksummed EVM address, keeps others byte-exact", async () => {
    await startWith(reply(200, { items: [] }));
    await call("get_address_incidents", { address: CHECKSUMMED, network: "evm_eoa" });
    assert.strictEqual(upstream.hits[0]!.url, `/v1/black-list/addresses/${LOWERCASE}/incidents?network=evm_eoa`);
    await call("get_address_incidents", { address: "s33t2-X", network: "bitcoin" }, 2);
    assert.strictEqual(upstream.hits[1]!.url, "/v1/black-list/addresses/s33t2-X/incidents?network=bitcoin");
  });

  it("T-E: delete_incident 204 -> null; upstream 404 / 409 -> isError", async () => {
    await startWith(reply(204));
    const ok = await call("delete_incident", { incidentId: INCIDENT_ID });
    assert.strictEqual(ok.isError, undefined);
    assert.strictEqual(ok.content[0]!.text, "null");
    assert.strictEqual(upstream.hits[0]!.method, "DELETE");
    await upstream.close();
    await handle.close();

    await startWith(reply(404, { message: "not found" }));
    const nf = await call("delete_incident", { incidentId: INCIDENT_ID });
    assert.strictEqual(nf.isError, true);
    assert.match(nf.content[0]!.text, /API error 404/);
    await upstream.close();
    await handle.close();

    await startWith(reply(409, { message: "dup" }));
    const dup = await call("create_incident", { name: "n", incidentDate: "2026-11-06" });
    assert.strictEqual(dup.isError, true);
    assert.match(dup.content[0]!.text, /API error 409/);
  });
});

describe("#285 incidentId path parameter", () => {
  it("T-P: the 5 path-param incident tools send the exact method, URL and body", async () => {
    await startWith(reply(200, {}));
    await call("get_incident", { incidentId: INCIDENT_ID }, 1);
    await call("update_incident", { incidentId: INCIDENT_ID, name: "n2", isPublicInfo: false }, 2);
    await call("delete_incident", { incidentId: INCIDENT_ID }, 3);
    await call("get_incident_addresses", { incidentId: INCIDENT_ID, limit: 5, cursor: "c1" }, 4);
    await call("get_incident_by_tag", { tag: "incident.s33_test.20261106" }, 5);
    const base = "/v1/black-list/incidents";
    assert.deepStrictEqual(
      upstream.hits.map((h) => [h.method, h.url, h.body === "" ? null : JSON.parse(h.body)]),
      [
        ["GET", `${base}/${INCIDENT_ID}`, null],
        ["PATCH", `${base}/${INCIDENT_ID}`, { name: "n2", isPublicInfo: false }],
        ["DELETE", `${base}/${INCIDENT_ID}`, null],
        ["GET", `${base}/${INCIDENT_ID}/addresses?limit=5&cursor=c1`, null],
        ["GET", `${base}/by-tag/incident.s33_test.20261106`, null],
      ]
    );
  });

  it("T-M: a missing or empty incidentId is a local error and sends nothing upstream", async () => {
    await startWith(reply(200, {}));
    let id = 1;
    for (const name of ["get_incident", "update_incident", "delete_incident", "get_incident_addresses"]) {
      for (const args of [{}, { incidentId: "" }, { id: INCIDENT_ID }]) {
        const r = await call(name, args, id++);
        assert.strictEqual(r.isError, true, `${name} ${JSON.stringify(args)}`);
        assert.match(r.content[0]!.text, /missing required argument incidentId/, name);
      }
    }
    assert.strictEqual(upstream.hits.length, 0);
  });
});
