import { createHash } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { ServiceDatabase, type OAuthClient } from "./database.js";
import {
  escapeHtml,
  normalizeStoreUrl,
  safeEqual,
  sha256,
} from "./security.js";
import { WooCommerceClient, WooCommerceError } from "./woocommerce.js";

const registrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(20),
  client_name: z.string().trim().min(1).max(100).default("Assistant connector"),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .default("none"),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const authorizeQuerySchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(2048).optional(),
  scope: z.string().optional().default("woo:read"),
  resource: z.string().url(),
});

function oauthError(
  response: Response,
  status: number,
  error: string,
  description: string,
): void {
  response.status(status).json({ error, error_description: description });
}

function isAllowedRedirectUri(rawUri: string): boolean {
  try {
    const uri = new URL(rawUri);
    if (uri.hash) return false;
    if (uri.protocol === "https:") return true;
    return (
      uri.protocol === "http:" &&
      (uri.hostname === "127.0.0.1" || uri.hostname === "[::1]" || uri.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function connectPage(input: {
  requestId: string;
  clientName: string;
  authorizeUrl: string;
  storeUrl?: string;
  username?: string;
  error?: string;
}): string {
  const error = input.error
    ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect WooCommerce</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f4f1eb; color: #1e2430; }
    main { max-width: 520px; margin: 6vh auto; padding: 38px; background: #fff; border: 1px solid #ded8cf; border-radius: 18px; box-shadow: 0 18px 50px #29324118; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -.02em; }
    p { color: #5c6573; line-height: 1.55; }
    label { display: block; margin-top: 18px; font-weight: 650; }
    input { box-sizing: border-box; width: 100%; margin-top: 7px; padding: 12px 13px; border: 1px solid #b9c0ca; border-radius: 9px; font: inherit; }
    input:focus { outline: 3px solid #7c3aed24; border-color: #6d28d9; }
    button { width: 100%; margin-top: 24px; padding: 13px; border: 0; border-radius: 9px; background: #6d28d9; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .note { padding: 12px 14px; background: #f7f5ff; border-radius: 9px; font-size: 14px; }
    .error { margin: 16px 0; padding: 12px; background: #fff0f0; border: 1px solid #f5b7b7; border-radius: 8px; color: #8b1a1a; }
  </style>
</head>
<body>
  <main>
    <h1>Connect your store</h1>
    <p><strong>${escapeHtml(input.clientName)}</strong> is requesting read-only access to WooCommerce products, orders, inventory, and sales analytics.</p>
    ${error}
    <form method="post" action="${escapeHtml(input.authorizeUrl)}" autocomplete="off">
      <input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
      <label>Store URL
        <input type="text" name="store_url" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="https://shop.example.com" required value="${escapeHtml(input.storeUrl ?? "")}">
      </label>
      <label>WordPress username
        <input type="text" name="username" required autocomplete="username" value="${escapeHtml(input.username ?? "")}">
      </label>
      <label>Application password
        <input type="password" name="app_password" required autocomplete="current-password">
      </label>
      <button type="submit">Verify and connect</button>
    </form>
    <p class="note">Create the application password in WordPress under Users → Profile → Application Passwords. It is encrypted before storage and is never sent to the assistant.</p>
  </main>
</body>
</html>`;
}

function getBasicCredentials(request: Request): { id: string; secret: string } | null {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Basic ")) return null;
  try {
    const [id, secret] = Buffer.from(authorization.slice(6), "base64").toString("utf8").split(":", 2);
    return id && secret ? { id: decodeURIComponent(id), secret: decodeURIComponent(secret) } : null;
  } catch {
    return null;
  }
}

function authenticateClient(request: Request, database: ServiceDatabase): OAuthClient | null {
  const basic = getBasicCredentials(request);
  const clientId = basic?.id || String(request.body.client_id || "");
  const client = database.getClient(clientId);
  if (!client) return null;
  if (client.tokenEndpointAuthMethod === "none") {
    return basic || request.body.client_secret ? null : client;
  }
  if (client.tokenEndpointAuthMethod === "client_secret_basic" && !basic) return null;
  if (client.tokenEndpointAuthMethod === "client_secret_post" && basic) return null;
  const suppliedSecret =
    client.tokenEndpointAuthMethod === "client_secret_basic"
      ? basic!.secret
      : String(request.body.client_secret || "");
  return client.clientSecretHash && safeEqual(client.clientSecretHash, sha256(suppliedSecret))
    ? client
    : null;
}

export function createOAuthRouter(config: AppConfig, database: ServiceDatabase): Router {
  const router = express.Router();
  const resourceUrl = `${config.publicBaseUrl}/mcp`;

  router.get("/.well-known/oauth-protected-resource", (_request, response) => {
    response.json({
      resource: resourceUrl,
      authorization_servers: [config.publicBaseUrl],
      scopes_supported: ["woo:read"],
      bearer_methods_supported: ["header"],
      resource_documentation: `${config.publicBaseUrl}/docs`,
    });
  });
  router.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
    response.json({
      resource: resourceUrl,
      authorization_servers: [config.publicBaseUrl],
      scopes_supported: ["woo:read"],
      bearer_methods_supported: ["header"],
      resource_documentation: `${config.publicBaseUrl}/docs`,
    });
  });
  router.get("/.well-known/oauth-authorization-server", (_request, response) => {
    response.json({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
      token_endpoint: `${config.publicBaseUrl}/oauth/token`,
      registration_endpoint: `${config.publicBaseUrl}/oauth/register`,
      revocation_endpoint: `${config.publicBaseUrl}/oauth/revoke`,
      scopes_supported: ["woo:read"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  router.post("/oauth/register", (request, response) => {
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) {
      oauthError(response, 400, "invalid_client_metadata", "Client metadata is invalid");
      return;
    }
    if (!parsed.data.redirect_uris.every(isAllowedRedirectUri)) {
      oauthError(response, 400, "invalid_redirect_uri", "Redirect URIs must be HTTPS (loopback HTTP is allowed)");
      return;
    }
    if (parsed.data.grant_types && !parsed.data.grant_types.includes("authorization_code")) {
      oauthError(response, 400, "invalid_client_metadata", "authorization_code grant is required");
      return;
    }
    const created = database.createClient({
      clientName: parsed.data.client_name,
      redirectUris: parsed.data.redirect_uris,
      tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method,
    });
    response.status(201).json({
      client_id: created.client.clientId,
      ...(created.clientSecret ? { client_secret: created.clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: created.client.clientName,
      redirect_uris: created.client.redirectUris,
      token_endpoint_auth_method: created.client.tokenEndpointAuthMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  router.get("/oauth/authorize", (request, response) => {
    const parsed = authorizeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      oauthError(response, 400, "invalid_request", "Authorization request is incomplete or invalid");
      return;
    }
    const client = database.getClient(parsed.data.client_id);
    if (!client || !client.redirectUris.includes(parsed.data.redirect_uri)) {
      oauthError(response, 400, "invalid_client", "Unknown client or redirect URI");
      return;
    }
    if (parsed.data.resource !== resourceUrl || parsed.data.scope !== "woo:read") {
      oauthError(response, 400, "invalid_scope", "Only read-only WooCommerce access is available");
      return;
    }
    const pending = database.createAuthorizationRequest({
      clientId: client.clientId,
      redirectUri: parsed.data.redirect_uri,
      state: parsed.data.state ?? null,
      codeChallenge: parsed.data.code_challenge,
      scope: parsed.data.scope,
      resource: parsed.data.resource,
    });
    response.type("html").send(connectPage({
      requestId: pending.id,
      clientName: client.clientName,
      authorizeUrl: `${config.publicBaseUrl}/oauth/authorize`,
    }));
  });

  router.post("/oauth/authorize", async (request, response) => {
    const requestId = String(request.body.request_id || "");
    const pending = database.getAuthorizationRequest(requestId);
    if (!pending) {
      console.warn("OAuth authorization form received an expired request");
      response.status(400).type("html").send("Authorization request expired. Return to the assistant and try connecting again.");
      return;
    }
    console.info("OAuth authorization form submitted", { clientId: pending.clientId });
    const client = database.getClient(pending.clientId);
    if (!client) {
      oauthError(response, 400, "invalid_client", "OAuth client no longer exists");
      return;
    }
    const rawStoreUrl = String(request.body.store_url || "").trim();
    const username = String(request.body.username || "").trim();
    const appPassword = String(request.body.app_password || "").replace(/\s+/g, "");
    try {
      if (!username || !appPassword) throw new Error("Username and application password are required");
      const storeUrl = normalizeStoreUrl(rawStoreUrl, config.allowPrivateWooHosts);
      const woo = new WooCommerceClient({
        storeUrl,
        username,
        appPassword,
        allowPrivateHosts: config.allowPrivateWooHosts,
      });
      await woo.verifyConnection();
      const consumed = database.consumeAuthorizationRequest(requestId);
      if (!consumed) throw new Error("Authorization request expired");
      const merchant = database.upsertMerchant({
        storeUrl,
        username,
        appPassword,
        encryptionKey: config.encryptionKey,
      });
      const code = database.createAuthorizationCode(consumed, merchant.id);
      const redirect = new URL(consumed.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", config.publicBaseUrl);
      if (consumed.state) redirect.searchParams.set("state", consumed.state);
      console.info("OAuth authorization approved", {
        clientId: consumed.clientId,
        redirectHost: redirect.host,
      });
      response.redirect(303, redirect.toString());
    } catch (error) {
      const message =
        error instanceof WooCommerceError && (error.status === 401 || error.status === 403)
          ? "WooCommerce rejected those credentials. Check the username and application password."
          : error instanceof Error
            ? error.message
            : "Could not connect the store";
      console.warn("OAuth authorization verification failed", { clientId: pending.clientId, reason: message });
      response.status(400).type("html").send(connectPage({
        requestId,
        clientName: client.clientName,
        authorizeUrl: `${config.publicBaseUrl}/oauth/authorize`,
        storeUrl: rawStoreUrl,
        username,
        error: message,
      }));
    }
  });

  router.post("/oauth/token", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    const client = authenticateClient(request, database);
    if (!client) {
      console.warn("OAuth token request rejected: client authentication failed");
      response.setHeader("WWW-Authenticate", 'Basic realm="oauth-token"');
      oauthError(response, 401, "invalid_client", "Client authentication failed");
      return;
    }
    const grantType = String(request.body.grant_type || "");
    if (grantType === "authorization_code") {
      const code = String(request.body.code || "");
      const verifier = String(request.body.code_verifier || "");
      const redirectUri = String(request.body.redirect_uri || "");
      const authorization = database.consumeAuthorizationCode(code);
      const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
      if (
        !authorization ||
        authorization.clientId !== client.clientId ||
        authorization.redirectUri !== redirectUri ||
        !safeEqual(authorization.codeChallenge, challenge)
      ) {
        console.warn("OAuth token request rejected: authorization code validation failed", {
          clientId: client.clientId,
        });
        oauthError(response, 400, "invalid_grant", "Authorization code is invalid or expired");
        return;
      }
      const tokens = database.createTokens(authorization, config.accessTokenTtlSeconds, config.refreshTokenTtlSeconds);
      console.info("OAuth token issued", { clientId: client.clientId });
      response.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: tokens.refreshToken,
        scope: authorization.scope,
      });
      return;
    }
    if (grantType === "refresh_token") {
      const grant = database.consumeRefreshToken(String(request.body.refresh_token || ""), client.clientId);
      if (!grant) {
        oauthError(response, 400, "invalid_grant", "Refresh token is invalid or expired");
        return;
      }
      const tokens = database.createTokens(grant, config.accessTokenTtlSeconds, config.refreshTokenTtlSeconds);
      response.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: tokens.refreshToken,
        scope: grant.scope,
      });
      return;
    }
    oauthError(response, 400, "unsupported_grant_type", "Supported grants are authorization_code and refresh_token");
  });

  router.post("/oauth/revoke", (request, response) => {
    const client = authenticateClient(request, database);
    if (!client) {
      oauthError(response, 401, "invalid_client", "Client authentication failed");
      return;
    }
    database.revokeToken(String(request.body.token || ""));
    response.status(200).end();
  });

  return router;
}
