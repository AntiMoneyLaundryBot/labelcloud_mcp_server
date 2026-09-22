import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startDevServer, devTransport, type DevServerHandle } from "./helpers/dev-endpoint.js";

/**
 * Dev-pinned live proof for EVM address case-insensitivity through the real tool
 * dispatch (SPEC-2026-09-21-labelcloud-mcp-evm-address-canonical, AC-1 / AC-2 / AC-3,
 * Peppermint #176). Same pattern as test/mcp-auto-tracing.test.ts: connects over the
 * HTTP transport against the dev Label Cloud (startDevServer()/devTransport()).
 *
 * Fixture discipline: creates and deletes its own scratch entity + scratch addresses
 * (prefixed `T176…`), never the shared `T146TRACE*` / `T172*` fixtures.
 */

let server: DevServerHandle;

before(async () => {
  server = await startDevServer();
});

after(async () => {
  await server.close();
});

interface AddressSnapshot {
  enableSniffer?: boolean | null;
  originAddress?: string | null;
  previousAddress?: string | null;
  txHash?: string | null;
  txBlockchain?: string | null;
  txTimestamp?: string | null;
  [key: string]: unknown;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const content = result.content.find(
    (c): c is { type: "text"; text: string } => c.type === "text"
  );
  assert.ok(content, "Tool result should have text content");
  return content.text;
}

function firstRow(parsedText: string): AddressSnapshot | undefined {
  const parsed = JSON.parse(parsedText) as {
    publicBlacklist: AddressSnapshot[];
    privateBlacklist: AddressSnapshot[];
  };
  return [...(parsed.publicBlacklist || []), ...(parsed.privateBlacklist || [])][0];
}

describe("EVM address case-insensitivity, dev-pinned live (AC-1 / AC-2 / AC-3)", () => {
  it("reads and writes an EVM row through checksummed/uppercase input, and refuses a case-flipped Tron address", async () => {
    const timestamp = Date.now();
    const entityName = `T176-evm-case-entity-${timestamp}`;
    const network = "evm_eoa";
    // Contains a-f so a mixed-case variant exists; unique per run.
    const lowercaseAddress =
      "0x" + (timestamp.toString(16) + "abcdef").padEnd(40, "0").slice(0, 40);
    const uppercaseAddress = `0x${lowercaseAddress.slice(2).toUpperCase()}`;
    const mixedCaseAddress =
      "0x" +
      lowercaseAddress
        .slice(2)
        .split("")
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
        .join("");

    const tronAddress = `T176TRON${timestamp}`;
    const tronFlipped = `t176TRON${timestamp}`;

    const transport = devTransport(server.url);

    const client = new Client({ name: "test-client", version: "1.0.0" });

    let entityId: string | undefined;

    try {
      await client.connect(transport);

      const createEntityResult = await client.callTool({
        name: "create_entity",
        arguments: { name: entityName, isPublicInfo: true, type: "other" },
      });
      assert.ok(!createEntityResult.isError, "create_entity should not error");
      entityId = (JSON.parse(textOf(createEntityResult)) as { id: string }).id;
      assert.ok(entityId, "create_entity should return an id");

      const provenance = {
        originAddress: `T176ORIGIN${timestamp}`,
        previousAddress: `T176PREVIOUS${timestamp}`,
        txHash: `0xT176TXHASH${timestamp}`,
        txBlockchain: network,
        txTimestamp: new Date().toISOString(),
      };

      const createAddressResult = await client.callTool({
        name: "create_address",
        arguments: {
          address: lowercaseAddress,
          network,
          isPublicInfo: true,
          type: "other",
          subType: "evm-case-test",
          description: "Scratch address for Peppermint #176 EVM case-insensitivity tests",
          entityId,
          enableSniffer: false,
          ...provenance,
        },
      });
      assert.ok(!createAddressResult.isError, "create_address should not error");

      const createTronResult = await client.callTool({
        name: "create_address",
        arguments: {
          address: tronAddress,
          network: "tron",
          isPublicInfo: true,
          type: "other",
          subType: "evm-case-test-tron",
          entityId,
          enableSniffer: false,
        },
      });
      assert.ok(!createTronResult.isError, "create_address (tron) should not error");

      await new Promise((resolve) => setTimeout(resolve, 1000)); // API eventual consistency

      // --- AC-1: lowercase / uppercase / mixed-case all return the same row ---
      const forms = [lowercaseAddress, uppercaseAddress, mixedCaseAddress];
      const rows: AddressSnapshot[] = [];
      for (const form of forms) {
        const result = await client.callTool({
          name: "get_auto_tracer_data",
          arguments: { address: form, network },
        });
        assert.ok(!result.isError, `get_auto_tracer_data(${form}) should not error`);
        const row = firstRow(textOf(result));
        assert.ok(row, `get_auto_tracer_data(${form}) should find a non-empty row`);
        rows.push(row!);
      }
      for (const row of rows.slice(1)) {
        assert.deepStrictEqual(row, rows[0], "all three casings should return the identical row");
      }
      assert.strictEqual(rows[0].enableSniffer, false);

      // --- AC-2: set_auto_tracing with the mixed-case form flips the flag ---
      const setResult = await client.callTool({
        name: "set_auto_tracing",
        arguments: { address: mixedCaseAddress, network, enableSniffer: true },
      });
      assert.ok(!setResult.isError, "set_auto_tracing(mixed-case) should not error");
      const { before, after } = JSON.parse(textOf(setResult)) as {
        before: AddressSnapshot;
        after: AddressSnapshot;
      };
      assert.strictEqual(before.enableSniffer, false);
      assert.strictEqual(after.enableSniffer, true);
      for (const field of [
        "originAddress",
        "previousAddress",
        "txHash",
        "txBlockchain",
        "txTimestamp",
      ] as const) {
        assert.deepStrictEqual(after[field], before[field], `${field} must be unchanged`);
      }

      const reReadResult = await client.callTool({
        name: "get_auto_tracer_data",
        arguments: { address: lowercaseAddress, network },
      });
      assert.ok(!reReadResult.isError);
      const reRead = firstRow(textOf(reReadResult));
      assert.strictEqual(reRead?.enableSniffer, true, "lowercase re-read should agree");

      // --- AC-3 live: a one-character case-flipped Tron address must not match ---
      const tronReadResult = await client.callTool({
        name: "get_auto_tracer_data",
        arguments: { address: tronFlipped, network: "tron" },
      });
      assert.ok(!tronReadResult.isError);
      assert.strictEqual(
        firstRow(textOf(tronReadResult)),
        undefined,
        "case-flipped Tron address must return no row"
      );

      const tronSetResult = await client.callTool({
        name: "set_auto_tracing",
        arguments: { address: tronFlipped, network: "tron", enableSniffer: true },
      });
      assert.ok(tronSetResult.isError, "set_auto_tracing on a case-flipped Tron address should refuse");
      assert.match(textOf(tronSetResult), /no ACTIVE address found/i);

      console.log("\n✓ EVM address case-insensitivity round-trip completed");
    } finally {
      if (entityId) {
        await client.callTool({
          name: "delete_address",
          arguments: { address: lowercaseAddress, network },
        });
        await client.callTool({
          name: "delete_address",
          arguments: { address: tronAddress, network: "tron" },
        });
        await client.callTool({ name: "delete_entity", arguments: { entityId } });
      }
      await client.close();
    }
  });
});
