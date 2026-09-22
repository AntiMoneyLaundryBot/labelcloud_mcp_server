# Deployment

## Branch flow and Definition of Done

This repo follows the standard `feat/… → dev → main` flow (see the org-wide `git-flow`
skill): branch off `dev`, PR into `dev`, verify, then PR `dev` into `main`. Never commit
directly to `dev` or `main`.

**A change to this repo is done only when it has landed on both `dev` and `main`** — see
`.claude/rules/labelcloud-mcp-delivery-process.md`. Landing on `dev` alone, or sitting on a
feature branch, is not done, and must never be signalled as complete to the operator, the
TeamLead, a deployment agent, or in a `workdone` doc. Verify before any completion signal:

```bash
git fetch origin
git branch -r --contains <tip-sha>            # must list origin/dev AND origin/main
git log --oneline origin/main..origin/dev     # empty once main has caught up
git diff --quiet origin/dev origin/main
```

There is no dev **environment** distinct from this process, though — see "Two environments"
below, which is new as of #180 (v2.0.0) and replaces the single always-`main` instance this
doc described previously. Prod testing is cheap and is the accepted verification path; the
absence of a separate staging environment is never a reason to skip verification or call
work done early.

## Two environments

As of v2.0.0 the server runs as a Streamable HTTP service (MCP protocol `2026-07-28`, with a
2025-11-25 legacy fallback — see "Consumer auth" below), deployed by Jenkins from a Docker
image, one instance per environment:

| | Dev | Prod |
|---|---|---|
| Host | `94.130.51.230` | `162.55.129.53` |
| Port | `9180` (`→ 3000` in-container) | `9180` (`→ 3000` in-container) |
| Upstream `BLACKLIST_API_URL` | `https://api-blacklist.amlbot.rocks` | `https://api-blacklist.amlbot.com` (default) |
| Image tag | `registry.digitalocean.com/machekhinasked/labelcloud-mcp:dev` | `…:prod` |
| Jenkins job | `Dev-App/labelcloud-mcp` (`Jenkinsfile`, tracks `origin/dev`) | `Prod-App/labelcloud-mcp` (`Jenkinsfile-prod`, tracks `origin/main`) |
| Trigger | PR merged into `dev`, or a manual `run-dev` build | A release tag matching `^v\d+\.\d+\.\d+(-rc\.\d+)?$`, published on `main` |

Both jobs also build and push a `<short-sha>` (dev) or `<tag>` (prod) image tag alongside the
floating `dev`/`prod` tag, and run a post-deploy probe (`curl` on `/mcp`, must return `405`)
that fails the build if the freshly deployed container isn't answering.

Cutting the `v2.0.0` release tag — and therefore triggering the Prod-App build — is
operator-owned (`origin/main` and prod Jenkins jobs are operator-owned per standards rule 11).
The implementor opens the `dev`→`main` PR and drafts the release; the operator, or the TL on
the operator's explicit go, merges and publishes the tag.

Deploying the image on each host is `docker-compose`-managed from
`/root/docker-compose/labelcloud-mcp/docker-compose.yaml`, copied from
`docker-compose.reference.yaml` in this repo with the `# prod:` lines swapped. That reference
file's header comment is deliberately worded so the literal string `BLACKLIST_API_KEY` never
appears in it — a compose file that fails a `grep -c BLACKLIST_API_KEY` check has a key baked
in and should not be deployed.

## Runtime environment

The container/process reads:

- `BLACKLIST_API_URL` — the Label Cloud API host. Defaults to
  `https://api-blacklist.amlbot.com` (prod) if unset.
- `MCP_ALLOWED_HOSTS` — comma-separated `Host`/`Origin` allow-list for the HTTP transport.
  **Hostnames only — any `:port` suffix is stripped before matching**, so
  `94.130.51.230:9180` and `94.130.51.230` are equivalent entries. `localhost`, `127.0.0.1`
  and `[::1]` are always allowed, for the container healthcheck and the deploy probe. A
  request with a `Host`/`Origin` outside this list gets `403` before any dispatch.
