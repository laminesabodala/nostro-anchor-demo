# Nostro Stellar payout demo

A working **official Stellar Anchor Platform 2.11.2 → Stellar Testnet USDC → PI-SPI sandbox** integration. This module is isolated from the mobile backend: separate checkout, dependencies, databases, wallets, credentials and ports. No mobile route or customer database migration is included.

## Start here

- [Mintlify-ready public OpenAPI](contracts/public-openapi.json)
- [Mintlify documentation project](docs/README.md)
- [Verified payment evidence](docs/verified-demo.mdx)
- [Official Anchor Platform setup](platform/README.md)

Current temporary public origin: **https://9239-88-86-232-107.ngrok-free.app**. It depends on this Mac, the running services and the ngrok tunnel; it is not permanent hosting.

## What the demo proves

1. A sending partner signs an official SEP-10 challenge.
2. SEP-12 registers synthetic sender and receiver fixtures.
3. SEP-38 returns a firm demo quote: 1 test USDC = 500 virtual XOF, no fee.
4. SEP-31 creates the payment. Anchor Platform requests a unique payment memo from Nostro.
5. The sender transfers Circle Testnet USDC to the bank-representative wallet with that memo.
6. The official Stellar observer detects funding. Nostro independently checks the actual Horizon payment, sender, destination, issuer, memo, amount and quote deadline.
7. Nostro sends virtual XOF through the real PI-SPI sandbox API, then reconciles its status.
8. Only `IRREVOCABLE` permits Nostro to report `completed` to Anchor Platform.

The XOF comes from a prefunded PI-SPI sandbox account. This does not demonstrate a real USDC-to-XOF conversion or atomic settlement. The bank wallet represents a bank for this demo; it is not a claim that a partner bank currently accepts USDC. KYC fixtures are synthetic. No production funds are involved.

## Run locally

Use Node 24, Docker Desktop and an authorized PI-SPI sandbox configuration. From this directory:

```sh
npm ci --ignore-scripts
node platform/prepare.cjs
node platform/fund-testnet.cjs
# Obtain Circle Testnet USDC for the generated sender if needed.
docker compose -f platform/compose.yaml up -d
node src/server.js
```

The business service reads PI-SPI credentials from `../../backend/.local-integrations/providers.json` by default. Set `PISPI_CONFIG_FILE` to a private JSON file with a `pispi` object containing `clientId`, `clientSecret` and `apiKey` to use another location. Credentials are never part of the public API or docs.

Configure the HTTPS origin as described in `platform/README.md`, then:

```sh
node platform/check.cjs
node scripts/demo-payment.js my-demo
```

That command performs the **entire** flow, paying 0.2 test USDC / 100 virtual XOF to Amina. Reuse exactly the same run name to resume or inspect the same payment. A different run name intentionally creates another payment. The approved sender wallet is local to this demo.

Run records and signed transactions are in ignored `.local/`; private keys are in ignored `.local-platform/`. Do not publish either directory. A process lock prevents simultaneous runs with the same name. If a process is interrupted, check that the PID in its lock is no longer running before removing that lock; never delete payment state to retry.

**macOS/iCloud:** run from a nonsynced checkout where possible. On this machine, dependencies are installed at `/private/tmp/nostro-anchor-dependencies/node_modules` and linked from `node_modules` because iCloud offloaded required files. Reinstall dependencies if that temporary directory is removed. Keep the local database available on disk; do not run two business processes against it.

## Components and state

| Component | Address / storage | Responsibility |
|---|---|---|
| Official Anchor Platform | SEP `127.0.0.1:8088`; private API `127.0.0.1:8089` | Protocols, SEP transactions, observer, events |
| Official platform storage | Dedicated Docker PostgreSQL/Kafka volumes | AP state and event delivery |
| Nostro business process | Port 3010; private callbacks require API key | Fixtures, quotes, funding references, payout/reconciliation |
| Nostro demo storage | `.local/business-db`, embedded PostgreSQL via PGlite | Customers, quotes, funding references, payout attempts and event IDs |
| Local signer | `scripts/demo-payment.js` | SEP-10 signing and Testnet payment, persisted before submission |
| Documentation | `docs/`, `contracts/` | Public protocol contract only |

Only port 8088 is tunneled. Do not expose the internal Platform API, callback service or databases. Payout polling uses the authenticated Platform API and persists the send intent before calling PI-SPI. A timeout never triggers a second submission: it queries the same PI-SPI transaction ID. Unique constraints prevent reusing a quote or Stellar operation for another payout. These controls have tests and real replay evidence, but do not make two independent networks atomic.

A rejected or ambiguous payment remains available for reconciliation; automatic refunds and a review console are outside this demo. The worker uses one process and bounded polling, intentionally suitable for this limited demonstration rather than production scale.

## Verify

```sh
npm test
node platform/check.cjs
node scripts/demo-payment.js callback-payment # Existing verified run on this machine: resume only
```

To import into Mintlify, deploy `docs/` as the documentation project or import `contracts/public-openapi.json`. If the tunnel changes, update runtime discovery first, then run:

```sh
ANCHOR_PUBLIC_URL=https://your-new-origin node docs/sync-openapi.cjs
```

The fixture accounts and fixed rate are deliberate sandbox limits. New partner banks will need an adapter, approved payout access, liquidity and live settlement arrangements; adding a name to a list is insufficient.

## Stop only this demo

Stop the foreground `node src/server.js` process gracefully, stop this demo's ngrok process, and run:

```sh
docker compose -f platform/compose.yaml stop
```

Keep volumes and local state to resume. None of these commands stops the mobile backend.
