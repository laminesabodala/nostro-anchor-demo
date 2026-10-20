# Official Stellar Anchor Platform sandbox

This is the official `stellar/anchor-platform:2.11.2` runtime, pinned by digest and source tag `release-2.11.2` (`a551cea2fb801d52cce2528be7e60f0620e57bfa`). It runs SEP-1/10/12/31/38, the Platform API, the event processor and the Stellar payment observer. It is not a hand-written substitute for these protocols.

The Compose project `nostro-anchor-demo` has its own PostgreSQL database and Kafka volume. It does not mount or migrate the existing Nostro mobile database. SEP HTTP binds to `127.0.0.1:8088`; the authenticated internal Platform API binds to `127.0.0.1:8089`. Database, Kafka and observer management ports are not published. Only the SEP port may be exposed through a demo HTTPS tunnel.

## Start

From `anchor-demo`, with Node 24 and Docker Desktop running:

```sh
node platform/prepare.cjs
node platform/fund-testnet.cjs
docker compose -f platform/compose.yaml up -d
```

`prepare.cjs` creates persistent local credentials in ignored `.local-platform/` (directory 0700, files 0600). It preserves existing wallet identities and credentials on rerun. `runtime.json` contains secrets, so do not publish it. Bank and sender signing keys stay on the host; the containers mount only the asset file and Stellar discovery file. Keep these local secrets to resume the same demo after restarting.

`fund-testnet.cjs` uses Stellar Friendbot for XLM and establishes Circle Testnet USDC trustlines. Request test USDC for the sender public key at the official [Circle faucet](https://faucet.circle.com/). Never use Public Network funds or wallet keys.

For HTTPS, start a tunnel to port 8088, update only `publicUrl` in `.local-platform/runtime.json`, run `prepare.cjs` again and recreate the platform/observer services. The SEP-10 home domain and all discovery URLs must match that URL. Do not tunnel port 8089 or the business callback port. A temporary ngrok URL may change after restart.

The business server must listen on port 3010 and implement the private callback base `http://host.docker.internal:3010/internal/anchor`. AP authenticates callbacks with `X-Api-Key: callbackApiKey`; requests to the private Platform API require `X-Api-Key: platformApiKey`. Both keys are generated locally.

## Demo configuration

- Stellar Testnet only; Circle Testnet USDC issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.
- One distribution account represents the bank's demo settlement wallet.
- Only the configured custodial sender wallet is approved by Nostro's business layer.
- SEP-12 types `sep31-sender` and `sep31-receiver` use synthetic identities.
- SEP-38 asset pair: Circle Testnet USDC → `iso4217:XOF`, delivery method `PI_SPI`.
- Firm quotes required; fixed fictional rate and 0.2–5 USDC limit enforced by the business callback. AP 2.11.2's published `min_amount` is an integer, so `/sep31/info` shows 0; the callback rejects quotes below 0.2.
- SEP-31 transaction fields are empty: the registered receiver identifies its allowlisted PI-SPI alias.
- AP creates `pending_sender` transactions and asks Nostro's authenticated `GET /internal/anchor/unique_address?transaction_id=...` callback for the destination account and unique memo. Nostro persists this immutable binding before returning it, so manual SEP requests and the sender script follow the same flow. The official observer associates received payments with those transactions. Nostro verifies funding before initiating virtual-money payout.
- Kafka delivers internal events; callbacks are authenticated with the shared API key. Business processing must be idempotent and reconcile uncertain bank responses before retrying.

## Verify and stop

```sh
node platform/check.cjs
curl http://127.0.0.1:8088/.well-known/stellar.toml
curl http://127.0.0.1:8088/sep31/info
docker compose -f platform/compose.yaml ps
docker compose -f platform/compose.yaml logs --tail 30 platform observer
# Stop only this demo; named volumes and records are retained:
docker compose -f platform/compose.yaml stop
```

Allow roughly 60–90 seconds for startup on Apple Silicon; the published AP image is AMD64 and runs under emulation. Container restarts preserve records. Do not use `down -v` unless deliberately deleting the isolated demo data.

This pinned demo release and its dependencies are not a production deployment recommendation. Production requires a current security/dependency review, durable hosting, key management, operational controls, and live settlement agreements.
