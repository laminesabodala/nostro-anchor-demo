# Nostro on Stellar: milestones and budget

Three tranches from December 5, 2026 to April 6, 2027. Total budget: $118,000 (tranche 1: $41,300; tranche 2: $49,600; tranche 3: $27,100). Components and building blocks carry the names used in the architecture.

---

## Tranche 1 — Stellar core: Anchor Platform, DFNS and Bridge implemented ($41,300)

### 1.1 Anchor Platform 5.0 and business callbacks: restricted SEP-10, SEP-38 quotes in USDC, EURC, USDT0 and EURCV, stellar-anchor-tests

**Description.** Upgrade of the receiving anchor from version 2.11.2 to 5.0 (pinned by digest), with the production configuration: mandatory client attribution and domain allow list on SEP-10, signed and verified callbacks, events processed idempotently by ID and stage, state transitions only forward through the JSON-RPC `notify_*` methods. The `GET /rate` callback serves firm quotes per accepted asset: USDC at the payout bank's rate plus the route fee, EURC and EURCV at the fixed peg minus the route fee, USDT0 at the conversion price to USDC returned by Stellar Broker's quoting API, with a protection margin and a maximum to spend. `/sep31/info` and `/sep38/info` expose the four assets (EURCV on the routes that list it) and the `bank_account` and `mobile_money` methods. The official `stellar-anchor-tests` suite runs in CI on SEP-1, 10, 12, 31 and 38.

**How completion is measured.**
- The testnet sandbox answers on Anchor Platform 5.0 and the run of October 20, 2026 (six-step quickstart) replays identically after the testnet reset of December 16, 2026 (accounts recreated), signed result archived in the repository.
- `stellar-anchor-tests` passes on the five enabled SEPs, output published by the repository's CI.
- A Stellar account outside the domain allow list gets no SEP-10 token; an approved payment business gets one (public tests).
- A firm USDC quote and a firm EURC quote to XOF are issued on testnet with `fee_details` and `expires_at` at ten minutes; in mainnet configuration, an indicative USDT0 quote to XOF is issued with the Stellar Broker conversion price and the maximum to spend (response published, no execution); the eleventh open quote request from the same account is refused (public tests).

**Budget.** $10,700

**Delivery date.** December 16, 2026

### 1.2 DFNS: Nostro's operational accounts under signing policies, Refund service and orphaned-funds runbook

**Description.** Key service on the DFNS API: creation of Nostro's operational accounts (anchor signing key, one receiving account per bank and per route that needs one, refund account), signing policies per account (payments to a single destination only for receiving accounts, with SEP-10 challenge signing allowed; per-transaction and daily caps plus two named passkey approvals for the refund account; challenge and callback signing only for the anchor key), policy changes reserved to an administrator quorum, idempotency key per signing request. Refund service: refund state machine (`refunds`), two-approval flow in DFNS, return payment to the sender's account with the original memo or the `refund_memo`, ledger entry, `notify_refund_sent` with the hash. "Orphaned funds" runbook written and rehearsed on testnet: expired quote, under- or overpayment, beneficiary rejected without correction, wrong asset or unknown memo, unallocated partner batch.

**How completion is measured.**
- On testnet, a sweep from a receiving account to its registered destination is signed by DFNS; the same request to any other address is refused by the policy (public tests, request log published).
- A refund with a single approval or above the cap is not signed; with two approvals it is, and lands on testnet, hash published (public tests).
- The anchor's SEP-10 challenge is signed by DFNS; a payment request with that key is refused (public test).
- Each runbook case produces its refund transaction on testnet, listed with its hash; the runbook is public in the documentation repository.

**Budget.** $8,300

**Delivery date.** December 25, 2026

### 1.3 Bank routing service and unique Bridge settlement instructions per payment

