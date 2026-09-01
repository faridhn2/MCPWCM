import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  calculateSalesSummary,
  calculateTopProducts,
  inventoryAlerts,
} from "./insights.js";
import {
  privateSafeOrder,
  publicProduct,
  type WooOrder,
  type WooProduct,
  WooCommerceClient,
} from "./woocommerce.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function toolResult(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected WooCommerce error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function toDateRange(from?: string, to?: string): { after: string; before: string } {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 3600_000);
  const after = from ? new Date(`${from}T00:00:00.000Z`) : defaultFrom;
  const before = to ? new Date(`${to}T23:59:59.999Z`) : now;
  if (!Number.isFinite(after.getTime()) || !Number.isFinite(before.getTime()) || after > before) {
    throw new Error("The date range is invalid");
  }
  if (before.getTime() - after.getTime() > 366 * 24 * 3600_000) {
    throw new Error("Date range cannot exceed 366 days");
  }
  return { after: after.toISOString(), before: before.toISOString() };
}

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date in YYYY-MM-DD format");

export function createMerchantMcpServer(woo: WooCommerceClient): McpServer {
  const server = new McpServer(
    { name: "woocommerce-insights", version: "0.1.0" },
    {
      instructions:
        "Read-only WooCommerce data and analytics. Use get_sales_summary for revenue questions and search_products before get_product when the product ID is unknown. Order tools intentionally omit direct customer identifiers and addresses.",
    },
  );

  server.registerTool(
    "get_store_overview",
    {
      title: "Get store overview",
      description: "Get high-level product and order counts for the connected WooCommerce store.",
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        const [products, orders] = await Promise.all([
          woo.get<WooProduct[]>("products", { per_page: 1, status: "any" }),
          woo.get<WooOrder[]>("orders", { per_page: 1, status: "any" }),
        ]);
        return toolResult({
          product_count: products.total ?? products.data.length,
          order_count: orders.total ?? orders.data.length,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Find WooCommerce products by name, SKU, category ID, status, or stock status.",
      inputSchema: {
        search: z.string().trim().max(100).optional(),
        sku: z.string().trim().max(100).optional(),
        category_id: z.number().int().positive().optional(),
        status: z.enum(["publish", "draft", "pending", "private", "any"]).default("publish"),
        stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional(),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(50).default(20),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ search, sku, category_id, status, stock_status, page, per_page }) => {
      try {
        const response = await woo.get<WooProduct[]>("products", {
          search,
          sku,
          category: category_id,
          status,
          stock_status,
          page,
          per_page,
          orderby: "date",
          order: "desc",
        });
        return toolResult({
          products: response.data.map(publicProduct),
          page,
          total: response.total ?? response.data.length,
          total_pages: response.totalPages ?? 1,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Get full public catalog, pricing, inventory, rating, category, and attribute data for one product by ID or SKU.",
      inputSchema: {
        product_id: z.number().int().positive().optional(),
        sku: z.string().trim().min(1).max(100).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ product_id, sku }) => {
      try {
        if (!product_id && !sku) throw new Error("Provide product_id or sku");
        if (product_id && sku) throw new Error("Provide only one of product_id or sku");
        const product = product_id
          ? (await woo.get<WooProduct>(`products/${product_id}`)).data
          : (await woo.get<WooProduct[]>("products", { sku, per_page: 1, status: "any" })).data[0];
        if (!product) throw new Error("Product not found");
        return toolResult({ product: publicProduct(product) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "List privacy-minimized orders with totals and line items. Customer names, email, phone, and addresses are never returned.",
      inputSchema: {
        from: dateString.optional(),
        to: dateString.optional(),
        status: z.enum(["any", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "checkout-draft"]).default("any"),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(50).default(20),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ from, to, status, page, per_page }) => {
      try {
        const range = toDateRange(from, to);
        const response = await woo.get<WooOrder[]>("orders", {
          ...range,
          status,
          page,
          per_page,
          orderby: "date",
          order: "desc",
        });
        return toolResult({
          orders: response.data.map(privateSafeOrder),
          page,
          total: response.total ?? response.data.length,
          total_pages: response.totalPages ?? 1,
          privacy: "Direct customer identifiers and addresses are omitted.",
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_sales_summary",
    {
      title: "Get sales summary",
      description: "Calculate revenue, refunds, order count, average order value, items sold, and status mix for a date range (default: last 30 days).",
      inputSchema: { from: dateString.optional(), to: dateString.optional() },
      annotations: readOnlyAnnotations,
    },
    async ({ from, to }) => {
      try {
        const range = toDateRange(from, to);
        const orders = await woo.getAll<WooOrder>("orders", { ...range, status: "any" });
        return toolResult({
          range: { from: range.after, to: range.before },
          ...calculateSalesSummary(orders),
          revenue_statuses: ["processing", "completed", "on-hold"],
          truncated: orders.length >= 5_000,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_top_products",
    {
      title: "Get top products",
      description: "Rank products by sales revenue and quantity across orders in a date range (default: last 30 days).",
      inputSchema: {
        from: dateString.optional(),
        to: dateString.optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ from, to, limit }) => {
      try {
        const range = toDateRange(from, to);
        const orders = await woo.getAll<WooOrder>("orders", { ...range, status: "any" });
        return toolResult({
          range: { from: range.after, to: range.before },
          products: calculateTopProducts(orders, limit),
          truncated: orders.length >= 5_000,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_inventory_alerts",
    {
      title: "Get inventory alerts",
      description: "Find published products that are out of stock or at/below a chosen stock threshold.",
      inputSchema: {
        threshold: z.number().int().min(0).max(10_000).default(5),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ threshold }) => {
      try {
        const products = await woo.getAll<WooProduct>("products", { status: "publish" });
        const alerts = inventoryAlerts(products, threshold);
        return toolResult({
          threshold,
          alert_count: alerts.length,
          products: alerts,
          truncated: products.length >= 5_000,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