- `MCP_HOST` (default `127.0.0.1`, set to `0.0.0.0` in the image) and `MCP_PORT` (default
  `3000`) — the HTTP listener's bind address and port.

**There is no `BLACKLIST_API_KEY` in this environment, ever.** The HTTP server holds no
Label Cloud key of its own — every consumer sends its own (see "Consumer auth"). If
`BLACKLIST_API_KEY` is set in the process environment when HTTP mode starts — including via
a local `.env` picked up by `dotenv.config()` — the server refuses to start and exits
non-zero, logging why. This is fail-closed by design: a leftover key in the environment is a
configuration bug, not a fallback credential, and letting the server start anyway would mean
outbound calls could reuse someone else's key. `BLACKLIST_API_KEY` is still read, and still
required, in **stdio** mode (see "Local stdio mode" below) — stdio has exactly one consumer
per process, so a single held key is safe there.

## Consumer auth

Each HTTP consumer authenticates with its own Label Cloud API key, sent per-request:

- `Authorization: Bearer <key>`, or
- `X-Api-Key: <key>` (checked if no `Authorization` header matched).

The key is never stored server-side, never cached across requests, and never logged. It is
attached fresh to each `tools/call` and passed straight through to the Label Cloud API as
that request's `X-Api-Key`.

- No key on a `tools/call` → `401` with `WWW-Authenticate: Bearer realm="labelcloud-mcp"` and
  a JSON-RPC `-32001` error, before any upstream call is made. `initialize`, `tools/list` and
  `server/discover` need no key.
- A key the Label Cloud API rejects → the request still reaches the server (`200` at the
  transport level), but the tool result comes back as `isError: true` with the upstream's
  `API error 403: …` text. There is no local pre-check of key validity.

Point an MCP client at either instance with:

```bash
claude mcp add --transport http labelcloud http://<host>:9180/mcp \
  --header "Authorization: Bearer <your Label Cloud API key>"
```

