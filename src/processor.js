"use strict";
const { amountUnits } = require("./business");
const { createPayments } = require("./payments");
const HORIZON = "https://horizon-testnet.stellar.org";
async function json(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("REMOTE_HTTP_" + r.status);
  return r.json();
}
function createProcessor({ db, config, pispi, fetchJson = json }) {
  const payments = createPayments({ db, config });
  const asset = `stellar:${config.assetCode}:${config.assetIssuer}`;
  const platform = (path, options = {}) =>
    fetchJson(config.platformUrl + path, {
      ...options,
      headers: {
        "X-Api-Key": config.platformApiKey,
        "Content-Type": "application/json",
      },
    });
  async function rpc(method, params) {
    const result = await platform("/", {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: params.transaction_id, method, params },
      ]),
    });
    const r = Array.isArray(result) ? result[0] : result;
    if (r.error) throw new Error("ANCHOR_RPC_" + r.error.code);
    return r.result;
  }
  async function verifyFunding(t, q) {
    if (
      t.creator?.account !== config.senderPublicKey ||
      t.amount_in?.asset !== asset ||
      t.amount_out?.asset !== "iso4217:XOF" ||
      amountUnits(t.amount_in.amount) !== amountUnits(q.sell_amount) ||
      Number(t.amount_out.amount) !== q.buy_amount
    )
      throw new Error("PAYMENT_BINDING_MISMATCH");
    const reference = (
      await db.query("SELECT * FROM funding_intents WHERE transaction_id=$1", [
        t.id,
      ])
    ).rows[0];
    if (!reference) throw new Error("MISSING_FUNDING_INTENT");
    if (
      reference.asset !== asset ||
      (reference.amount !== null &&
        amountUnits(reference.amount) !== amountUnits(q.sell_amount))
    )
      throw new Error("FUNDING_INTENT_MISMATCH");
    if (reference.destination !== config.bankPublicKey)
      throw new Error("WRONG_BANK_WALLET");
    if (
      !reference.memo ||
      !["id", "text", "hash"].includes(reference.memo_type)
    )
      throw new Error("MISSING_FUNDING_REFERENCE");
    const matches = [];
    for (const st of t.stellar_transactions || []) {
      if (!/^[a-f0-9]{64}$/.test(st.id))
        throw new Error("INVALID_STELLAR_HASH");
      const tx = await fetchJson(HORIZON + "/transactions/" + st.id);
      if (
        !tx.successful ||
        tx.memo !== reference.memo ||
        tx.memo_type !== reference.memo_type
      )
        continue;
      const operations = await fetchJson(
        HORIZON + "/transactions/" + st.id + "/operations?limit=200",
      );
      for (const op of operations._embedded?.records || [])
        if (
          op.type === "payment" &&
          op.from === config.senderPublicKey &&
          op.to === config.bankPublicKey &&
          op.asset_code === config.assetCode &&
          op.asset_issuer === config.assetIssuer &&
          amountUnits(op.amount) === amountUnits(q.sell_amount)
        )
          matches.push({ hash: st.id, operation: op.id, at: tx.created_at });
    }
    if (matches.length !== 1)
      throw new Error("AMBIGUOUS_OR_MISSING_STELLAR_PAYMENT");
    if (
      !Number.isFinite(Date.parse(matches[0].at)) ||
      !Number.isFinite(Date.parse(q.expires_at)) ||
      new Date(matches[0].at) > new Date(q.expires_at)
    )
      throw new Error("FUNDING_AFTER_QUOTE_EXPIRED");
    return matches[0];
  }
  async function processTransaction(t) {
    if (String(t.sep) !== "31" || t.creator?.account !== config.senderPublicKey)
      return;
    let p = (await db.query("SELECT * FROM payouts WHERE id=$1", [t.id]))
      .rows[0];
    if (!p) {
      // Recover a lost create-response using the immutable reserved request.
      // Old payments without reservations remain readable but cannot be newly funded.
      const reserved = (await db.query("SELECT quote_id FROM payment_requests WHERE quote_id=$1", [t.quote_id])).rows[0];
      if (!reserved) return;
      const binding = await payments.forTransaction(t);
      if (!t.transfer_received_at || t.status !== "pending_receiver") return;
      const q = (
        await db.query("SELECT * FROM quotes WHERE id=$1 AND account=$2", [
          t.quote_id,
          config.senderPublicKey,
        ])
      ).rows[0];
      if (!q) throw new Error("UNBOUND_CUSTOMER_OR_QUOTE");
      const funding = await verifyFunding(t, q);
      const intent = pispi.prepare({
        paymentId: t.id,
        recipientAlias: binding.destination.route.alias,
        recipientAccount: binding.destination.route.accountNumber,
        recipientParticipant: binding.destination.route.accountNumber ? binding.destination.route.participant : undefined,
        amountXof: q.buy_amount,
      });
      await db.query(
        "INSERT INTO payouts(id,quote_id,customer_id,stellar_operation,stellar_hash,amount_xof,state,intent) VALUES($1,$2,$3,$4,$5,$6,'PREPARED',$7) ON CONFLICT(id) DO NOTHING",
        [
          t.id,
          q.id,
          binding.request.receiver_id,
          funding.operation,
          funding.hash,
          q.buy_amount,
          JSON.stringify(intent),
        ],
      );
      p = (await db.query("SELECT * FROM payouts WHERE id=$1", [t.id])).rows[0];
    }
    if (p.state === "COMPLETE") return;
    if (p.state === "REJECTED") {
      if (t.status !== "error")
        await rpc("notify_transaction_error", {
          transaction_id: p.id,
          message:
            "PI-SPI sandbox rejected payout; testnet funds require reconciliation.",
        });
      return;
    }
    let result = p.result;
    if (p.state === "PREPARED") {
      const changed = await db.query(
        "UPDATE payouts SET state='SENDING',updated_at=now() WHERE id=$1 AND state='PREPARED' RETURNING id",
        [p.id],
      );
      if (!changed.rows.length) return;
      try {
        result = await pispi.send(p.intent);
      } catch {
        await db.query(
          "UPDATE payouts SET state='UNKNOWN',error='RECONCILIATION_REQUIRED',updated_at=now() WHERE id=$1",
          [p.id],
        );
        return;
      }
    } else if (!["PAID"].includes(p.state)) {
      // A previous send may have succeeded despite a timeout. Never submit again.
      result = await pispi.getStatus(p.intent.txId);
      if (!result) return;
    }
    if (result) {
      if (
        result.txId !== p.intent.txId ||
        (result.amountXof !== undefined &&
          Number(result.amountXof) !== p.amount_xof) ||
        (result.recipientAlias && result.recipientAlias !== p.intent.payeAlias) ||
        (p.intent.payeOther && result.recipientAccount && result.recipientAccount !== p.intent.payeOther) ||
        (p.intent.payeParticipant && result.recipientParticipant && result.recipientParticipant !== p.intent.payeParticipant)
      )
        throw new Error("PISPI_RECEIPT_MISMATCH");
      const state =
        result.status === "completed"
          ? "PAID"
          : result.status === "failed"
            ? "REJECTED"
            : "PENDING";
      await db.query(
        "UPDATE payouts SET state=$2,result=$3,updated_at=now() WHERE id=$1",
        [p.id, state, JSON.stringify(result)],
      );
      if (state === "REJECTED") {
        await rpc("notify_transaction_error", {
          transaction_id: p.id,
          message:
            "PI-SPI sandbox rejected payout; testnet funds require reconciliation.",
        });
        return;
      }
      if (state !== "PAID") return;
    }
    if (t.status !== "completed")
      await rpc("notify_offchain_funds_sent", {
        transaction_id: p.id,
        external_transaction_id: result?.endToEndId || p.intent.txId,
        message:
          "PI-SPI sandbox payout confirmed IRREVOCABLE; virtual funds only.",
      });
    await db.query(
      "UPDATE payouts SET state='COMPLETE',error=NULL,updated_at=now() WHERE id=$1",
      [p.id],
    );
  }
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (let page = 0; page < 100; page++) {
        const list = await platform(
          "/transactions?sep=31&order_by=created_at&order=desc&page_size=100&page_number=" +
            page,
        );
        if (!Array.isArray(list.records))
          throw new Error("INVALID_PLATFORM_PAGE");
        for (const t of list.records) {
          try {
            await processTransaction(t);
          } catch (e) {
            console.error(
              JSON.stringify({
                event: "payout-check",
                transactionId: t.id,
                code: /^[A-Z0-9_]+$/.test(e.message)
                  ? e.message
                  : "PROCESSING_REQUIRES_REVIEW",
              }),
            );
          }
        }
        if (list.records.length < 100) break;
      }
    } finally {
      running = false;
    }
  }
  async function drain() {
    while (running) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { tick, processTransaction, verifyFunding, platform, drain };
}
module.exports = { createProcessor };
