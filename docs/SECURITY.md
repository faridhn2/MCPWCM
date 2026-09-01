# Security model

This first release is read-only. It does not expose MCP tools that create, update, or delete WooCommerce records.

## Credential boundaries

- A merchant enters a WordPress username and application password in the service's OAuth consent page.
- The service verifies the credentials against that merchant's WooCommerce REST API.
- The application password is encrypted with AES-256-GCM before it is stored. The encryption key comes only from `CREDENTIAL_ENCRYPTION_KEY`.
- OAuth access and refresh tokens are random opaque values; only SHA-256 hashes are stored.
- Tool results never contain the WordPress username, application password, OAuth tokens, customer names, email addresses, phone numbers, or street addresses.
- Disconnecting the final active OAuth grant removes the merchant record. Expired, unreferenced merchant records are purged by maintenance cleanup.

## Network controls

Production store URLs must use HTTPS on the standard port. Localhost, private networks, link-local addresses, and reserved IP ranges are rejected. DNS is checked before each WooCommerce request. `ALLOW_PRIVATE_WOO_HOSTS=true` bypasses these protections and is for local development only.

Run the service behind a TLS-terminating reverse proxy or managed HTTPS load balancer. Set `PUBLIC_BASE_URL` to the exact public origin used by clients. Do not log request bodies or authorization headers at the proxy.

## Production checklist

- Store the encryption key in a secret manager and back it up separately from the database.
- Restrict access to the SQLite volume and encrypted backups.
- Add edge rate limits to `/oauth/register`, `/oauth/authorize`, `/oauth/token`, and `/mcp`.
- Set request-body limits at the proxy to match or reduce the application limits.
- Monitor failed OAuth, WooCommerce 401/403, and MCP 5xx rates without logging secrets.
- Rotate application passwords immediately if the encryption key or database might be compromised.
- Keep dependencies patched and rerun `npm audit` plus the test suite before releases.
- For horizontal scaling, replace SQLite and authorization-request state with PostgreSQL or another shared transactional store.

## Known MVP constraint

SQLite makes this deployment a single-replica service. It is durable for a small production pilot, but it is not the intended database for multiple application replicas.
