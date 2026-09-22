import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVM_CHAINS,
  looksLikeEvmAddress,
  canonicalizeAddress,
  canonicalizeToolArgs,
} from "../src/address-canonical.js";
import {
  generateToolsFromSpec,
  buildQueryString,
  type OperationInfo,
} from "../src/openapi-to-mcp.js";
import {
  setAutoTracing,
  type ApiRequestFn,
  type AddressRow,
  type SetAutoTracingArgs,
} from "../src/set-auto-tracing.js";

/**
 * Pure unit suite for Peppermint #176 (SPEC-2026-09-21-labelcloud-mcp-evm-address-canonical).
 * Does NOT import test/helpers/dev-endpoint.ts (C-7): that module throws at import time
 * outside a dev-configured shell, and this suite must stay green regardless of env.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHECKSUMMED = "0x6Fe9Ef9d42595682A555698b6b2a68bd4495AeA3";
const LOWERCASE = "0x6fe9ef9d42595682a555698b6b2a68bd4495aea3";
const UPPERCASE_HEX = "0X6FE9EF9D42595682A555698B6B2A68BD4495AEA3".slice(2);
const UPPERCASE = `0x${UPPERCASE_HEX.toUpperCase()}`;

describe("EVM_CHAINS (mirrors blacklist-service-backend address-utils.ts:14-36)", () => {
  it("has exactly the 21 backend names and does not include 'linea'", () => {
    assert.strictEqual(EVM_CHAINS.size, 21, "EVM_CHAINS must have exactly 21 members");
    assert.strictEqual(EVM_CHAINS.has("linea"), false, "linea is not a backend EVM chain");
    for (const name of [
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
    ]) {
      assert.ok(EVM_CHAINS.has(name), `EVM_CHAINS should include '${name}'`);
    }
  });
});

describe("looksLikeEvmAddress", () => {
  it("matches only 0x + 40 hex chars", () => {
    assert.ok(looksLikeEvmAddress(CHECKSUMMED));
    assert.ok(looksLikeEvmAddress(LOWERCASE));
    assert.ok(!looksLikeEvmAddress("TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp"));
    assert.ok(!looksLikeEvmAddress("0x123"));
    assert.ok(!looksLikeEvmAddress(""));
    assert.ok(!looksLikeEvmAddress(" 0x6fe9ef9d42595682a555698b6b2a68bd4495aea3"));
  });
});

describe("canonicalizeAddress", () => {
  it("lowercases a mixed-case EVM address for every one of the 21 EVM networks", () => {
    for (const network of EVM_CHAINS) {
      assert.strictEqual(
        canonicalizeAddress(CHECKSUMMED, network),
        LOWERCASE,
        `network '${network}' should lowercase EVM-shaped input`
      );
    }
  });

  it("leaves non-EVM networks byte-exact", () => {
    const tronAddr = "TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp";
    for (const network of ["tron", "bitcoin", "solana", "ton"]) {
      assert.strictEqual(canonicalizeAddress(tronAddr, network), tronAddr);
      assert.strictEqual(canonicalizeAddress(CHECKSUMMED, network), CHECKSUMMED);
    }
  });

  it("leaves an unknown network byte-exact even for EVM-shaped input", () => {
    assert.strictEqual(canonicalizeAddress(CHECKSUMMED, "not_a_real_network"), CHECKSUMMED);
  });

  it("absent network: lowercases 0x+40hex, leaves base58 untouched", () => {
    assert.strictEqual(canonicalizeAddress(CHECKSUMMED), LOWERCASE);
    assert.strictEqual(canonicalizeAddress(UPPERCASE), LOWERCASE);
    const tronAddr = "TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp";
    assert.strictEqual(canonicalizeAddress(tronAddr), tronAddr);
    assert.strictEqual(canonicalizeAddress(tronAddr, undefined), tronAddr);
  });

  it("is idempotent on already-canonical input (C-4)", () => {
    assert.strictEqual(canonicalizeAddress(LOWERCASE, "evm_eoa"), LOWERCASE);
    assert.strictEqual(
      canonicalizeAddress(canonicalizeAddress(CHECKSUMMED, "evm_eoa"), "evm_eoa"),
      LOWERCASE
    );
  });

  it("returns empty string / undefined unchanged", () => {
    assert.strictEqual(canonicalizeAddress(""), "");
    assert.strictEqual(canonicalizeAddress("", "evm_eoa"), "");
    assert.strictEqual(
      canonicalizeAddress(undefined as unknown as string, "evm_eoa"),
      undefined
    );
  });

  it("matches network case-insensitively ('Ethereum' still hits the EVM set)", () => {
    assert.strictEqual(canonicalizeAddress(CHECKSUMMED, "Ethereum"), LOWERCASE);
    assert.strictEqual(canonicalizeAddress(CHECKSUMMED, "EVM_EOA"), LOWERCASE);
  });

  it("never mutates or returns a different network value than passed in", () => {
    const network = "Ethereum";
    canonicalizeAddress(CHECKSUMMED, network);
    assert.strictEqual(network, "Ethereum", "network argument must not be mutated");
  });

  it("does not trim whitespace-padded input (AC-4d)", () => {
    const padded = ` ${CHECKSUMMED}`;
    assert.strictEqual(canonicalizeAddress(padded, "evm_eoa"), padded);
  });
});

describe("canonicalizeToolArgs (the src/index.ts:153 seam, allow-listed to get_auto_tracer_data)", () => {
  it("canonicalizes address for get_auto_tracer_data", () => {
    const result = canonicalizeToolArgs("get_auto_tracer_data", {
      address: CHECKSUMMED,
      network: "evm_eoa",
    });
    assert.strictEqual(result.address, LOWERCASE);
    assert.strictEqual(result.network, "evm_eoa");
  });

  it("leaves args byte-identical for every non-allow-listed tool (Q2 / C-2 guard)", () => {
    for (const toolName of [
      "search_addresses",
      "get_addresses_by_origin",
      "get_addresses_by_previous",
      "create_address",
      "delete_address",
    ]) {
      const args = { address: CHECKSUMMED, network: "evm_eoa" };
      const result = canonicalizeToolArgs(toolName, args);
      assert.strictEqual(result, args, `${toolName} args object should be returned unchanged`);
      assert.strictEqual(result.address, CHECKSUMMED, `${toolName} must not canonicalize address`);
    }
  });
});

describe("AC-1: read-path outbound query, through the real generateToolsFromSpec + buildQueryString", () => {
  const openApiSpec = JSON.parse(
    readFileSync(path.join(__dirname, "..", "docs", "blacklist-api-endpoints.json"), "utf8")
  );
  const { operationMap } = generateToolsFromSpec(openApiSpec);

  /** Mirrors src/index.ts's (unexported) resolveOperationArgs: aliases then presets. */
  function resolveOperationArgs(
    opInfo: OperationInfo,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = { ...args };
    if (opInfo.argAliases) {
      for (const [exposedName, underlyingName] of Object.entries(opInfo.argAliases)) {
        if (!(exposedName in resolved)) continue;
        const value = resolved[exposedName];
        delete resolved[exposedName];
        resolved[underlyingName] =
          opInfo.arrayAliasTargets?.includes(underlyingName) && !Array.isArray(value)
            ? [value]
            : value;
      }
    }
    if (opInfo.presetArgs) {
      Object.assign(resolved, opInfo.presetArgs);
    }
    return resolved;
  }

  function outboundQueryFor(address: string): string {
    const opInfo = operationMap.get("get_auto_tracer_data");
    assert.ok(opInfo, "get_auto_tracer_data should be a known operation");
    const canonicalArgs = canonicalizeToolArgs("get_auto_tracer_data", {
      address,
      network: "evm_eoa",
    });
    const resolvedArgs = resolveOperationArgs(opInfo!, canonicalArgs);
    return buildQueryString(resolvedArgs, opInfo!.queryParams);
  }

  it("lowercases the checksummed and all-uppercase-hex forms in the outbound query", () => {
    for (const input of [CHECKSUMMED, UPPERCASE]) {
      const query = outboundQueryFor(input);
      const params = new URLSearchParams(query);
      assert.strictEqual(params.get("address"), LOWERCASE);
      assert.strictEqual(params.get("blockchains"), "evm_eoa");
      assert.deepStrictEqual(params.getAll("statuses"), ["ACTIVE"]);
      assert.deepStrictEqual(params.getAll("fields"), [
        "enableSniffer",
        "originAddress",
        "previousAddress",
        "txHash",
        "txBlockchain",
        "txTimestamp",
      ]);
    }
  });

  it("does not canonicalize address for other operations sharing the same seam (Q2 / C-2)", () => {
    for (const toolName of ["search_addresses", "create_address", "get_addresses_by_origin"]) {
      const opInfo = operationMap.get(toolName);
      if (!opInfo) continue; // create_address is a POST body op with no query-based address param
      const canonicalArgs = canonicalizeToolArgs(toolName, { address: CHECKSUMMED });
      assert.strictEqual(canonicalArgs.address, CHECKSUMMED);
    }
  });
});

