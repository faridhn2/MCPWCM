import type { WooOrder, WooProduct } from "./woocommerce.js";

const REVENUE_STATUSES = new Set(["processing", "completed", "on-hold"]);

function money(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

export interface SalesSummary {
  currency: string | null;
  order_count: number;
  gross_sales: string;
  refunds: string;
  net_sales: string;
  average_order_value: string;
  items_sold: number;
  registered_customer_orders: number;
  guest_orders: number;
  status_breakdown: Record<string, number>;
}

export function calculateSalesSummary(orders: WooOrder[]): SalesSummary {
  const statusBreakdown: Record<string, number> = {};
  for (const order of orders) {
    statusBreakdown[order.status] = (statusBreakdown[order.status] ?? 0) + 1;
  }
  const revenueOrders = orders.filter((order) => REVENUE_STATUSES.has(order.status));
  const gross = revenueOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const refunds = revenueOrders.reduce(
    (sum, order) =>
      sum + Math.abs(order.refunds?.reduce((refundSum, refund) => refundSum + Number(refund.total || 0), 0) ?? 0),
    0,
  );
  const itemsSold = revenueOrders.reduce(
    (sum, order) => sum + (order.line_items?.reduce((itemSum, item) => itemSum + item.quantity, 0) ?? 0),
    0,
  );
  const registeredOrders = revenueOrders.filter((order) => order.customer_id > 0).length;
  return {
    currency: revenueOrders[0]?.currency ?? orders[0]?.currency ?? null,
    order_count: revenueOrders.length,
    gross_sales: money(gross),
    refunds: money(refunds),
    net_sales: money(gross - refunds),
    average_order_value: money(revenueOrders.length ? gross / revenueOrders.length : 0),
    items_sold: itemsSold,
    registered_customer_orders: registeredOrders,
    guest_orders: revenueOrders.length - registeredOrders,
    status_breakdown: statusBreakdown,
  };
}

export interface ProductPerformance {
  product_id: number;
  variation_id: number;
  name: string;
  sku: string | null;
  quantity: number;
  gross_sales: string;
  order_count: number;
}

export function calculateTopProducts(orders: WooOrder[], limit: number): ProductPerformance[] {
  const products = new Map<string, {
    product_id: number;
    variation_id: number;
    name: string;
    sku: string | null;
    quantity: number;
    sales: number;
    orders: Set<number>;
  }>();
  for (const order of orders.filter((item) => REVENUE_STATUSES.has(item.status))) {
    for (const item of order.line_items ?? []) {
      const key = `${item.product_id}:${item.variation_id}`;
      const current = products.get(key) ?? {
        product_id: item.product_id,
        variation_id: item.variation_id,
        name: item.name,
        sku: item.sku,
        quantity: 0,
        sales: 0,
        orders: new Set<number>(),
      };
      current.quantity += item.quantity;
      current.sales += Number(item.total || 0);
      current.orders.add(order.id);
      products.set(key, current);
    }
  }
  return [...products.values()]
    .sort((left, right) => right.sales - left.sales || right.quantity - left.quantity)
    .slice(0, limit)
    .map((item) => ({
      product_id: item.product_id,
      variation_id: item.variation_id,
      name: item.name,
      sku: item.sku,
      quantity: item.quantity,
      gross_sales: money(item.sales),
      order_count: item.orders.size,
    }));
}

export function inventoryAlerts(products: WooProduct[], threshold: number): Array<Record<string, unknown>> {
  return products
    .filter(
      (product) =>
        product.stock_status === "outofstock" ||
        (product.manage_stock && product.stock_quantity !== null && product.stock_quantity <= threshold),
    )
    .sort((left, right) => (left.stock_quantity ?? -1) - (right.stock_quantity ?? -1))
    .map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      stock_status: product.stock_status,
      stock_quantity: product.stock_quantity,
      permalink: product.permalink,
    }));
}
