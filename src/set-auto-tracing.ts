/**
 * set_auto_tracing — composite tool over the existing GET/POST /addresses.
 *
 * Flips the `enableSniffer` flag (LabelSniffer / auto-tracer / auto-label-propagation)
 * on ONE existing address without a full-record upsert from the caller. Hand-written
 * (not generated from the OpenAPI allow-list) because it drives two calls and refuses
 * on ambiguous or absent rows before writing - see SPEC-2026-09-18-labelcloud-mcp-auto-tracing-tools
 * §"A3". No backend route: both calls are operations this server already exposes.
 */

const ADDRESSES_PATH = "/v1/black-list/addresses";

/** Every writable field, requested explicitly so the composite can merge the
 * stored record back on write. Matches the enum in docs/blacklist-api-endpoints.json. */
const AUTO_TRACING_READ_FIELDS = [
  "address",
  "network",
  "organization",
  "entityId",
  "type",
  "subType",
  "description",
  "reference",
  "publicInfo",
  "enableSniffer",
  "originAddress",
  "previousAddress",
  "txHash",
  "txBlockchain",
  "txTimestamp",
];

export interface SetAutoTracingArgs {
  address: string;
  network: string;
  enableSniffer: boolean;
}

export interface AddressRow {
  address?: string;
  network?: string;
  organization?: string;
  // The read side returns the entity id under its raw column name, not `entityId`
  // (RES_ADDRESS_FIELD_MAP has no entity_id -> entityId mapping; see #147 workdone).
  entity_id?: string | null;
  type?: string | null;
  subType?: string | null;
  description?: string | null;
  reference?: string | null;
  publicInfo?: boolean | null;
  enableSniffer?: boolean | null;
  originAddress?: string | null;
  previousAddress?: string | null;
  txHash?: string | null;
  txBlockchain?: string | null;
  txTimestamp?: string | null;
  [key: string]: unknown;
}

interface SearchAddressesResponse {
  publicBlacklist?: AddressRow[];
  privateBlacklist?: AddressRow[];
}

export type ApiRequestFn = (
  method: string,
  path: string,
  body?: unknown
) => Promise<unknown>;

function buildReadQuery(address: string, network: string): string {
  const params = new URLSearchParams();
  params.set("address", address);
  params.append("blockchains", network);
  // R-18: statuses=ACTIVE is explicit here, never inherited from the search default -
  // the refuse-on-not-found guarantee must not depend on what the backend defaults to.
  params.append("statuses", "ACTIVE");
  for (const field of AUTO_TRACING_READ_FIELDS) {
    params.append("fields", field);
  }
  return `${ADDRESSES_PATH}?${params.toString()}`;
}

/**
 * Fetch the single ACTIVE row for (address, network), deduped across the
 * public/private lists on (address, network, organization). Refuses (throws)
 * on zero rows, on more than one row (org-blind ambiguity), or on a row
 * missing `type`/`publicInfo` - never guesses, never creates, never
 * reactivates a DELETED row.
 */
async function fetchSingleActiveRow(
  apiRequest: ApiRequestFn,
  address: string,
  network: string
): Promise<AddressRow> {
  const result = (await apiRequest(
    "GET",
    buildReadQuery(address, network)
  )) as SearchAddressesResponse;

  const seen = new Set<string>();
  const rows: AddressRow[] = [];
  for (const row of [
    ...(result.publicBlacklist ?? []),
    ...(result.privateBlacklist ?? []),
  ]) {
    if (row.address !== address || row.network !== network) continue;
    const dedupeKey = `${row.address}|${row.network}|${row.organization}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push(row);
  }

  if (rows.length === 0) {
    throw new Error(
      `set_auto_tracing: no ACTIVE address found for "${address}" on network "${network}" - ` +
        "refusing (this tool never creates a row and never reactivates a DELETED one)."
    );
  }

  if (rows.length > 1) {
    throw new Error(
      `set_auto_tracing: ${rows.length} ACTIVE rows found for "${address}" on network "${network}" ` +
        "across organizations - refusing an ambiguous write."
    );
  }

  const row = rows[0];
  if (row.type === null || row.type === undefined) {
    throw new Error(
      `set_auto_tracing: address "${address}" on network "${network}" has no type - ` +
        "refusing an unsafe upsert."
    );
  }
  if (row.publicInfo === null || row.publicInfo === undefined) {
    throw new Error(
      `set_auto_tracing: address "${address}" on network "${network}" has no publicInfo - ` +
        "refusing an unsafe upsert."
    );
  }

  return row;
}

/**
 * Merge the stored record with only `enableSniffer` changed. `entityId` is
 * carried verbatim from the raw `entity_id` field (R-16); `publicInfo` maps to
 * the write-side `isPublicInfo` name (R-17). The five provenance fields
 * (originAddress/previousAddress/txHash/txBlockchain/txTimestamp) are
 * deliberately OMITTED, not copied: on write, absent=preserve for those
 * fields, so omitting them is equivalent to carrying them over and avoids any
 * risk of accidentally sending an explicit `null` (which clears them).
 */
function buildUpsertBody(row: AddressRow, enableSniffer: boolean): Record<string, unknown> {
  return {
    address: row.address,
    network: row.network,
    isPublicInfo: row.publicInfo,
    description: row.description,
    type: row.type,
    subType: row.subType,
    reference: row.reference,
    entityId: row.entity_id,
    enableSniffer,
  };
}

export async function setAutoTracing(
  apiRequest: ApiRequestFn,
  args: SetAutoTracingArgs
): Promise<{ before: AddressRow; after: AddressRow }> {
  const { address, network, enableSniffer } = args;

  const before = await fetchSingleActiveRow(apiRequest, address, network);

  await apiRequest("POST", ADDRESSES_PATH, buildUpsertBody(before, enableSniffer));

  const after = await fetchSingleActiveRow(apiRequest, address, network);

  return { before, after };
}