// --- AC-2 / AC-3 / AC-4: setAutoTracing against an injected fake apiRequest ---

interface MockRow extends AddressRow {
  address: string;
  network: string;
  organization?: string;
}

function makeMockApi(rows: MockRow[]): { api: ApiRequestFn; posted: Array<Record<string, unknown>> } {
  const posted: Array<Record<string, unknown>> = [];
  const api: ApiRequestFn = async (method, path, body) => {
    if (method === "GET") {
      const url = new URL(path, "http://mock");
      const network = url.searchParams.get("blockchains");
      const matched = rows.filter((r) => r.network === network);
      return {
        publicBlacklist: matched.filter((r) => r.publicInfo === true),
        privateBlacklist: matched.filter((r) => r.publicInfo !== true),
      };
    }
    if (method === "POST") {
      const b = body as Record<string, unknown>;
      posted.push(b);
      const row = rows.find((r) => r.address === b.address && r.network === b.network);
      if (row) {
        row.enableSniffer = b.enableSniffer as boolean;
      }
      return null;
    }
    throw new Error(`Unexpected method: ${method}`);
  };
  return { api, posted };
}

describe("AC-2: write path finds the canonical (lowercase-stored) row", () => {
  it("resolves and POSTs the backend's lowercase row.address for a checksummed caller input", async () => {
    const row: MockRow = {
      address: LOWERCASE,
      network: "evm_eoa",
      organization: "org-1",
      entity_id: "entity-1",
      type: "other",
      subType: "sub-1",
      description: "desc-1",
      reference: "ref-1",
      publicInfo: true,
      enableSniffer: false,
    };
    const { api, posted } = makeMockApi([row]);

    const args: SetAutoTracingArgs = {
      address: CHECKSUMMED,
      network: "evm_eoa",
      enableSniffer: true,
    };
    const { before, after } = await setAutoTracing(api, args);

    assert.strictEqual(before.address, LOWERCASE);
    assert.strictEqual(posted.length, 1, "exactly one POST should be issued");
    assert.strictEqual(posted[0].address, LOWERCASE, "POST body must carry the backend's row.address");
    assert.strictEqual(posted[0].entityId, "entity-1");
    assert.strictEqual(posted[0].type, "other");
    assert.strictEqual(posted[0].subType, "sub-1");
    assert.strictEqual(posted[0].description, "desc-1");
    assert.strictEqual(posted[0].reference, "ref-1");
    assert.strictEqual(posted[0].isPublicInfo, true);
    assert.ok(
      !("originAddress" in posted[0]) &&
        !("previousAddress" in posted[0]) &&
        !("txHash" in posted[0]) &&
        !("txBlockchain" in posted[0]) &&
        !("txTimestamp" in posted[0]),
      "no provenance key should be present in the write body"
    );
    assert.strictEqual(after.enableSniffer, true);
  });
});

