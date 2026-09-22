#!/usr/bin/env node
// Golden tools/list snapshot: spawns the server over stdio and speaks raw
// newline-delimited JSON-RPC (not the SDK Client), so client-side Zod
// parsing cannot reshape the baseline. Used both to capture the 1.x golden
// and, via --entry, to re-run the same probe against the v2 stdio path.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { entry: resolve(__dirname, "../../dist/index.js"), out: resolve(__dirname, "tools-list-1x.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--entry") out.entry = resolve(argv[++i]);
    else if (argv[i] === "--out") out.out = resolve(argv[++i]);
  }
  return out;
}

const { entry, out } = parseArgs(process.argv.slice(2));

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

function notification(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
}

async function main() {
  const child = spawn(process.execPath, [entry], {
    cwd: os.tmpdir(),
    env: {
      PATH: process.env.PATH,
      BLACKLIST_API_URL: "https://api-blacklist.amlbot.rocks",
      BLACKLIST_API_KEY: "golden-snapshot-no-upstream-call",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  function call(id, method, params) {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(rpc(id, method, params));
    });
  }

  const timeout = setTimeout(() => {
    console.error("Timed out after 15s. stderr so far:\n" + stderr);
    child.kill("SIGKILL");
    process.exit(1);
  }, 15_000);
  timeout.unref?.();

  try {
    await call(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "golden-snapshot", version: "1.0.0" },
    });
    child.stdin.write(notification("notifications/initialized", {}));
    const listResp = await call(2, "tools/list", {});

    if (listResp.error) {
      throw new Error(`tools/list returned an error: ${JSON.stringify(listResp.error)}`);
    }

    const tools = listResp.result.tools;
    const projected = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    if (projected.length !== 14) {
      throw new Error(`Expected 14 tools, got ${projected.length}: ${projected.map((t) => t.name).join(",")}`);
    }

    writeFileSync(out, JSON.stringify(projected, null, 2) + "\n");
    console.log(`14 tools: ${projected.map((t) => t.name).join(",")}`);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
