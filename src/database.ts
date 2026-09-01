import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { encryptSecret, randomToken, sha256 } from "./security.js";

export interface Merchant {
  id: string;
  storeUrl: string;
  username: string;
  encryptedAppPassword: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
}

export interface AuthorizationRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface AuthorizationCode extends Omit<AuthorizationRequest, "id" | "state" | "expiresAt"> {
  merchantId: string;
}

export interface AccessGrant {
  merchantId: string;
  clientId: string;
  scope: string;
  resource: string;
}

export class ServiceDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merchants (
        id TEXT PRIMARY KEY,
        store_url TEXT NOT NULL,
        username TEXT NOT NULL,
        encrypted_app_password TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(store_url, username)
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        client_name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authorization_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        state TEXT,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authorization_codes (
        code_hash TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS access_tokens (
        token_hash TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_access_tokens_expiry ON access_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON refresh_tokens(expires_at);
    `);
  }

  cleanupExpired(now = Date.now()): void {
    this.db.prepare("DELETE FROM authorization_requests WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM authorization_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(now);
    this.db.prepare("DELETE FROM access_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL").run(now);
    this.db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL").run(now);
    this.db.prepare(`
      DELETE FROM merchants
      WHERE id NOT IN (
        SELECT merchant_id FROM refresh_tokens
        WHERE revoked_at IS NULL AND expires_at >= ?
      )
      AND updated_at < ?
    `).run(now, now - 24 * 3600_000);
  }

  createClient(input: {
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: OAuthClient["tokenEndpointAuthMethod"];
  }): { client: OAuthClient; clientSecret?: string } {
    const clientId = randomToken(24);
    const clientSecret = input.tokenEndpointAuthMethod === "none" ? undefined : randomToken(32);
    this.db.prepare(`
      INSERT INTO oauth_clients
        (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      clientId,
      clientSecret ? sha256(clientSecret) : null,
      input.clientName,
      JSON.stringify(input.redirectUris),
      input.tokenEndpointAuthMethod,
      Date.now(),
    );
    return {
      client: {
        clientId,
        clientSecretHash: clientSecret ? sha256(clientSecret) : null,
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      },
      ...(clientSecret ? { clientSecret } : {}),
    };
  }

  getClient(clientId: string): OAuthClient | null {
    const row = this.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      clientId: String(row.client_id),
      clientSecretHash: row.client_secret_hash ? String(row.client_secret_hash) : null,
      clientName: String(row.client_name),
      redirectUris: JSON.parse(String(row.redirect_uris)) as string[],
      tokenEndpointAuthMethod: String(row.token_endpoint_auth_method) as OAuthClient["tokenEndpointAuthMethod"],
    };
  }

  createAuthorizationRequest(input: Omit<AuthorizationRequest, "id" | "expiresAt">): AuthorizationRequest {
    const request: AuthorizationRequest = {
      ...input,
      id: randomToken(32),
      expiresAt: Date.now() + 10 * 60_000,
    };
    this.db.prepare(`
      INSERT INTO authorization_requests
        (id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.id,
      request.clientId,
      request.redirectUri,
      request.state,
      request.codeChallenge,
      request.scope,
      request.resource,
      request.expiresAt,
    );
    return request;
  }

  getAuthorizationRequest(id: string): AuthorizationRequest | null {
    const row = this.db.prepare("SELECT * FROM authorization_requests WHERE id = ? AND expires_at >= ?").get(id, Date.now()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      state: row.state ? String(row.state) : null,
      codeChallenge: String(row.code_challenge),
      scope: String(row.scope),
      resource: String(row.resource),
      expiresAt: Number(row.expires_at),
    };
  }

  consumeAuthorizationRequest(id: string): AuthorizationRequest | null {
    const request = this.getAuthorizationRequest(id);
    if (request) {
      this.db.prepare("DELETE FROM authorization_requests WHERE id = ?").run(id);
    }
    return request;
  }

  upsertMerchant(input: {
    storeUrl: string;
    username: string;
    appPassword: string;
    encryptionKey: Buffer;
  }): Merchant {
    const id = randomUUID();
    const encryptedAppPassword = encryptSecret(input.appPassword, input.encryptionKey);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO merchants (id, store_url, username, encrypted_app_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_url, username) DO UPDATE SET
        encrypted_app_password = excluded.encrypted_app_password,
        updated_at = excluded.updated_at
    `).run(id, input.storeUrl, input.username, encryptedAppPassword, now, now);
    return this.getMerchantByIdentity(input.storeUrl, input.username)!;
  }

  getMerchant(id: string): Merchant | null {
    const row = this.db.prepare("SELECT * FROM merchants WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMerchant(row) : null;
  }

  private getMerchantByIdentity(storeUrl: string, username: string): Merchant | null {
    const row = this.db.prepare("SELECT * FROM merchants WHERE store_url = ? AND username = ?").get(storeUrl, username) as Record<string, unknown> | undefined;
    return row ? this.mapMerchant(row) : null;
  }

  private mapMerchant(row: Record<string, unknown>): Merchant {
    return {
      id: String(row.id),
      storeUrl: String(row.store_url),
      username: String(row.username),
      encryptedAppPassword: String(row.encrypted_app_password),
    };
  }

  createAuthorizationCode(request: AuthorizationRequest, merchantId: string): string {
    const code = randomToken(32);
    this.db.prepare(`
      INSERT INTO authorization_codes
        (code_hash, merchant_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sha256(code),
      merchantId,
      request.clientId,
      request.redirectUri,
      request.codeChallenge,
      request.scope,
      request.resource,
      Date.now() + 5 * 60_000,
    );
    return code;
  }

  consumeAuthorizationCode(code: string): AuthorizationCode | null {
    const row = this.db.prepare(`
      SELECT * FROM authorization_codes
      WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?
    `).get(sha256(code), Date.now()) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE authorization_codes SET used_at = ? WHERE code_hash = ?").run(Date.now(), sha256(code));
    return {
      merchantId: String(row.merchant_id),
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      scope: String(row.scope),
      resource: String(row.resource),
    };
  }

  createTokens(grant: AccessGrant, accessTtlSeconds: number, refreshTtlSeconds: number): {
    accessToken: string;
    refreshToken: string;
  } {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(40);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO access_tokens
        (token_hash, merchant_id, client_id, scope, resource, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sha256(accessToken), grant.merchantId, grant.clientId, grant.scope, grant.resource, now + accessTtlSeconds * 1000);
    this.db.prepare(`
      INSERT INTO refresh_tokens
        (token_hash, merchant_id, client_id, scope, resource, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sha256(refreshToken), grant.merchantId, grant.clientId, grant.scope, grant.resource, now + refreshTtlSeconds * 1000);
    return { accessToken, refreshToken };
  }

  validateAccessToken(token: string, expectedResource: string): AccessGrant | null {
    const row = this.db.prepare(`
      SELECT merchant_id, client_id, scope, resource FROM access_tokens
      WHERE token_hash = ? AND resource = ? AND revoked_at IS NULL AND expires_at >= ?
    `).get(sha256(token), expectedResource, Date.now()) as Record<string, unknown> | undefined;
    return row ? this.mapGrant(row) : null;
  }

  consumeRefreshToken(token: string, clientId: string): AccessGrant | null {
    const tokenHash = sha256(token);
    const row = this.db.prepare(`
      SELECT merchant_id, client_id, scope, resource FROM refresh_tokens
      WHERE token_hash = ? AND client_id = ? AND revoked_at IS NULL AND expires_at >= ?
    `).get(tokenHash, clientId, Date.now()) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?").run(Date.now(), tokenHash);
    return this.mapGrant(row);
  }

  revokeToken(token: string): void {
    const tokenHash = sha256(token);
    const now = Date.now();
    const row = this.db.prepare(`
      SELECT merchant_id FROM access_tokens WHERE token_hash = ?
      UNION
      SELECT merchant_id FROM refresh_tokens WHERE token_hash = ?
      LIMIT 1
    `).get(tokenHash, tokenHash) as { merchant_id: string } | undefined;
    this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ?").run(now, tokenHash);
    this.db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?").run(now, tokenHash);
    if (row) {
      const active = this.db.prepare(`
        SELECT 1 FROM refresh_tokens
        WHERE merchant_id = ? AND revoked_at IS NULL AND expires_at >= ?
        LIMIT 1
      `).get(row.merchant_id, now);
      if (!active) {
        this.db.prepare("DELETE FROM merchants WHERE id = ?").run(row.merchant_id);
      }
    }
  }

  private mapGrant(row: Record<string, unknown>): AccessGrant {
    return {
      merchantId: String(row.merchant_id),
      clientId: String(row.client_id),
      scope: String(row.scope),
      resource: String(row.resource),
    };
  }
}