**Description.** Nostro core service answering the `GET /unique-address` callback: it picks the payout bank for a payment from the route (corridor, payout method, amount, active mandate and XOF position), creates that payment's settlement instruction and returns to the platform the unique Stellar address and memo the sender must pay. Bridge adapter, first part: bank onboarding (Bridge customer, correspondent account as external account, Stellar USDC and EURC liquidation addresses), one Bridge transfer per payment with Stellar as source and reading of its deposit instructions, reception and verification of transfer webhooks (signature, replay, idempotency), `funds_received`, `payment_submitted`, `payment_processed` states with the Stellar hash and the transfer reference, against the Bridge API in sandbox mode. `settlement_routes` and `settlement_instructions` tables, mandate enforcement before any instruction. The eight pre-payout checks (network, asset and pinned issuer, destination, identification, amount, timing, sender, uniqueness) are implemented and every failure holds the payment.

**How completion is measured.**
- On testnet, two SEP-31 payments to two test banks receive two distinct Bridge instructions (address and memo) and are each reconciled to their bank; the `funds_received` webhook carries the payment's Stellar hash and the transfer reaches `payment_processed` in the Bridge sandbox (IDs and hashes published).
- A payment with the wrong issuer, an unknown memo, a different amount or received after the quote expired ends in `HELD_FOR_REVIEW` or `EXPIRED` with no payout (public test suite, one case per check).
- A webhook with an invalid signature or replayed is rejected; a valid webhook delivered twice produces one entry; a transfer in `returned` or `error` opens an exception and blocks new instructions on the route (public tests).
- A payment above the mandate limit or with insufficient XOF position waits and triggers the bank alert (public test).

**Budget.** $10,700

**Delivery date.** January 5, 2027

### 1.4 Double-entry ledger, outbox and Payment watcher with Horizon catch-up

**Description.** Append-only double-entry journal (accounts `settlement_in_transit`, `payout_obligation`, `fiat_receivable`, `fiat_due_to_bank`, `fiat_settled`, `xof_available`, `xof_reserved`, `xof_paid_out`, `fx_and_partner_fees`, `held_for_review`) written in the same database transaction as the payment state and the outbox row; workers claiming rows with `SELECT … FOR UPDATE SKIP LOCKED`; unique idempotency key per PI-SPI instruction; `PAYOUT_UNCERTAIN` queried by reference before any retry. Payment watcher: reading expected payments through Stellar RPC in real time on the instructions and on the receiving accounts, Horizon catch-up after an outage, cross-check against the counterparty's event before `notify_onchain_funds_received` (two signals or a hold, never one alone), persistent cursor; check of the asset and amount received by the destination, whatever the sender converted beforehand.

**How completion is measured.**
- For a complete testnet payment, the published ledger entries balance in each currency and the flow accounts return to zero (public test on the 100 EURC example).
- Two workers claiming the same payment produce a single PI-SPI instruction; the same platform event delivered twice produces one entry (public tests).
- The watcher stopped during a testnet payment then restarted catches the payment up through Horizon without counting it twice (public test, log published).
- A deposit read by the watcher with no matching Bridge event, and a Bridge event with no matching reading, each open an exception and no payout; a testnet payment that arrives through a path payment (XLM to test USDC) is confirmed on the asset and amount received, not sent (public tests).

**Budget.** $11,600

**Delivery date.** January 17, 2027

---

## Tranche 2 — Every source proven: Bridge, Koywe, MoneyGram, Stellar Wallets Kit, Stellar Broker, CCTP and USDT0 implemented ($49,600)

### 2.1 Collections: Bridge virtual accounts, Koywe adapter and MoneyGram Ramps to the receiving accounts

**Description.** Bridge adapter, second part: EUR (SEPA), GBP (Faster Payments) and USD (ACH, Wire) virtual accounts delivering to the bank's liquidation address with the incoming transfer reference, drains reconciled by `deposit_tx_hash`. Koywe adapter: merchant verification, registration of the bank's receiving account as destination account, `ONRAMP` quotes from local currency to USDC on Stellar, order creation, `order.paid` and `order.completed` webhooks, reconciliation by order ID, in the Koywe sandbox. MoneyGram adapter: SEP-10 and SEP-24 client of MoneyGram Ramps, opening of a deposit transaction for the receiving account with the payment's memo, MoneyGram flow inside the app, tracking to `completed`, in the MoneyGram test environment. Sweeps from the receiving accounts to the Bridge liquidation address by the Key service (single-destination policy), `sweeps` table, exact allocation of batches with settlement report, residual balance monitored.