A 2025-11-25-era client (including today's Claude Code over the legacy path) still connects
and lists all 14 tools — the server serves both protocol eras from the same handler, and the
tool contract is byte-identical between them (see the `mcp-golden.test.ts` / AC-1 check).
2026-07-28 requests additionally get JSON responses (`responseMode: "json"`), `tools/list`
cache hints (`ttlMs`/`cacheScope`), and per-tool `readOnlyHint`/`destructiveHint`
annotations; 2025-era requests never see these fields, and get a one-event
`text/event-stream` reply instead of a plain JSON one — that's an SDK behaviour for the
legacy path, not something this server can turn off for pre-2026 clients.

## Probes

From outside the host (the `Host` allow-list is enforced, so a probe from the deploy target
itself doesn't exercise it the same way a real client request would):

```bash
curl -sI http://<host>:9180/mcp                       # → 405 (the transport only answers POST)
curl -s http://<host>:9180/mcp -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}'   # → supportedVersions includes 2026-07-28
curl -s http://<host>:9180/mcp -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'         # → 14 tools, no key needed
```

The in-container `HEALTHCHECK` runs the same `405`-on-GET check.

## Edge follow-ups (devops, not in this sprint)

Two items are documented here but intentionally not implemented in #180:

- Logging the `Mcp-Method`/`Mcp-Name` request headers at the edge, for per-tool traffic
  visibility ahead of anything this server does internally.
- Rate limiting. The 2026-07-28 `subscriptions/listen` method is inert on this server (no
  tool emits notifications), but it still opens a keep-alive SSE stream per call, up to the
  SDK's `maxSubscriptions` (1024) — worth a limit at the edge before that's reachable from
  the open internet.

## Rollback

```bash
docker-compose -f /root/docker-compose/labelcloud-mcp/docker-compose.yaml down
```

The 1.x systemd unit (see below) is the control: it is untouched by this work and keeps
running throughout, so a rollback of the new HTTP deployment does not affect it.

## Status of the 1.x unit on `mini`

Before #180, `mcp-labelcloud.service` was the only running instance, deployed by hand (see
"Local stdio mode" below for the equivalent manual flow). It runs
`supergateway --stdio "node dist/index.js"` as the `mcp` user, exposing the stdio server over
streamable HTTP on **`*:9102/mcp`** (not `127.0.0.1:9102` as an earlier version of this doc
said — it listens on all interfaces). Its `BLACKLIST_API_KEY`/`BLACKLIST_API_URL` come from
`EnvironmentFile=/etc/serverroom/mcp/labelcloud.env` — a single shared key, never a `.env`
file inside the repo.

This unit is **untouched by #180** and keeps running in parallel with the new dev/prod HTTP
instances above. Per HT-3, it is retired once the dev/prod instances have carried real
traffic and the `mini` unit has logged 7 consecutive days of zero traffic — not before, and
not automatically.

## Local stdio mode

For local development or a single-consumer stdio deployment, `BLACKLIST_API_KEY` is required
(the server exits at startup if it's missing) and `npm start` runs the server on stdio:

```bash
cp .env.example .env      # then fill in BLACKLIST_API_KEY (and BLACKLIST_API_URL if not prod)
npm install
npm run build
npm start
```

## Running tests

The test suite runs primarily against the in-process HTTP transport and needs no network
access for most suites. A handful of suites run against the real dev Label Cloud API and are
dev-pinned — they refuse to run unless `BLACKLIST_API_URL` resolves to
`https://api-blacklist.amlbot.rocks` (`test/helpers/dev-endpoint.ts` checks this against the
same resolution `resolveApiUrl()` in `src/index.ts` uses, and throws at import time
otherwise). Run the full suite with:

```bash
npm run build
BLACKLIST_API_URL=https://api-blacklist.amlbot.rocks \
BLACKLIST_API_KEY=<a dev-org API key> \
npm test
```

`npm run build` first if you've touched `src/` — the dev-pinned suites exec `dist/index.js`,
not the TypeScript source, and the HTTP-transport suites import from `dist/` too. Never point
this suite at `https://api-blacklist.amlbot.com`.

Set `MCP_TEST_URL` to point the dev-pinned live suites at a deployed instance instead of
spawning one in-process — used to verify the dev instance itself post-deploy:

```bash
MCP_TEST_URL=http://94.130.51.230:9180/mcp \
BLACKLIST_API_KEY=<a dev-org API key> \
npm test
```

`MCP_TEST_URL` is checked against an allow-list (`127.0.0.1`, `localhost`,
`94.130.51.230`, `*.amlbot.rocks`) and refused otherwise — in particular it will not connect
to the prod host.

## Backend prerequisites per feature

`set_auto_tracing` / `get_auto_tracer_data` (Peppermint #172,
`SPEC-2026-09-18-labelcloud-mcp-auto-tracing-tools`) need **no backend change**:
both are composites over the `GET`/`POST /v1/black-list/addresses` operations this
server already calls. A redeploy of this MCP server is sufficient to ship them — no
blacklist-service-backend release, no new route, no `docs/blacklist-api-endpoints.json`
change.

`get_auto_tracer_data` / `set_auto_tracing` EVM address canonicalization (Peppermint #176,
`SPEC-2026-09-21-labelcloud-mcp-evm-address-canonical`) needs **no backend change** either:
it lowercases EVM-shaped input client-side, before the existing calls, working around a
backend defect (filed separately) rather than depending on a fix for it. A redeploy alone
ships it.

The v2 remote-HTTP port (Peppermint #180, `v2.0.0`) needs **no backend change**: it is a
transport and deployment change only, the tool set and its request/response shapes are
byte-identical to 1.x (see AC-1 / `mcp-golden.test.ts`).

## Node version

The image runs **Node 24** (`node:24-bookworm-slim`, both build and runtime stages of the
`Dockerfile`), which satisfies the `@modelcontextprotocol/server`/`node` packages' Node 20+
floor. No `engines` field is pinned in `package.json` — don't add one; other repos in this
org (e.g. `blacklist-service-backend`) pin to Node 18 for a `gremlin`/`ws` compatibility
constraint that does not apply here.
