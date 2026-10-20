"use strict";
const { isDeepStrictEqual } = require("node:util");
const { amountUnits } = require("./business");
const { approvedDestination } = require("./destinations");
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function createPayments({ db, config }) {
  const asset = `stellar:USDC:${config.assetIssuer}`;
  // This runs only after AP authenticates the caller. The demo has one partner.
  async function reserve(input) {
    if (!input || ![input.sender_id, input.receiver_id, input.quote_id].every(id => typeof id === "string" && uuid.test(id)))
      throw fail("Use the sender_id, receiver_id and quote_id returned by the previous steps.");
    const permitted = ["amount", "asset_code", "asset_issuer", "destination_asset", "quote_id", "sender_id", "receiver_id", "fields"];
    if (Object.keys(input).some(k => !permitted.includes(k)) ||
        (input.fields !== undefined && !isDeepStrictEqual(input.fields, { transaction: {} })))
      throw fail("Unsupported payment fields. The recipient's registered account determines the destination.");
    const body = { amount: input.amount, asset_code: input.asset_code,
      asset_issuer: input.asset_issuer, destination_asset: input.destination_asset,
      quote_id: input.quote_id, sender_id: input.sender_id, receiver_id: input.receiver_id,
      fields: { transaction: {} } };
    return db.transaction(async tx => {
      const previous = (await tx.query("SELECT * FROM payment_requests WHERE quote_id=$1", [body.quote_id])).rows[0];
      if (previous) {
        if (!isDeepStrictEqual(previous.request, body))
          throw fail("This quote is already bound to another payment. Request a new quote.", 409);
        return { fresh: false, record: previous };
      }
      const q = (await tx.query("SELECT * FROM quotes WHERE id=$1 AND account=$2", [body.quote_id, config.senderPublicKey])).rows[0];
      if (!q || !["bank_account", "mobile_money"].includes(q.delivery_method))
        throw fail("Use a new bank_account or mobile_money quote.");
      if (new Date(q.expires_at).getTime() <= Date.now())
        throw fail("Quote expired. Request a new quote.", 409);
      if (body.asset_code !== "USDC" || body.asset_issuer !== config.assetIssuer ||
          body.destination_asset !== "iso4217:XOF" || amountUnits(body.amount) !== amountUnits(q.sell_amount))
        throw fail("Payment amount and assets must match the quote.");
      const rows = (await tx.query("SELECT * FROM customers WHERE id IN ($1,$2) AND account=$3",
        [body.sender_id, body.receiver_id, config.senderPublicKey])).rows;
      if (!rows.some(c => c.id === body.sender_id && c.type === "sep31-sender"))
        throw fail("Register the demo sender first.");
      const receiver = rows.find(c => c.id === body.receiver_id && c.type === "sep31-receiver");
      if (!approvedDestination(receiver?.destination))
        throw fail("Register an approved bank-account or fictional wallet receiver first. Legacy alias recipients cannot create new payments.");
      if (receiver.destination.type !== q.delivery_method)
        throw fail("Quote delivery method does not match the receiver. Request a quote for " + receiver.destination.type + ".");
      // Reservation and destination snapshot are committed BEFORE calling AP.
      const record = (await tx.query(
        "INSERT INTO payment_requests(quote_id,request,destination) VALUES($1,$2,$3) RETURNING *",
        [q.id, JSON.stringify(body), JSON.stringify(receiver.destination)])).rows[0];
      return { fresh: true, record };
    });
  }
  async function bind(id, quoteId) {
    if (!uuid.test(id)) throw fail("Invalid payment ID");
    const row = (await db.query(
      "UPDATE payment_requests SET transaction_id=$1,state='BOUND' WHERE quote_id=$2 AND (transaction_id IS NULL OR transaction_id=$1) AND state IN ('CREATING','UNKNOWN','BOUND') RETURNING *",
      [id, quoteId])).rows[0];
    if (!row) throw fail("Payment binding requires reconciliation.", 409);
    return row;
  }
  async function forTransaction(t) {
    const row = (await db.query("SELECT * FROM payment_requests WHERE quote_id=$1", [t.quote_id])).rows[0];
    if (!row || !approvedDestination(row.destination) ||
        t.creator?.account !== config.senderPublicKey ||
        t.customers?.receiver?.id !== row.request.receiver_id ||
        t.customers?.sender?.id !== row.request.sender_id ||
        t.amount_in?.asset !== asset || amountUnits(t.amount_in.amount) !== amountUnits(row.request.amount) ||
        (row.transaction_id && row.transaction_id !== t.id) || row.state === "REJECTED")
      throw fail("Payment does not match its reserved destination.", 409);
    return row.transaction_id ? row : bind(t.id, t.quote_id);
  }
  async function mark(quoteId, state) {
    await db.query("UPDATE payment_requests SET state=$2 WHERE quote_id=$1 AND transaction_id IS NULL",
      [quoteId, state]);
  }
  return { reserve, bind, forTransaction, mark };
}
module.exports = { createPayments };
