import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startDevServer, devTransport, type DevServerHandle } from "./helpers/dev-endpoint.js";

/**
 * Dev-pinned round-trip for `set_auto_tracing` / `get_auto_tracer_data`
 * (SPEC-2026-09-18-labelcloud-mcp-auto-tracing-tools, A3 criteria 2 & 3).
 *
 * Fixture discipline: this suite creates and deletes its own scratch address
 * (prefixed `T172…`, never the shared `T146TRACE*` fixture) and its own
 * scratch entity, so it never mutates fixtures other suites depend on.
 */

let server: DevServerHandle;

before(async () => {
  server = await startDevServer();
});

after(async () => {
  await server.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AddressSnapshot {
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
  entity_id?: string | null;
  [key: string]: unknown;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const content = result.content.find(
    (c): c is { type: "text"; text: string } => c.type === "text"
  );
  assert.ok(content, "Tool result should have text content");
  return content.text;
}

/** Fields that must be byte-identical before/after a flag flip - everything
 * except `enableSniffer` itself (A3 criterion 2: "only enable_sniffer + updated_at"). */
const UNCHANGED_FIELDS: Array<keyof AddressSnapshot> = [
  "type",
  "subType",
  "description",
  "reference",
  "publicInfo",
  "originAddress",
  "previousAddress",
  "txHash",
  "txBlockchain",
  "txTimestamp",
  "entity_id",
];

function assertOnlyFlagChanged(
  before: AddressSnapshot,
  after: AddressSnapshot,
  expectedEnableSniffer: boolean
): void {
  assert.strictEqual(
    after.enableSniffer,
    expectedEnableSniffer,
    "enableSniffer should equal the requested value after the flip"
  );
  for (const field of UNCHANGED_FIELDS) {
    assert.deepStrictEqual(
      after[field],
      before[field],
      `Field '${String(field)}' should be unchanged by a flag flip (before=${JSON.stringify(
        before[field]
      )}, after=${JSON.stringify(after[field])})`
    );
  }
}

describe("set_auto_tracing / get_auto_tracer_data (A3 criteria 2 & 3, dev-pinned, live)", () => {
  it("flips the flag true->false->true on a self-created scratch address without touching any other field, and refuses on absent/DELETED addresses", async () => {
    const timestamp = Date.now();
    const entityName = `T172-auto-tracing-entity-${timestamp}`;
    const testAddress = `T172AUTOTRACE${timestamp}`;
    const network = "tron";

    const transport = devTransport(server.url);

    const client = new Client({ name: "test-client", version: "1.0.0" });

    let entityId: string | undefined;

    try {
      await client.connect(transport);

      // --- Setup: own scratch entity + own scratch address -----------------
      // R-17: isPublicInfo must be non-default (true) so a publicInfo<->isPublicInfo
      // mapping slip is visible in the full-record diff below.
      const createEntityResult = await client.callTool({
        name: "create_entity",
        arguments: { name: entityName, isPublicInfo: true, type: "other" },
      });
      assert.ok(!createEntityResult.isError, "create_entity should not error");
      entityId = (JSON.parse(textOf(createEntityResult)) as { id: string }).id;
      assert.ok(entityId, "create_entity should return an id");

      const provenance = {
        originAddress: `T172ORIGIN${timestamp}`,
        previousAddress: `T172PREVIOUS${timestamp}`,
        txHash: `0xT172TXHASH${timestamp}`,
        txBlockchain: network,
        txTimestamp: new Date().toISOString(),
      };

      const createAddressResult = await client.callTool({
        name: "create_address",
        arguments: {
          address: testAddress,
          network,
          isPublicInfo: true,
          type: "other",
          subType: "auto-tracing-test",
          description: "Scratch address for Peppermint #172 set_auto_tracing tests",
          entityId,
          enableSniffer: false,
          ...provenance,
        },
      });
      assert.ok(!createAddressResult.isError, "create_address should not error");
      await sleep(1000); // API eventual consistency, matching mcp-crud-entity.test.ts

      // --- Baseline read via search_addresses (explicit fields) ------------
      const AUTO_TRACING_FIELDS = [
        "enableSniffer",
        "originAddress",
        "previousAddress",
        "txHash",
        "txBlockchain",
        "txTimestamp",
        "publicInfo",
        "organization",
        "entityId",
        "description",
        "type",
        "subType",
        "reference",
      ];
      const baselineResult = await client.callTool({
        name: "search_addresses",
        arguments: { address: testAddress, fields: AUTO_TRACING_FIELDS },
      });
      assert.ok(!baselineResult.isError, "search_addresses should not error");
      const baselineParsed = JSON.parse(textOf(baselineResult)) as {
        publicBlacklist: AddressSnapshot[];
        privateBlacklist: AddressSnapshot[];
      };
      const baseline = [
        ...(baselineParsed.publicBlacklist || []),
        ...(baselineParsed.privateBlacklist || []),
      ][0];
      assert.ok(baseline, "Baseline read should find the scratch address");
      assert.strictEqual(baseline.enableSniffer, false, "enableSniffer should start false");

      // --- true -> false -> true, verifying only the flag moves -------------
      let previousSnapshot = baseline;
      for (const nextValue of [true, false, true]) {
        const setResult = await client.callTool({
          name: "set_auto_tracing",
          arguments: { address: testAddress, network, enableSniffer: nextValue },
        });
        assert.ok(!setResult.isError, `set_auto_tracing(${nextValue}) should not error`);
        const { before, after } = JSON.parse(textOf(setResult)) as {
          before: AddressSnapshot;
          after: AddressSnapshot;
        };
        assert.deepStrictEqual(
          before.enableSniffer,
          previousSnapshot.enableSniffer,
          "before-snapshot should match the last observed state"
        );
        assertOnlyFlagChanged(before, after, nextValue);

        // get_auto_tracer_data must agree with an explicit-fields search_addresses read
        const tracerResult = await client.callTool({
          name: "get_auto_tracer_data",
          arguments: { address: testAddress, network },
        });
        assert.ok(!tracerResult.isError, "get_auto_tracer_data should not error");
        const tracerParsed = JSON.parse(textOf(tracerResult)) as {
          publicBlacklist: AddressSnapshot[];
          privateBlacklist: AddressSnapshot[];
        };
        const tracerRow = [
          ...(tracerParsed.publicBlacklist || []),
          ...(tracerParsed.privateBlacklist || []),
        ][0];
        assert.ok(tracerRow, "get_auto_tracer_data should find the address");
        for (const field of [
          "enableSniffer",
          "originAddress",
          "previousAddress",
          "txHash",
          "txBlockchain",
          "txTimestamp",
        ] as const) {
          assert.deepStrictEqual(
            tracerRow[field],
            after[field],
            `get_auto_tracer_data.${field} should match set_auto_tracing's after-snapshot`
          );
        }

        previousSnapshot = after;
      }

      // entityId / type unchanged end-to-end (A3 criterion 2)
      assert.strictEqual(previousSnapshot.type, baseline.type, "type must be unchanged");
      assert.strictEqual(
        previousSnapshot.entity_id,
        baseline.entity_id,
        "entityId must be unchanged"
      );

      // --- Refusal: non-existent address ------------------------------------
      const nonExistentResult = await client.callTool({
        name: "set_auto_tracing",
        arguments: {
          address: `T172NONEXISTENT${timestamp}`,
          network,
          enableSniffer: true,
        },
      });
      assert.ok(
        nonExistentResult.isError,
        "set_auto_tracing on a non-existent address should error"
      );
      assert.match(
        textOf(nonExistentResult),
        /no ACTIVE address found/i,
        "Error should name the not-found reason"
      );

      // --- Refusal: DELETED address (no reactivation) ------------------------
      const deleteResult = await client.callTool({
        name: "delete_address",
        arguments: { address: testAddress, network },
      });
      assert.ok(!deleteResult.isError, "delete_address should not error");

      const deletedFlipResult = await client.callTool({
        name: "set_auto_tracing",
        arguments: { address: testAddress, network, enableSniffer: false },
      });
      assert.ok(
        deletedFlipResult.isError,
        "set_auto_tracing on a DELETED address should refuse, not reactivate it"
      );

      const postDeleteSearch = await client.callTool({
        name: "search_addresses",
        arguments: { address: testAddress, statuses: ["DELETED"], fields: ["enableSniffer"] },
      });
      const postDeleteParsed = JSON.parse(textOf(postDeleteSearch)) as {
        publicBlacklist: AddressSnapshot[];
        privateBlacklist: AddressSnapshot[];
      };
      const deletedRow = [
        ...(postDeleteParsed.publicBlacklist || []),
        ...(postDeleteParsed.privateBlacklist || []),
      ][0];
      assert.ok(deletedRow, "DELETED row should still be readable by statuses=DELETED");
      assert.strictEqual(
        deletedRow.enableSniffer,
        true,
        "the refused flip must not have changed the DELETED row's flag"
      );

      console.log("\n✓ set_auto_tracing / get_auto_tracer_data round-trip completed");
    } finally {
      if (entityId) {
        await client.callTool({ name: "delete_entity", arguments: { entityId } });
      }
      await client.close();
    }
  });
});
