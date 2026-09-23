import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { connect } from "node:net";
import { startInProcess, mockUpstream, type MockUpstream } from "./helpers/http-server.js";
import type { HttpServerHandle } from "../src/index.js";

/**
 * Security-review Vuln 1 (Medium, unauthenticated remote crash): the request
 * handler used to build `new URL(req.url, http://${req.headers.host})`
 * before hostOk()/originOk() ran, and outside any try/catch. A malformed
 * Host header (e.g. "a b", containing a space) makes `new URL()` throw
 * ERR_INVALID_URL uncaught inside the async handler, which crashes the whole
 * process - a single unauthenticated request takes down the server for every
 * other consumer.
 *
 * Sends the malformed request over a raw socket (not fetch/http.request,
 * which would normalize or reject the header client-side before it ever hit
 * the wire) and then confirms the process is still alive by making a normal
 * follow-up request.
 */

let handle: HttpServerHandle;
let upstream: MockUpstream;

beforeEach(async () => {
  upstream = await mockUpstream((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  process.env.BLACKLIST_API_URL = upstream.url;
  handle = await startInProcess();
});

afterEach(async () => {
  await handle.close();
  await upstream.close();
});

function sendRawRequest(url: string, rawHeaders: string): Promise<{ status: number | undefined }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`POST /mcp HTTP/1.1\r\n${rawHeaders}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("end", () => {
      const statusLine = data.split("\r\n")[0] ?? "";
      const match = /HTTP\/1\.1 (\d+)/.exec(statusLine);
      resolve({ status: match ? Number(match[1]) : undefined });
    });
    socket.on("error", reject);
  });
}

describe("Vuln 1 regression: malformed Host header must not crash the process", () => {
  it("rejects a malformed Host with 4xx/5xx and leaves the server able to serve the next request", async () => {
    const malformed = await sendRawRequest(handle.url, "Host: a b\r\n");
    assert.ok(malformed.status !== undefined, "expected an HTTP response, not a dropped/reset connection");
    assert.ok(
      malformed.status! >= 400 && malformed.status! < 600,
      `expected a 4xx/5xx for the malformed Host, got ${malformed.status}`
    );

    const followUp = await fetch(handle.url, { method: "GET" });
    assert.strictEqual(followUp.status, 405, "the server must still be up and serving requests");
  });
});
