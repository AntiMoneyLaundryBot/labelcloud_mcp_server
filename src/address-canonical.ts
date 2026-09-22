/**
 * EVM address canonicalisation for outbound Label Cloud requests
 * (SPEC-2026-09-21-labelcloud-mcp-evm-address-canonical, Peppermint #176).
 *
 * EVM hex is case-insensitive by specification; base58 (Tron) and Bech32/Base58Check
 * (BTC, SOL, …) are case-sensitive and MUST stay byte-exact.
 *
 * The list below is a VERBATIM hand-mirror of the backend's canonical set:
 *   blacklist-service-backend/src/modules/janus-graph/utils/address-utils.ts:14-36  (EVM_CHAINS, 21 names)
 * `linea` is NOT a member of that set and must not be added here. Keep this copy in
 * sync by re-reading that file; it becomes unnecessary once the backend
 * `blockchains?.[0]` defect is fixed (spec §9).
 */
export const EVM_CHAINS: ReadonlySet<string> = new Set([
  "ethereum",
  "ethereum_classic",
  "bsc",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
  "cronos",
  "base",
  "scroll",
  "zksync",
  "blast",
  "moonbeam",
  "astar",
  "ronin",
  "manta",
  "evm_eoa",
  "evmos",
  "kava",
  "sei",
  "acala",
]);

/** Mirrors the backend's `looksLikeEvmAddress` (address-utils.ts:44). */
export function looksLikeEvmAddress(address: string): boolean {
  if (!address) {
    return false;
  }
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Lowercase `address` iff it should be treated as EVM hex, byte-exact otherwise.
 * Mirrors the backend's `isUnifyEvm` gate (address-utils.ts:58): when `network` is
 * given, both the EVM_CHAINS membership AND the 0x+40hex shape must hold. When
 * `network` is absent, only the shape gate applies. Never mutates `network`;
 * idempotent on already-canonical input.
 */
export function canonicalizeAddress(address: string, network?: string): string {
  if (!address) {
    return address;
  }

  const isEvm = network
    ? EVM_CHAINS.has(network.toLowerCase()) && looksLikeEvmAddress(address)
    : looksLikeEvmAddress(address);

  return isEvm ? address.toLowerCase() : address;
}

/**
 * Tools whose exposed `address`/`network` args should be canonicalised before
 * dispatch. Deliberately an explicit allow-list, NOT a blanket seam: a generic
 * rewrite would also touch create_address/delete_address input, changing what
 * gets written (violates C-2). Adding a tool here is a one-token change.
 */
const ADDRESS_CANONICAL_TOOLS = new Set(["get_auto_tracer_data"]);

/**
 * Returns `args` unchanged unless `toolName` is in `ADDRESS_CANONICAL_TOOLS`, in
 * which case returns a shallow copy with `address` canonicalised.
 */
export function canonicalizeToolArgs(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!ADDRESS_CANONICAL_TOOLS.has(toolName)) {
    return args;
  }
  if (typeof args.address !== "string") {
    return args;
  }
  return {
    ...args,
    address: canonicalizeAddress(args.address, args.network as string | undefined),
  };
}
