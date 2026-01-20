import { describe, it } from "node:test";
import assert from "node:assert";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.BLACKLIST_API_KEY;
const API_URL = process.env.BLACKLIST_API_URL || "https://api-blacklist.amlbot.com";

if (!API_KEY) {
  throw new Error("BLACKLIST_API_KEY environment variable is required");
}

async function getAddress(address: string): Promise<unknown> {
  const params = new URLSearchParams();
  params.set("address", address);

  const response = await fetch(`${API_URL}/v1/black-list/addresses?${params.toString()}`, {
    method: "GET",
    headers: {
      "X-Api-Key": API_KEY!,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

describe("Address Blocklist", () => {
  it("should find address TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp in the blocklist", async () => {
    const address = "TSFnW7AE3DTGTo4JtDEcGH6AjvRnDRfQRp";
    const result = await getAddress(address) as {
      publicBlacklist: Array<{ address: string; network: string }>;
      privateBlacklist: Array<{ address: string; network: string }>;
    };

    assert.ok(result, "Search should return a result");
    assert.ok(result.publicBlacklist || result.privateBlacklist, "Response should have blacklist arrays");

    const allAddresses = [...(result.publicBlacklist || []), ...(result.privateBlacklist || [])];
    assert.ok(allAddresses.length > 0, "Response should contain at least one address");

    const found = allAddresses.find(r => r.address === address);
    assert.ok(found, "Response should contain the searched address");

    console.log("Address found in blocklist:", JSON.stringify(result, null, 2));
  });
});
