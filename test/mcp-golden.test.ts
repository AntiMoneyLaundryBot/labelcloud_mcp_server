import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startInProcess, legacyTransport, rpc2026 } from "./helpers/http-server.js";
import type { HttpServerHandle } from "../src/index.js";

/**
 * AC-1: the tools/list contract is byte-identical to the 1.x golden, on both
 * the 2026-07-28 raw wire path and the 2025-11-25 v1-client path. Makes no
 * upstream call (tools/list never touches Label Cloud), so BLACKLIST_API_URL
 * is left pointing at an unreachable port rather than a real backend.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(path.join(__dirname, "golden", "tools-list-1x.json"), "utf8")
) as Array<{ name: string; description: string; inputSchema: unknown }>;

interface ProjectableTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

function project(tools: ProjectableTool[]): ProjectableTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

let handle: HttpServerHandle;

before(async () => {
  process.env.BLACKLIST_API_URL = "http://127.0.0.1:1";
  handle = await startInProcess();
});

after(async () => {
  await handle.close();
});

describe("AC-1: tools/list contract is byte-identical to the 1.x golden", () => {
  it("a raw 2026-07-28 tools/list matches the golden, 14 entries in order", async () => {
    const result = await rpc2026(handle.url, { method: "tools/list", id: 1 });
    assert.strictEqual(result.status, 200);
    const body = result.body as { result: { tools: ProjectableTool[] } };
    const projected = project(body.result.tools);
    assert.strictEqual(projected.length, 14);
    assert.deepStrictEqual(projected, golden);
  });

  it("a v1 (2025-11-25) client's listTools() matches the golden", async () => {
    const client = new Client({ name: "golden-check", version: "1.0.0" });
    await client.connect(legacyTransport(handle.url));
    try {
      const result = await client.listTools();
      const projected = project(result.tools as ProjectableTool[]);
      assert.strictEqual(projected.length, 14);
      assert.deepStrictEqual(projected, golden);
    } finally {
      await client.close();
    }
  });

  it("selector control: a two-entry swap must NOT deep-equal the golden", () => {
    const mutated = golden.map((t) => ({ ...t }));
    [mutated[0], mutated[1]] = [mutated[1], mutated[0]];
    assert.notDeepStrictEqual(mutated, golden);
  });
});
