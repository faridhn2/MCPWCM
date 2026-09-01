import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  encryptionKey: Buffer;
  allowPrivateWooHosts: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const publicBaseUrl = new URL(
    process.env.PUBLIC_BASE_URL?.trim() || "http://localhost:3000",
  );
  publicBaseUrl.pathname = publicBaseUrl.pathname.replace(/\/$/, "");
  publicBaseUrl.search = "";
  publicBaseUrl.hash = "";
  if (process.env.NODE_ENV === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS when NODE_ENV=production");
  }

  const key = Buffer.from(required("CREDENTIAL_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64");
  }

  const databasePath = resolve(process.env.DATABASE_PATH || "./data/service.db");
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: positiveInteger("PORT", 3000),
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
    databasePath,
    encryptionKey: key,
    allowPrivateWooHosts: process.env.ALLOW_PRIVATE_WOO_HOSTS === "true",
    accessTokenTtlSeconds: positiveInteger("ACCESS_TOKEN_TTL_SECONDS", 3600),
    refreshTokenTtlSeconds: positiveInteger("REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600),
  };
}