describe("AC-3: negative guard — base58 (Tron) stays byte-exact", () => {
  const tronAddr = "TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp";
  const flipped = "tSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp";

  it("refuses a one-character case-flipped Tron address (no POST) and succeeds on the exact address", async () => {
    const row: MockRow = {
      address: tronAddr,
      network: "tron",
      organization: "org-1",
      entity_id: "entity-1",
      type: "other",
      subType: null,
      description: null,
      reference: null,
      publicInfo: false,
      enableSniffer: false,
    };
    const { api, posted } = makeMockApi([row]);

    await assert.rejects(
      () => setAutoTracing(api, { address: flipped, network: "tron", enableSniffer: true }),
      /no ACTIVE address found/
    );
    assert.strictEqual(posted.length, 0, "no POST should be issued for the flipped-case miss");

    const { after } = await setAutoTracing(api, {
      address: tronAddr,
      network: "tron",
      enableSniffer: true,
    });
    assert.strictEqual(after.enableSniffer, true);
    assert.strictEqual(posted.length, 1);
  });
});

describe("AC-4: ambiguity and fuzz guards stay intact under canonical input", () => {
  it("(a) two addresses differing in one hex digit — only the requested one is ever selected", async () => {
    const rowA: MockRow = {
      address: "0x111111111111111111111111111111111111aaa1",
      network: "evm_eoa",
      organization: "org-1",
      entity_id: "entity-a",
      type: "other",
      subType: null,
      description: null,
      reference: null,
      publicInfo: true,
      enableSniffer: false,
    };
    const rowB: MockRow = {
      address: "0x111111111111111111111111111111111111aaa2",
      network: "evm_eoa",
      organization: "org-1",
      entity_id: "entity-b",
      type: "other",
      subType: null,
      description: null,
      reference: null,
      publicInfo: true,
      enableSniffer: false,
    };
    const { api, posted } = makeMockApi([rowA, rowB]);

    const { before } = await setAutoTracing(api, {
      address: "0x111111111111111111111111111111111111AAA1",
      network: "evm_eoa",
      enableSniffer: true,
    });
    assert.strictEqual(before.address, rowA.address);
    assert.strictEqual(posted[0].entityId, "entity-a");
  });

  it("(b) two ACTIVE rows for the same canonical address in different organizations refuse as ambiguous", async () => {
    const rows: MockRow[] = [
      {
        address: LOWERCASE,
        network: "evm_eoa",
        organization: "org-1",
        entity_id: "entity-1",
        type: "other",
        subType: null,
        description: null,
        reference: null,
        publicInfo: true,
        enableSniffer: false,
      },
      {
        address: LOWERCASE,
        network: "evm_eoa",
        organization: "org-2",
        entity_id: "entity-2",
        type: "other",
        subType: null,
        description: null,
        reference: null,
        publicInfo: false,
        enableSniffer: false,
      },
    ];
    const { api, posted } = makeMockApi(rows);

    await assert.rejects(
      () => setAutoTracing(api, { address: CHECKSUMMED, network: "evm_eoa", enableSniffer: true }),
      /2 ACTIVE rows found/
    );
    assert.strictEqual(posted.length, 0, "an ambiguous write must never POST");
  });

  it("(c) a row missing 'type' or 'publicInfo' refuses an unsafe upsert", async () => {
    const missingType: MockRow = {
      address: LOWERCASE,
      network: "evm_eoa",
      organization: "org-1",
      type: null as unknown as string,
      publicInfo: true,
      enableSniffer: false,
    };
    const { api: apiA } = makeMockApi([missingType]);
    await assert.rejects(
      () => setAutoTracing(apiA, { address: CHECKSUMMED, network: "evm_eoa", enableSniffer: true }),
      /has no type/
    );

    const missingPublicInfo: MockRow = {
      address: LOWERCASE,
      network: "evm_eoa",
      organization: "org-1",
      type: "other",
      publicInfo: null as unknown as boolean,
      enableSniffer: false,
    };
    const { api: apiB } = makeMockApi([missingPublicInfo]);
    await assert.rejects(
      () => setAutoTracing(apiB, { address: CHECKSUMMED, network: "evm_eoa", enableSniffer: true }),
      /has no publicInfo/
    );
  });
});
