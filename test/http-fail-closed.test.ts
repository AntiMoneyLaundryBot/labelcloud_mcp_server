import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AC-5: the HTTP transport refuses to start at all if BLACKLIST_API_KEY is
 * set in the environment - the server never holds a Label Cloud key, so a
 * stray key surviving from stdio-mode use must fail closed, not silently
 * be ignored. Spawns the built dist/index.js (not the in-process helper),
 * since the failure under test is process exit itself.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(__dirname, "..", "dist", "index.js");

function runToExit(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distEntry, "--http"], {
      cwd: tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child did not exit within 5s; stderr so far: ${stderr}`));
    }, 5000);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

describe("AC-5: fail-closed HTTP transport on a stray BLACKLIST_API_KEY", () => {
  it("exits non-zero and names BLACKLIST_API_KEY when the key is set", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, BLACKLIST_API_KEY: "anything", MCP_PORT: "0" };
    const { code, stderr } = await runToExit(env);
    assert.notStrictEqual(code, 0, "the server must not start in HTTP mode with BLACKLIST_API_KEY set");
    assert.match(stderr, /BLACKLIST_API_KEY/);
  });

  it("control: without the key, the server starts and a GET /mcp returns 405", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, MCP_PORT: "0", BLACKLIST_API_URL: "http://127.0.0.1:1" };
    delete env.BLACKLIST_API_KEY;

    const child = spawn(process.execPath, [distEntry, "--http"], {
      cwd: tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => {
          reject(new Error(`server did not log its URL within 5s; stderr so far: ${stderr}`));
        }, 5000);
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
          const match = /HTTP on (http:\/\/\S+\/mcp)/.exec(stderr);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited early with code ${code}, stderr: ${stderr}`));
        });
      });

      const response = await fetch(url);
      assert.strictEqual(response.status, 405);
    } finally {
      child.kill();
    }
  });
});

describe("N-1: fail-closed HTTP transport without BLACKLIST_API_URL", () => {
  it("exits non-zero and names BLACKLIST_API_URL when it is unset", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, MCP_PORT: "0" };
    delete env.BLACKLIST_API_KEY;
    delete env.BLACKLIST_API_URL;
    const { code, stderr } = await runToExit(env);
    assert.notStrictEqual(code, 0, "the server must not start in HTTP mode without BLACKLIST_API_URL");
    assert.match(stderr, /BLACKLIST_API_URL/);
  });
});
