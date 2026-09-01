import express, { type NextFunction, type Request, type Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { ServiceDatabase, type AccessGrant } from "./database.js";
import { createMerchantMcpServer } from "./mcp.js";
import { createOAuthRouter } from "./oauth.js";
import { decryptSecret } from "./security.js";
import { WooCommerceClient } from "./woocommerce.js";

declare global {
  namespace Express {
    interface Request {
      accessGrant?: AccessGrant;
    }
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.header("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
}

export function createApp(config: AppConfig, database: ServiceDatabase) {
  const app = createMcpExpressApp({ host: config.host });
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });

  app.use(createOAuthRouter(config, database));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "woocommerce-insights-mcp", version: "0.1.0" });
  });
  app.get("/docs", (_request, response) => {
    response.type("text").send(
      [
        "WooCommerce Insights MCP",
        "",
        `MCP endpoint: ${config.publicBaseUrl}/mcp`,
        "OAuth scope: woo:read",
        "This service provides read-only, privacy-minimized WooCommerce product, order, inventory, and sales tools.",
      ].join("\n"),
    );
  });

  const requireBearer = (request: Request, response: Response, next: NextFunction) => {
    const token = bearerToken(request);
    const resourceUrl = `${config.publicBaseUrl}/mcp`;
    const grant = token ? database.validateAccessToken(token, resourceUrl) : null;
    if (!grant || !grant.scope.split(" ").includes("woo:read")) {
      const metadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;
      response.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${metadataUrl}", scope="woo:read"`,
      );
      response.status(401).json({
        error: "invalid_token",
        error_description: "A valid WooCommerce connector access token is required",
      });
      return;
    }
    request.accessGrant = grant;
    next();
  };

  app.post("/mcp", requireBearer, async (request, response) => {
    const merchant = database.getMerchant(request.accessGrant!.merchantId);
    if (!merchant) {
      response.status(401).json({ error: "invalid_token" });
      return;
    }
    const woo = new WooCommerceClient({
      storeUrl: merchant.storeUrl,
      username: merchant.username,
      appPassword: decryptSecret(merchant.encryptedAppPassword, config.encryptionKey),
      allowPrivateHosts: config.allowPrivateWooHosts,
    });
    const server = createMerchantMcpServer(woo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  app.get("/mcp", requireBearer, (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode" },
      id: null,
    });
  });
  app.delete("/mcp", requireBearer, (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode" },
      id: null,
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error("Unhandled request error", error);
    if (!response.headersSent) response.status(500).json({ error: "internal_server_error" });
  });
  return app;
}