**How completion is measured.**
- A test transfer to a USD virtual account in the Bridge sandbox produces a delivery on Stellar reconciled to the transfer reference and a drain with `deposit_tx_hash` (log published).
- A test Koywe order (local currency to USDC on Stellar) is delivered to the test receiving account, reconciled to its order ID, swept to the liquidation address, drain reconciled (IDs and hashes published).
- A SEP-24 deposit transaction opened with the MoneyGram test environment for the receiving account reaches `completed`, the delivery carries the payment's memo, the sweep follows (IDs and hashes published).
- A batch whose settlement report does not equal the on-chain amount is held whole; a residual balance on a receiving account above the threshold opens an exception (public tests).

**Budget.** $14,900

**Delivery date.** February 1, 2027

### 2.2 Partner Portal: Stellar Wallets Kit, SEP-7 links and USDT0 route quoted by Stellar Broker

**Description.** React and Vite application with Stellar Wallets Kit v2: a payment business signs in with its own wallet (Freighter, xBull and the other wallets of the kit), signs the SEP-10 challenge in the page, registers its SEP-12 customers, requests a SEP-38 quote, creates the SEP-31 payment and signs the payment itself to the instruction's address and memo, with network passphrase, issuer and trustline checks before signing. Payment in USDT0: the portal opens a Stellar Broker session (USDT0 sold from the partner's account, routed across the DEX and the Soroban pools, slippage tolerance set so that the USDC received covers the instruction), the partner's wallet signs the swap transactions through the session's signing callback, then the portal builds and has the partner sign the USDC payment to the instruction, within the quote; no payment is sent before the USDC is in the account. The `/sandbox/auth` and `/sandbox/payments/{id}/fund` helpers are removed from the production environment. SEP-7 payment links and QR codes for customers paying in USDC or EURC, destination, asset, amount and memo prefilled.

**How completion is measured.**
- A complete testnet SEP-31 payment (SEP-10, SEP-12, SEP-38, SEP-31, payment signature) run from the portal with at least two wallets of the kit, hashes published.
- On testnet, the portal's conversion step (a test asset to test USDC, slippage tolerance set so that the USDC received covers the instruction amount) is followed by the USDC payment to the instruction; the same conversion with a tolerance that cannot be met stops and no payment is sent (public tests, hashes published).
- A USDT0 conversion quote obtained on mainnet from Stellar Broker for an amount of a few units is displayed with its price, minimum received and maximum to spend (screenshot and response published; no mainnet execution at this stage).
- A SEP-7 link paid from a SEP-7 wallet on testnet is reconciled to its payment and credited (hash published); a payment signed to a wrong passphrase or a wrong issuer is blocked in the page before submission (public test).

**Budget.** $12,400

**Delivery date.** February 14, 2027

### 2.3 Paying from another chain: CCTP V2 for USDC and LayerZero OFT for USDT0

**Description.** In the Partner Portal, connection of the source-chain wallet (wagmi for Ethereum, Base and Arbitrum, wallet adapter for Solana) next to the Stellar wallet. USDC through CCTP V2: USDC trustline check on the partner's Stellar account, `depositForBurnWithHook` with `mintRecipient` and `destinationCaller` set to Stellar's `CctpForwarder` (domain 27) and the partner's account encoded in the hook data, Circle attestation tracking, submission to `mint_and_forward`, handling of the message's six decimals and Stellar's seven. USDT through USDT0: `quote_oft` then `send` on the source chain's OFT contract towards Stellar, `amount_received_ld` receipt compared with the expected amount, USDT0 trustline checked, tracking on LayerZero Scan. In both cases, display of the hash of each step and creation of the Bridge instruction only once the funds are on Stellar, then chaining into the payment of 2.2.

