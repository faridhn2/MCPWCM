# Privacy policy template

> Replace bracketed publisher details, publish this document on your verified HTTPS domain, and have counsel review it before public submission.

**Effective date:** [date]

[Publisher] operates WooCommerce Insights, a service that lets a user connect a WooCommerce store to compatible AI assistants.

## Data processed

We store the connected store URL, WordPress username, encrypted WordPress application password, opaque OAuth grant records, and service timestamps. We retrieve product, inventory, order, and sales data from WooCommerce only when a connected assistant invokes a tool. This release does not intentionally return or persist customer names, email addresses, phone numbers, or street addresses in assistant tool results.

## Purpose and retention

We process this data only to authenticate the connection and answer the user's store-data requests. The final OAuth disconnection removes the corresponding stored merchant credential. Expired, unreferenced merchant credentials are automatically purged. Operational backups may retain encrypted records for [backup retention period].

## Security

Application passwords are encrypted at rest with AES-256-GCM. OAuth bearer and refresh tokens are stored as one-way hashes. Data is encrypted in transit with HTTPS.

## Sharing

Data is sent to the WooCommerce site selected by the user and to the AI client that invoked a tool. List every infrastructure processor here: [hosting provider], [logging/monitoring provider], and [backup provider]. We do not sell personal data.

## User choices

Users can revoke assistant access by disconnecting the connector. For access, deletion, or security requests, contact [support email].

## Contact

[Publisher legal name and address]\
[support email]\
[privacy contact]
