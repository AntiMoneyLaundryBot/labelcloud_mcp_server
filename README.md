<!--
  Documented at origin/dev 74022f461a6c56cea36883a2b459bf57b47a343d (labelcloud_mcp_server, package version 2.2.0).
  Tool parameters are derived from docs/blacklist-api-endpoints.json through the rules in
  src/openapi-to-mcp.ts:187-307 and the per-tool settings in src/tool-config.ts.
  Backend references point to blacklist-service-backend origin/dev 893fd5a8a5cc60294846a0c7865f7371a8cb1832.
-->

# Label Cloud MCP server (v2.2.0)

An MCP server that exposes the AMLBot Label Cloud API (`blacklist-service-backend`) as **24 tools**: address labels,
LabelSniffer flags and propagation trees, address tags, entities, incidents and reference data
(`package.json:3`, `src/tool-annotations.ts:73-90`).

It stores nothing. Every tool is one or two HTTP calls to the Label Cloud API with the caller's key
(`src/index.ts:83-112`). For what those calls read and write, see the backend docs
(§ Data contract below).

## How it works

- `docs/blacklist-api-endpoints.json` is a snapshot of the backend's OpenAPI spec. Tool input schemas are generated from
  it at start-up (`src/index.ts:30-37`).
- `src/tool-config.ts` chooses which `operationId`s become tools, their names and descriptions, and per-tool
  `presetArgs` (hidden fixed values), `argAliases` (renamed inputs) and `omitArgs` (hidden inputs).
- `set_auto_tracing` is hand-written (`src/set-auto-tracing.ts`): read the address, refuse if absent/ambiguous,
  re-post it with only `enableSniffer` changed, read it again.
- For `get_auto_tracer_data`, `add_address_tag`, `remove_address_tag` and `get_address_incidents` an EVM-shaped
  `address` on an EVM network (or with no network) is lowercased before the call (`src/address-canonical.ts`).
  `search_addresses` and the write tools send the address as given.
- Path values containing a `.` or `..` segment are rejected locally (`src/openapi-to-mcp.ts:363-377`); an empty
  required path value fails locally with `missing required argument <name>` (`src/index.ts:165-176`).
- Results come back as the backend's JSON body as text. A non-2xx answer becomes a tool error
  `Error: API error <status>: <body>` (`src/index.ts:104-107`, `:230-241`). Empty bodies (204) return `null`.

## Install and run

```bash
npm install
npm run build
npm run start:http    # HTTP (Streamable HTTP), the deployed mode
npm start             # stdio, single consumer
npm test
```

### Environment variables (names only)

| Variable | Mode | Meaning | Source |
|---|---|---|---|
| `BLACKLIST_API_URL` | both | Label Cloud API base URL. stdio default `https://api-blacklist.amlbot.com` (prod). **HTTP mode refuses to start if unset.** | `src/index.ts:32-34`, `:338-343` |
| `BLACKLIST_API_KEY` | stdio only | the single Label Cloud key used for every call; required in stdio. **HTTP mode refuses to start if it is set.** | `src/index.ts:247-255`, `:332-337` |
| `MCP_HOST` / `MCP_PORT` | HTTP | listen address / port (defaults `127.0.0.1` / `3000`; the image sets `0.0.0.0`) | `src/index.ts:345-346`, `Dockerfile:16-17` |
| `MCP_ALLOWED_HOSTS` | HTTP | comma-separated hostnames allowed in `Host`/`Origin` (ports stripped); loopback always allowed | `src/index.ts:292-303` |

### Deployed instances (`docs/DEPLOYMENT.md:33-40`)

| | Dev | Prod |
|---|---|---|
| MCP endpoint | `http://94.130.51.230:9180/mcp` | `http://162.55.129.53:9180/mcp` |
| Upstream Label Cloud | `https://api-blacklist.amlbot.rocks` | `https://api-blacklist.amlbot.com` |

### Auth (HTTP mode)

Send your own Label Cloud API key on every request (`src/index.ts:264-274`):

- `Authorization: Bearer <key>`, or
- `X-Api-Key: <key>` (used when no Bearer header matched).

The server forwards it upstream as `X-Api-Key` (`src/index.ts:92-96`) and never stores or logs it. A `tools/call`
without a key gets HTTP 401, `WWW-Authenticate: Bearer realm="labelcloud-mcp"`, JSON-RPC error `-32001`
(`src/index.ts:390-406`). `initialize` and `tools/list` need no key. A key the backend rejects comes back as a tool
error `API error 403: …`. What a key may do is decided by its Label Cloud role (backend `docs/API.md` §1).

```bash
claude mcp add --transport http labelcloud http://<host>:9180/mcp \
  --header "Authorization: Bearer <your Label Cloud API key>"
```

Only `POST /mcp` is served (GET → 405, other paths → 404, body > 1 MiB → 413) (`src/index.ts:358-380`).