**How completion is measured.**
- A testnet CCTP transfer (test USDC from Ethereum Sepolia or Base Sepolia to Stellar testnet) run from the portal lands on the partner's test Stellar account through `mint_and_forward`, then funds a testnet SEP-31 payment; hashes on both chains published.
- The portal refuses to start a CCTP transfer to a Stellar account with no USDC trustline, and offers no field where `mintRecipient` could be anything other than the `CctpForwarder` (public tests).
- A USDT0 transfer of a few cents from Ethereum to Stellar mainnet run by the team from the portal lands on the test account, the `amount_received_ld` receipt matches the displayed amount (hashes published; USDT0 has no testnet).
- A testnet CCTP transfer of 1.234567 test USDC from Base Sepolia mints exactly 1.2345670 on Stellar testnet (message amount 1234567, seven-decimal balance 12345670), and the reverse transfer of 0.1234567 test USDC from Stellar burns 0.1234560 and leaves 0.0000007 in the source account, amounts published (public decimals test).

**Budget.** $11,600

**Delivery date.** February 26, 2027

### 2.4 Bank Console, six-way reconciliation, threat model and monitoring plan

**Description.** Bank Console on the Bank Operations API: view per payment and per source (bank transfer, Koywe, MoneyGram, stablecoin, SEP-31), XOF payout, conversion, currency received, approval of the mandate and its changes (limits, routes, settlement asset, enabled collection sources), exceptions with owner and status, daily reports; row-level security per bank. Six-way daily reconciliation (Bridge, Koywe, MoneyGram, Stellar through the platform and through Horizon including the receiving accounts, PI-SPI, correspondent account), suspension of new instructions on a route with an unexplained break. Threat model and monitoring plan published: threats by category with their mitigation (including the wrong CCTP recipient, USDT0 truncation, the Stellar Broker price, DFNS policies, partner batches), alerts by status and timeout, weekly `stellar-anchor-tests`.

**How completion is measured.**
- A session of bank A requesting bank B's data is refused by row-level security (public test).
- An injected break between a Bridge drain and a ledger entry, and an injected break between a Koywe order and the on-chain delivery, each open an exception in the console and suspend the route (public tests, screenshots published).
- The threat model and the monitoring plan are public in the documentation repository, each threat linked to a mitigation or an accepted residual risk.
- An injected event (payment stuck in `pending_receiver` beyond five minutes, refused DFNS signing request, residual balance on a receiving account) triggers its alert (public tests).

**Budget.** $10,700

**Delivery date.** March 9, 2027

---

## Tranche 3 — Mainnet: every building block in production ($27,100)

### 3.1 Mainnet launch: anchor, DFNS, first Bridge route and USDT0 route

**Description.** Anchor Platform 5.0 in mainnet configuration: production `stellar.toml` with USDC, EURC and USDT0, signing key at DFNS, client attribution, callbacks and events in production; Nostro's operational accounts created at DFNS in production with their policies; Bridge adapter against the production Bridge API for the first payout bank (verified Bridge customer, registered correspondent account, liquidation addresses, per-payment instructions); USDT0 route in production with Stellar Broker; ledger, outbox, watcher, Refund service and monitoring in production; production PI-SPI under the payout bank's sponsorship, enabled for the first tested beneficiary institution.

**How completion is measured.**
- SEP-31 payments of a few units run by the team on mainnet, in USDC, EURC and USDT0 (converted through Stellar Broker, then paid in USDC), each addressed to a Bridge instruction created for it, with Stellar hash, conversion reference and payout reference published.
- `stellar-anchor-tests` passes against the production endpoint, output published.
- A refund of a few units run on mainnet from the refund account at DFNS, with its two approvals, hash published.
- Monitors active and alert channel documented.

**Budget.** $10,700

**Delivery date.** March 20, 2027

