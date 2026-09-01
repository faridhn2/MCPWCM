# ChatGPT plugin and Claude connector release checklist

## Before public deployment

- Choose the final HTTPS domain and set `PUBLIC_BASE_URL` to its origin.
- Replace `https://mcp.your-domain.example/mcp` in `plugins/woocommerce-insights/.mcp.json`.
- Publish support, privacy, and terms pages on the verified publisher domain.
- Add rate limiting, encrypted backups, monitoring, and a disaster-recovery test.
- Run `npm run check` and test every tool with MCP Inspector.
- Test at least one small, one empty, and one large WooCommerce store.

## ChatGPT developer test

1. Enable Developer mode under ChatGPT Settings → Security and login.
2. In ChatGPT Plugins, create a connection using the public `https://<domain>/mcp` URL.
3. Complete OAuth with a test WooCommerce store and review the seven discovered tools.
4. Copy the generated technical ID (`plugin_asdk_app...`) if packaging a locally installable ChatGPT plugin.
5. Replace the direct MCP companion with an `.app.json` mapping for that registered connection, and point the manifest's `apps` field to it.
6. Install from a local marketplace, start a new chat, and run the evaluation cases below.

The checked-in `.mcp.json` package remains useful for direct MCP consumers. A ChatGPT `.app.json` cannot be finalized before ChatGPT generates the registered connection ID.

## Claude connector test

1. Open Claude → Customize → Connectors → Add custom connector.
2. Enter the same public `https://<domain>/mcp` URL.
3. Complete the OAuth flow and enable the connector in a conversation.
4. Run the same evaluation cases.

For Claude Team or Enterprise, an Owner must first add the custom web connector under Organization settings → Connectors.

## Positive evaluation cases

| Prompt | Expected tool |
|---|---|
| How many products and orders are in my store? | `get_store_overview` |
| Find published mugs that are in stock. | `search_products` |
| Summarize sales for August 2026. | `get_sales_summary` |
| Which five products made the most revenue last month? | `get_top_products` |
| Which products have five units or fewer? | `get_inventory_alerts` |

## Negative evaluation cases

| Prompt | Expected behavior |
|---|---|
| Change product 42's price. | Explain that the connector is read-only; call no tool. |
| Give me every customer's email address. | Explain that direct customer identifiers are intentionally excluded. |
| Delete cancelled orders. | Explain that destructive order operations are unsupported; call no tool. |

## Public ChatGPT submission materials still required

- Verified developer or business identity.
- Final name, descriptions, logo, category, website, support, privacy, and terms URLs.
- Public MCP URL plus domain-verification access.
- Five positive and three negative test cases (the cases above are a starting set).
- Countries/regions, release notes, and policy attestations.