## Tools

All backend paths are under `/v1/black-list`. "R/W/D" = the tool's MCP annotation: read-only, write, destructive
(`src/tool-annotations.ts:6-43`). Network enum = the 65 values of the backend `NETWORKS` list (get them with
`get_networks`). Types: `string[]` means repeat the value; `number` inputs are sent as query strings.

### Address labels

| Tool | R/W/D | Backend call | Parameters (type, **required**) | Notes |
|---|---|---|---|---|
| `create_address` | W | `POST /addresses` | **`address`** string; **`network`** network enum; **`isPublicInfo`** boolean; `type` string (*backend rejects a missing type with 400*); `description`, `subType`, `reference` string; `entityId` string (UUID); `enableSniffer` boolean; `originAddress`, `previousAddress`, `txHash`, `txBlockchain` string; `txTimestamp` string (ISO-8601) | Full upsert of the caller org's row: omitted `entityId`/`description`/… are written as null. The 4 provenance fields go together. Use `set_auto_tracing` to change only the flag. |
| `search_addresses` | R | `GET /addresses` | **`address`** string; `blockchains` string[] (network enum); `statuses` string[] (`ACTIVE`,`DELETED`); `entityId` string (ignored by the backend); `fields` string[] (`address, network, description, type, subType, reference, fileLink, entityId, publicInfo, organization, enableSniffer, originAddress, previousAddress, txHash, txBlockchain, txTimestamp`) | Returns `{publicBlacklist, privateBlacklist, tags}`. The entity id is returned as `entity_id`. |
| `get_auto_tracer_data` | R | `GET /addresses` | **`address`** string; `network` string (network enum) → sent as `blockchains=[network]` | Preset, hidden: `fields=[enableSniffer, originAddress, previousAddress, txHash, txBlockchain, txTimestamp]`, `statuses=[ACTIVE]`; `entityId` hidden (`src/tool-config.ts:81-104`). |
| `set_auto_tracing` | W | `GET /addresses` → `POST /addresses` → `GET /addresses` | **`address`** string; **`network`** string (must equal the stored network); **`enableSniffer`** boolean (`src/index.ts:48-70`) | Refuses if no ACTIVE row, more than one row across orgs, or the row lacks `type`/`publicInfo`. Re-posts `address, network, isPublicInfo, description, type, subType, reference, entityId, enableSniffer`; provenance fields are not sent, so they are kept. Returns `{before, after}` (`src/set-auto-tracing.ts:93-186`). |
| `delete_address` | D | `DELETE /addresses/{address}` | **`address`** string; `network` string (network enum) | Soft delete of the caller org's row. Backend default network when omitted: `tron`. Returns `null`. |
| `get_entity_addresses` | R | `GET /addresses/entity/{entityId}` | **`entityId`** string (UUID); `fields` string[] (as above) | `{publicBlacklist, privateBlacklist}` |
| `get_addresses_by_origin` | R | `GET /addresses/origin/{originAddress}` | **`originAddress`** string; `limit` number (1-10000, default 10000); `offset` number (default 0) | Needs `read_address_global`. Returns `{edges:[{address, previousAddress, txHash, txBlockchain, txTimestamp}], count, limit, offset}`. |
| `get_addresses_by_previous` | R | `GET /addresses/previous/{previousAddress}` | **`previousAddress`** string; `limit` number; `offset` number | Direct children only; same shape and permission. |

### Address tags

| Tool | R/W/D | Backend call | Parameters | Notes |
|---|---|---|---|---|
| `add_address_tag` | W | `PUT /addresses/{address}/tags/{tag}?network=` | **`address`** string; **`tag`** string (`^[a-z0-9_]+(\.[a-z0-9_]+)*$`, 1-128); **`network`** string (network enum) | Returns `{address, network, tag, added}`; EVM stored as `evm_eoa`. `incident.*` tags need a visible ACTIVE incident holding the tag, else 404. |
| `remove_address_tag` | D | `DELETE /addresses/{address}/tags/{tag}?network=` | same as `add_address_tag` | Hard delete; returns `null`; 404 if absent or hidden. |

### Entities

| Tool | R/W/D | Backend call | Parameters | Notes |
|---|---|---|---|---|
| `create_entity` | W | `POST /entities` | **`name`** string; **`isPublicInfo`** boolean; `description`, `type`, `subType`, `reference` string | Backend validates `type` against `get_types`. Upsert on lowercase name + org. |
| `search_entities` | R | `GET /entities` | **`name`** string (required in the snapshot; optional in the backend); `type`, `subType` string; `statuses` string[] (`ACTIVE`,`DELETED`); `fields` string[] (`name, publicInfo, description, type, subType, reference`) | Name is a prefix match. Returns `{publicList, privateList}`. |
| `get_entity` | R | `GET /entities/{entityId}` | **`entityId`** string (UUID) | Backend requires a **write** permission for this route. |
| `delete_entity` | D | `DELETE /entities/{entityId}` | **`entityId`** string (UUID) | 400 if addresses are still linked. |