### 3.2 Collections, Partner Portal and payments from another chain in production

**Description.** EUR, GBP and USD virtual accounts of the first bank in production at Bridge, delivering to its Stellar liquidation addresses; Koywe in production (verified merchant, registered receiving account) and MoneyGram Ramps in production under the access agreement, both once our counsel's opinion on transitory holding is given (architecture, section 14); the first bank's receiving accounts at DFNS with sweeps in production; SEP-7 links in production; Partner Portal in mainnet configuration, payments from another chain through CCTP V2 and USDT0 enabled for approved payment businesses.

**How completion is measured.**
- A transfer of a few units pushed by the team to a USD virtual account produces a USDC delivery on Stellar mainnet reconciled to its reference, then a drain with `deposit_tx_hash` (log published).
- A Koywe order of a few units in local currency and a cash deposit of a few units at MoneyGram, run by the team, are delivered to the mainnet receiving account, swept to the liquidation address and paid to the bank (IDs, hashes and drains published).
- A complete mainnet SEP-31 payment run from the Partner Portal with a wallet of the kit, and a payment funded by a mainnet CCTP transfer of a few units from Base or Ethereum, hashes on both chains published.
- A SEP-7 link paid on mainnet by the team is reconciled and credited, hash published.

**Budget.** $9,900

**Delivery date.** March 30, 2027

### 3.3 EURCV route and integration guide for payment businesses

**Description.** EURCV route for a payout bank that holds a redemption account at the issuer: the bank's EURCV receiving account at DFNS with redemption at SG-FORGE as the only allowed destination, presentation for redemption, `/sep31/info` listing EURCV on that route only, pinned issuer. Public integration guide for a payment business: discovery, SEP-10, SEP-12, quotes in four assets, settlement instruction, USDT0 conversion before payment, arrival from another chain, tracking, failure cases and refunds, with a reference client.

**How completion is measured.**
- An EURCV payment of a few units run by the team on mainnet to the route's receiving account, then presented for redemption, Stellar hash and redemption reference published.
- An EURCV payment on a route that does not list it is refused at quote time (public test).
- The integration guide is public and the reference client runs a complete testnet SEP-31 payment end to end, including a quoted conversion before payment.

**Budget.** $6,500

**Delivery date.** April 6, 2027

## Tranche #3 Onchain Metric Information

**1. What metric do you plan to measure (must be NAV, volume, or something similar)?** We measure the cumulative volume of mainnet payments settled through the Nostro anchor: SEP-31 payments from payment businesses and SEP-7 funding from customers, in USDC, EURC and USDT0 (converted to USDC before payment), counted in USD equivalent at the rate of the settlement day. Alongside this volume we publish the number of settled payments and the number of distinct sender wallets, with the team's own accounts excluded.

**2. What is your completion target?** Our target is a cumulative settled volume of at least 50,000 USD equivalent, carried by at least 150 settled payments from at least 5 distinct approved sender wallets, measured from award acceptance to the submission of tranche 3; the first route goes live with deliverable 3.1, so the volume is expected in the last weeks of the window, and tranche 3 is submitted once the target is reached or, at the latest, 90 days after the tranche 2 payment, with the metric as it stands. The threshold is deliberately modest: it proves real usage of the first bank route, not a growth target.

**3. How will you track and report it?** The onchain footprint registered at award time: the anchor signing key, the receiving accounts and the refund account held at DFNS, and the issuers of the accepted assets. On direct routes, each payment is addressed to a settlement instruction that Nostro creates at Bridge, with an address and memo specific to the payment: these addresses are part of the footprint, published as they are created, and attribution relies on the list of hashes, each of which matches an instruction created by our Bridge account; we propose this method to the panel, which ratifies or adjusts it. Every settled payment carries a Stellar hash and a Bridge reference in our ledger; we publish a tracking page listing the hashes with their Stellar Expert link, updated weekly and attached to the tranche 3 report. Any shortfall against the target is reported as it stands.
