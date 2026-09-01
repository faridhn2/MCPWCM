import assert from "node:assert/strict";
import { test } from "node:test";
import { WooCommerceClient, WooCommerceError } from "../src/woocommerce.js";

test("WooCommerce client uses the WordPress subdirectory and Basic auth", async () => {
  let requestedUrl = "";
  let authorization = "";
  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = input.toString();
    authorization = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify([{ id: 1 }]), {
      status: 200,
      headers: { "content-type": "application/json", "x-wp-total": "1", "x-wp-totalpages": "1" },
    });
  };
  const client = new WooCommerceClient({
    storeUrl: "https://shop.example.com/wordpress",
    username: "owner",
    appPassword: "abcd",
    fetchImplementation: mockFetch,
    skipDnsValidation: true,
  });
  const result = await client.get<Array<{ id: number }>>("products", { per_page: 1 });
  assert.equal(requestedUrl, "https://shop.example.com/wordpress/wp-json/wc/v3/products?per_page=1");
  assert.equal(authorization, `Basic ${Buffer.from("owner:abcd").toString("base64")}`);
  assert.equal(result.total, 1);
});

test("WooCommerce client translates API errors", async () => {
  const client = new WooCommerceClient({
    storeUrl: "https://shop.example.com",
    username: "owner",
    appPassword: "wrong",
    fetchImplementation: async () => new Response(
      JSON.stringify({ code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources." }),
      { status: 401, headers: { "content-type": "application/json" } },
    ),
    skipDnsValidation: true,
  });
  await assert.rejects(
    () => client.verifyConnection(),
    (error: unknown) => error instanceof WooCommerceError && error.status === 401 && error.code === "woocommerce_rest_cannot_view",
  );
});