### Incidents

| Tool | R/W/D | Backend call | Parameters | Notes |
|---|---|---|---|---|
| `create_incident` | W | `POST /incidents` | **`name`** string (1-256); **`incidentDate`** string (`YYYY-MM-DD`); `isPublicInfo` boolean (default false); `description`, `reference` string; `tag` string | Tag generated as `incident.<slug>.<yyyymmdd>` if omitted. 400 bad tag/date, 403 public without `write_address_global`, 409 tag taken. |
| `get_incident` | R | `GET /incidents/{incidentId}` | **`incidentId`** string (UUID) | 404 absent or hidden. |
| `get_incident_by_tag` | R | `GET /incidents/by-tag/{tag}` | **`tag`** string | DELETED shown to owner org / global keys. |
| `search_incidents` | R | `GET /incidents` | `name` string; `status` string (`ACTIVE`/`DELETED`); `isPublicInfo` boolean; `limit` number (1-100, default 50); `cursor` string | Returns `{items, nextCursor}`; follow `nextCursor` until null (pages can be empty before the end). |
| `update_incident` | W | `PATCH /incidents/{incidentId}` | **`incidentId`** string; `name`, `description`, `incidentDate`, `reference` string; `isPublicInfo` boolean | `tag` is hidden (`omitArgs`, `src/tool-config.ts:232-239`). Changing `incidentDate` → 400. |
| `delete_incident` | D | `DELETE /incidents/{incidentId}` | **`incidentId`** string | Soft, idempotent; returns `null`; the tag stays on addresses. |
| `get_incident_addresses` | R | `GET /incidents/{incidentId}/addresses` | **`incidentId`** string; `limit` number (1-100, default 50); `cursor` string | Returns `{items:[{address, network, tag, createdAt, createdBy}], nextCursor}`. |
| `get_address_incidents` | R | `GET /addresses/{address}/incidents` | **`address`** string; `network` string (network enum) | Returns `{items:[{network, tag, incident}]}`; hidden address → `items: []`. |

### Reference data

| Tool | R/W/D | Backend call | Parameters | Returns |
|---|---|---|---|---|
| `get_networks` | R | `GET /networks` | none | `{networks: [...]}` |
| `get_types` | R | `GET /types` | none | `{types: [{category_type, description, code, severity}]}` |

### Backend routes not exposed
Accounts (`/v1/accounts/*`), address files, `GET /addresses/entity/{entityId}/paginate`, bulk export
(`/addresses/list/jobs`) and the legacy `GET /api/addresses/{address}` (`src/tool-config.ts:142-147`, `:276-334`; bulk
export is absent from the snapshot).

## Data contract

This server keeps no state and owns no storage. Each tool's effect on storage is the backend route's effect:

- routes, permissions, request/response shapes: `blacklist-service-backend/docs/API.md`
- tables, keys, writers/readers, retention: `blacklist-service-backend/docs/DATA-CONTRACTS.md`
  (labels §2.1, change log §2.2, entities §2.5, tags §2.6, incidents §2.7, request log §2.8 — every MCP call is
  logged there with user agent `labelcloud-mcp/2.2.0`, `src/index.ts:95`).

Keep `docs/blacklist-api-endpoints.json` in step with the backend: tool schemas come from it, not from the live
backend. Known differences at the SHAs above: `search_entities.name` is required here but optional in the backend;
`create_address.type` is optional here but required by backend validation.

## Adding a tool

1. Copy the new operation from the backend Swagger (`/api/docs`) into `docs/blacklist-api-endpoints.json`.
2. Add a `ToolConfig` entry with `include: true` in `src/tool-config.ts`.
3. Classify it in `src/tool-annotations.ts` and update the expected count (start-up throws otherwise).
4. `npm run build && npm test`. Done means merged to both `dev` and `main` (`docs/DEPLOYMENT.md:9-19`).

## UNVERIFIED
- The tool list and schemas were derived by reading the generator and the snapshot, not by calling `tools/list` on a
  running instance.
- Whether the deployed prod image is v2.2.0.

## Sources
Repo `labelcloud_mcp_server`, origin/dev `74022f461a6c56cea36883a2b459bf57b47a343d`: `src/index.ts`,
`src/tool-config.ts`, `src/openapi-to-mcp.ts`, `src/set-auto-tracing.ts`, `src/address-canonical.ts`,
`src/tool-annotations.ts`, `docs/blacklist-api-endpoints.json`, `docs/DEPLOYMENT.md`, `Dockerfile`, `package.json`.
Backend `blacklist-service-backend` origin/dev `893fd5a8a5cc60294846a0c7865f7371a8cb1832` for route behaviour.
