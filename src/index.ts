import { loadConfig } from "./config.js";
import { ServiceDatabase } from "./database.js";
import { createApp } from "./server.js";

const config = loadConfig();
const database = new ServiceDatabase(config.databasePath);
database.cleanupExpired();
const cleanupInterval = setInterval(() => database.cleanupExpired(), 15 * 60_000);
cleanupInterval.unref();

const app = createApp(config, database);
const server = app.listen(config.port, config.host, () => {
  console.log(`WooCommerce Insights MCP listening at ${config.publicBaseUrl}/mcp`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down`);
  clearInterval(cleanupInterval);
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
