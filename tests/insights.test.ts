import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateSalesSummary, calculateTopProducts, inventoryAlerts } from "../src/insights.js";
import type { WooOrder, WooProduct } from "../src/woocommerce.js";

function order(input: Partial<WooOrder> & Pick<WooOrder, "id" | "status" | "total">): WooOrder {
  return {
    currency: "USD",
    date_created_gmt: "2026-08-01T00:00:00",
    date_paid_gmt: null,
    date_completed_gmt: null,
    discount_total: "0",
    shipping_total: "0",
    customer_id: 0,
    payment_method_title: "Card",
    line_items: [],
    refunds: [],
    ...input,
  };
}

test("sales summary includes paid-like statuses and subtracts refunds", () => {
  const orders = [
    order({
      id: 1,
      status: "completed",
      total: "100.00",
      customer_id: 8,
      refunds: [{ id: 9, total: "-10.00" }],
      line_items: [{ id: 1, name: "A", product_id: 10, variation_id: 0, quantity: 2, subtotal: "100", total: "100", sku: "A" }],
    }),
    order({ id: 2, status: "processing", total: "50.00" }),
    order({ id: 3, status: "cancelled", total: "999.00" }),
  ];
  assert.deepEqual(calculateSalesSummary(orders), {
    currency: "USD",
    order_count: 2,
    gross_sales: "150.00",
    refunds: "10.00",
    net_sales: "140.00",
    average_order_value: "75.00",
    items_sold: 2,
    registered_customer_orders: 1,
    guest_orders: 1,
    status_breakdown: { completed: 1, processing: 1, cancelled: 1 },
  });
});

test("top products aggregate variations and revenue", () => {
  const orders = [
    order({ id: 1, status: "completed", total: "80", line_items: [
      { id: 1, name: "Shirt", product_id: 10, variation_id: 11, quantity: 2, subtotal: "80", total: "80", sku: "SHIRT-B" },
    ] }),
    order({ id: 2, status: "processing", total: "60", line_items: [
      { id: 2, name: "Shirt", product_id: 10, variation_id: 11, quantity: 1, subtotal: "40", total: "40", sku: "SHIRT-B" },
      { id: 3, name: "Hat", product_id: 20, variation_id: 0, quantity: 1, subtotal: "20", total: "20", sku: "HAT" },
    ] }),
  ];
  assert.deepEqual(calculateTopProducts(orders, 1), [{
    product_id: 10,
    variation_id: 11,
    name: "Shirt",
    sku: "SHIRT-B",
    quantity: 3,
    gross_sales: "120.00",
    order_count: 2,
  }]);
});

test("inventory alerts include low managed stock and out-of-stock products", () => {
  const base = {
    id: 1, name: "A", slug: "a", permalink: "https://shop.test/a", type: "simple", status: "publish",
    sku: "A", price: "1", regular_price: "1", sale_price: "", on_sale: false, purchasable: true,
    total_sales: 0, average_rating: "0", rating_count: 0, categories: [], images: [], attributes: [],
    manage_stock: false, stock_quantity: null, stock_status: "instock",
    date_created_gmt: "", date_modified_gmt: "",
  } satisfies WooProduct;
  const products = [
    { ...base, id: 1, manage_stock: true, stock_quantity: 2, stock_status: "instock" },
    { ...base, id: 2, manage_stock: false, stock_quantity: null, stock_status: "outofstock" },
    { ...base, id: 3, manage_stock: true, stock_quantity: 20, stock_status: "instock" },
  ];
  assert.deepEqual(inventoryAlerts(products, 5).map((item) => item.id), [2, 1]);
});
