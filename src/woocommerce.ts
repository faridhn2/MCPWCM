import { assertPublicHostname } from "./security.js";

export class WooCommerceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "WooCommerceError";
  }
}

export interface WooImage {
  id: number;
  src: string;
  alt?: string;
}

export interface WooCategory {
  id: number;
  name: string;
  slug: string;
}

export interface WooProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  type: string;
  status: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  on_sale: boolean;
  purchasable: boolean;
  total_sales: number;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  average_rating: string;
  rating_count: number;
  categories: WooCategory[];
  images: WooImage[];
  attributes: Array<{
    id: number;
    name: string;
    variation: boolean;
    options: string[];
  }>;
  date_created_gmt: string;
  date_modified_gmt: string;
}

export interface WooOrderLineItem {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  subtotal: string;
  total: string;
  sku: string | null;
}

export interface WooOrder {
  id: number;
  status: string;
  currency: string;
  date_created_gmt: string;
  date_paid_gmt: string | null;
  date_completed_gmt: string | null;
  discount_total: string;
  shipping_total: string;
  total: string;
  customer_id: number;
  payment_method_title: string;
  line_items: WooOrderLineItem[];
  refunds: Array<{ id: number; total: string }>;
}

interface WooResponse<T> {
  data: T;
  total?: number;
  totalPages?: number;
}

interface WooClientOptions {
  storeUrl: string;
  username: string;
  appPassword: string;
  allowPrivateHosts?: boolean;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  skipDnsValidation?: boolean;
}

export class WooCommerceClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly authorization: string;
  private readonly allowPrivateHosts: boolean;
  private readonly timeoutMs: number;
  private readonly skipDnsValidation: boolean;

  constructor(private readonly options: WooClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.authorization = `Basic ${Buffer.from(`${options.username}:${options.appPassword}`).toString("base64")}`;
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.timeoutMs = options.requestTimeoutMs ?? 20_000;
    this.skipDnsValidation = options.skipDnsValidation ?? false;
  }

  async verifyConnection(): Promise<void> {
    await this.get<WooProduct[]>("products", { per_page: 1, status: "any" });
  }

  async get<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<WooResponse<T>> {
    const base = new URL(this.options.storeUrl);
    if (!this.skipDnsValidation) {
      await assertPublicHostname(base.hostname, this.allowPrivateHosts);
    }
    const safePath = path
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const wordpressPath = base.pathname.replace(/\/$/, "");
    const url = new URL(`${wordpressPath}/wp-json/wc/v3/${safePath}`, base.origin);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        headers: {
          Authorization: this.authorization,
          Accept: "application/json",
          "User-Agent": "WooCommerce-Insights-MCP/0.1",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      throw new WooCommerceError(`Could not reach WooCommerce: ${message}`, 502);
    }

    const payload = (await response.json().catch(() => null)) as
      | { code?: string; message?: string }
      | T
      | null;
    if (!response.ok) {
      const errorPayload = payload as { code?: string; message?: string } | null;
      throw new WooCommerceError(
        errorPayload?.message || `WooCommerce returned HTTP ${response.status}`,
        response.status,
        errorPayload?.code,
      );
    }
    return {
      data: payload as T,
      ...(response.headers.get("x-wp-total")
        ? { total: Number(response.headers.get("x-wp-total")) }
        : {}),
      ...(response.headers.get("x-wp-totalpages")
        ? { totalPages: Number(response.headers.get("x-wp-totalpages")) }
        : {}),
    };
  }

  async getAll<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    maxItems = 5_000,
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const response = await this.get<T[]>(path, {
        ...query,
        page,
        per_page: 100,
      });
      items.push(...response.data);
      totalPages = response.totalPages ?? page;
      page += 1;
    } while (page <= totalPages && items.length < maxItems);
    return items.slice(0, maxItems);
  }
}

export function publicProduct(product: WooProduct): Record<string, unknown> {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    type: product.type,
    status: product.status,
    permalink: product.permalink,
    price: product.price,
    regular_price: product.regular_price,
    sale_price: product.sale_price,
    on_sale: product.on_sale,
    purchasable: product.purchasable,
    total_sales: product.total_sales,
    stock_status: product.stock_status,
    stock_quantity: product.stock_quantity,
    average_rating: product.average_rating,
    rating_count: product.rating_count,
    categories: product.categories?.map(({ id, name, slug }) => ({ id, name, slug })) ?? [],
    image: product.images?.[0]
      ? { src: product.images[0].src, alt: product.images[0].alt || product.name }
      : null,
    attributes:
      product.attributes?.map(({ name, variation, options }) => ({ name, variation, options })) ?? [],
    created_at: product.date_created_gmt,
    updated_at: product.date_modified_gmt,
  };
}

export function privateSafeOrder(order: WooOrder): Record<string, unknown> {
  return {
    id: order.id,
    status: order.status,
    currency: order.currency,
    created_at: order.date_created_gmt,
    paid_at: order.date_paid_gmt,
    completed_at: order.date_completed_gmt,
    discount_total: order.discount_total,
    shipping_total: order.shipping_total,
    total: order.total,
    payment_method: order.payment_method_title,
    customer_type: order.customer_id > 0 ? "registered" : "guest",
    items:
      order.line_items?.map((item) => ({
        product_id: item.product_id,
        variation_id: item.variation_id,
        name: item.name,
        sku: item.sku,
        quantity: item.quantity,
        subtotal: item.subtotal,
        total: item.total,
      })) ?? [],
    refunds_total: Math.abs(
      order.refunds?.reduce((sum, refund) => sum + Number(refund.total || 0), 0) ?? 0,
    ).toFixed(2),
  };
}
