import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ServiceDatabase } from "../src/database.js";

test("OAuth records bind codes and tokens to a merchant and client", () => {
  const database = new ServiceDatabase(":memory:");
  try {
    const { client } = database.createClient({
      clientName: "Test client",
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
    });
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const pending = database.createAuthorizationRequest({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0]!,
      state: "state",
      codeChallenge: challenge,
      scope: "woo:read",
      resource: "https://mcp.example/mcp",
    });
    const merchant = database.upsertMerchant({
      storeUrl: "https://shop.example",
      username: "owner",
      appPassword: "secret",
      encryptionKey: Buffer.alloc(32, 4),
    });
    assert.equal(database.consumeAuthorizationRequest(pending.id)?.state, "state");
    assert.equal(database.consumeAuthorizationRequest(pending.id), null);
    const code = database.createAuthorizationCode(pending, merchant.id);
    const grant = database.consumeAuthorizationCode(code);
    assert.equal(grant?.merchantId, merchant.id);
    assert.equal(database.consumeAuthorizationCode(code), null);
    const tokens = database.createTokens(grant!, 3600, 7200);
    assert.equal(database.validateAccessToken(tokens.accessToken, grant!.resource)?.clientId, client.clientId);
    assert.equal(database.validateAccessToken(tokens.accessToken, "https://other.example/mcp"), null);
    assert.equal(database.consumeRefreshToken(tokens.refreshToken, client.clientId)?.merchantId, merchant.id);
    assert.equal(database.consumeRefreshToken(tokens.refreshToken, client.clientId), null);
  } finally {
    database.close();
  }
});
