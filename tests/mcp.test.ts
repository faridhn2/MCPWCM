import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMerchantMcpServer } from "../src/mcp.js";
import { WooCommerceClient, type WooOrder } from "../src/woocommerce.js";

test("MCP server advertises focused read-only tools and returns sales analytics", async () => {
  const orders: WooOrder[] = [{
    id: 1,
    status: "completed",
    currency: "EUR",
    date_created_gmt: "2026-08-01T00:00:00",
    date_paid_gmt: "2026-08-01T00:01:00",
    date_completed_gmt: "2026-08-02T00:00:00",
    discount_total: "0",
    shipping_total: "5",
    total: "45",
    customer_id: 7,
    payment_method_title: "Card",
    line_items: [{ id: 1, name: "Mug", product_id: 10, variation_id: 0, quantity: 2, subtotal: "40", total: "40", sku: "MUG" }],
    refunds: [],
  }];
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify(orders), {
    status: 200,
    headers: { "content-type": "application/json", "x-wp-total": "1", "x-wp-totalpages": "1" },
  });
  const woo = new WooCommerceClient({
    storeUrl: "https://shop.example",
    username: "owner",
    appPassword: "secret",
    fetchImplementation: mockFetch,
    skipDnsValidation: true,
  });
  const server = createMerchantMcpServer(woo);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "get_inventory_alerts",
        "get_product",
        "get_sales_summary",
        "get_store_overview",
        "get_top_products",
        "list_orders",
        "search_products",
      ],
    );
    assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);

    const result = await client.callTool({ name: "get_sales_summary", arguments: {} });
    assert.equal(result.isError, undefined);
    const content = result.structuredContent as Record<string, unknown>;
    assert.deepEqual({
      currency: content.currency,
      order_count: content.order_count,
      gross_sales: content.gross_sales,
      items_sold: content.items_sold,
    }, {
      currency: "EUR",
      order_count: 1,
      gross_sales: "45.00",
      items_sold: 2,
    });
  } finally {
    await client.close();
    await server.close();
  }
});
