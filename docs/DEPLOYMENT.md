# Deployment

## Branch flow

This repo follows the standard `feat/… → dev → main` flow (see the org-wide
`git-branching` rule): branch off `dev`, PR into `dev`, verify, then PR `dev` into
`main`. Never commit directly to `dev` or `main`.

There is currently **one** running instance of this server — `mcp-labelcloud.service`,
tracking `main` — and no separately-deployed "dev" instance of the MCP server itself.
"Dev" for this repo means pointing `BLACKLIST_API_URL` at the Blacklist API's dev host
(`https://api-blacklist.amlbot.rocks`) while running the server or test suite locally,
not a second deployed copy of this server. `main` is deployed pointed at the
production Blacklist API (`https://api-blacklist.amlbot.com`, the default in
`src/index.ts` when `BLACKLIST_API_URL` is unset).

## Deploy mechanism (manual — no CI/CD in this repo)

There is no Jenkinsfile or GitHub Actions workflow here. The live instance is deployed
by hand:

```bash
cd /opt/mcp/labelcloud
git fetch && git checkout main && git pull
npm ci
npm run build
sudo systemctl restart mcp-labelcloud.service
```

The service is defined in `/etc/systemd/system/mcp-labelcloud.service`: it runs
`supergateway --stdio "node dist/index.js"` as the `mcp` user, exposing the stdio MCP
server over streamable HTTP on `127.0.0.1:9102/mcp`. Its `BLACKLIST_API_KEY` /
`BLACKLIST_API_URL` come from `EnvironmentFile=/etc/serverroom/mcp/labelcloud.env`
(prod key + prod URL, or omitted URL to fall through to the prod default) — never from
a `.env` file inside the repo.

## Running tests against dev

The test suite creates and deletes real rows, so it refuses to run unless
`BLACKLIST_API_URL` resolves to the dev API host. `test/helpers/dev-endpoint.ts` mirrors
`src/index.ts`'s own resolution (`BLACKLIST_API_URL || <prod default>`) and throws at
import time if that isn't `https://api-blacklist.amlbot.rocks`. Run tests like:

```bash
BLACKLIST_API_URL=https://api-blacklist.amlbot.rocks \
BLACKLIST_API_KEY=<a dev-org API key> \
npm test
```

`npm run build` first if you've touched `src/` — the MCP-spawning tests exec
`dist/index.js`, not the TypeScript source. Never point this suite at
`https://api-blacklist.amlbot.com`.

## Node version

The sandbox this repo is developed in defaults to Node 24, which works fine for this
server and its test suite (no native-addon dependencies). No `engines` field is pinned
in `package.json` — don't add one; other repos in this org (e.g.
`blacklist-service-backend`) pin to Node 18 for a `gremlin`/`ws` compatibility
constraint that does not apply here.
