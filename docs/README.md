# Mintlify documentation

This directory is the Mintlify project root. `docs.json` references the generated local `openapi.json`. The canonical source is `../contracts/public-openapi.json`.

Run `node sync-openapi.cjs` after changing the canonical contract. It copies the contract, including the currently configured temporary demo origin. To use an operator-provided demo URL, run:

```sh
ANCHOR_PUBLIC_URL=https://your-current-demo-host.example node sync-openapi.cjs
```

Use the actual HTTPS origin of the public gateway, with no API prefix. This changes only the documentation copy, not runtime configuration. An example hostname is not a deployed service.

Choose this directory as the documentation root when connecting the repository to Mintlify. Only the files in this documentation root and the public specification belong in the publication. Do not add runtime configuration, internal callback schemas, `.local-platform`, private files, database files, signed tokens or receipts containing personal data.

With the Mint CLI installed, run `mint dev` from this directory and validate the OpenAPI document using the project's validator. A working local preview does not prove a public tunnel is reachable.

Before publishing, verify:

1. The public origin in `openapi.json` matches the running gateway and the SEP-1 URLs.
2. The issuer, delivery method, limits and synthetic fixture mapping match runtime configuration.
3. `scripts/demo-payment.js` and its options match the quickstart.
4. Protected calls fail without a valid partner token.
5. A real demonstration trace supports any completed-payment screenshots.

Protocol implementation reference: Stellar Anchor Platform tag `2.11.2`, commit `a551cea2fb801d52cce2528be7e60f0620e57bfa`, especially its SEP controller and API-schema Java classes. The public contract deliberately covers only the enabled demonstration workflow.
