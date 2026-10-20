"use strict";
// Tests exactly the public browser API, without accessing a wallet or private API.
const fs = require("node:fs/promises");
async function main() {
  const config = JSON.parse(await fs.readFile(".local-platform/runtime.json"));
  let token;
  async function call(path, method = "GET", body) {
    const r = await fetch(config.publicUrl + path, {
      method, headers: { "ngrok-skip-browser-warning": "1",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000)
    });
    const data = await r.json();
    if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
    return data;
  }
  const session = await call("/sandbox/auth", "POST");
  token = session.token;
  const method = process.argv[2] || "bank_account";
  if (!["bank_account", "mobile_money"].includes(method)) throw Error("Use bank_account or mobile_money");
  const sender = await call("/sep12/customer", "PUT", { account: session.account,
    memo: "browser-demo-sender", memo_type: "text", type: "sep31-sender", first_name: "Demo", last_name: "Sender" });
  const receiver = await call("/sep12/customer", "PUT", { account: session.account,
    memo: method === "bank_account" ? "bimao-bank-amina-v1" : "eme-wallet-lamine-v1",
    memo_type: "text", type: "sep31-receiver",
    ...(method === "bank_account" ? {first_name: "Amina", last_name: "Diop",
      bank_number:"BIMAO_SANDBOX",bank_account_number:"31432"} :
      {first_name:"Lamine",last_name:"Tall",mobile_money_provider:"PI_SPI_EME_CI_SANDBOX",mobile_money_number:"+2250700000000"}) });
  const accepted = await call("/sep12/customer?id=" + receiver.id);
  if (accepted.status !== "ACCEPTED") throw Error("Receiver not accepted");
  const sellAmount = process.argv[3] || "0.2";
  const quote = await call("/sep38/quote", "POST", { context: "sep31",
    sell_asset: `stellar:USDC:${config.assetIssuer}`, buy_asset: "iso4217:XOF",
    sell_amount: sellAmount, buy_delivery_method: method });
  const paymentBody = {
    amount: quote.sell_amount, asset_code: "USDC", asset_issuer: config.assetIssuer,
    destination_asset: "iso4217:XOF", quote_id: quote.id, sender_id: sender.id,
    receiver_id: receiver.id, fields: { transaction: {} } };
  const payment = await call("/sep31/transactions", "POST", paymentBody);
  const retried = await call("/sep31/transactions", "POST", paymentBody);
  if (retried.id !== payment.id) throw Error("Creation retry returned a second payment");
  await fs.writeFile(`.local/browser-smoke-${method}.json`, JSON.stringify({ id: payment.id, senderId:sender.id, receiverId:receiver.id, quoteId:quote.id }, null, 2), { mode: 0o600 });
  console.log("Created sandbox payment", payment.id);
  let tx;
  for (let i = 0; i < 15; i++) {
    tx = (await call("/sep31/transactions/" + payment.id)).transaction;
    if (tx.status === "pending_sender" && tx.stellar_account_id) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log("Payment fields:", Object.keys(tx).join(", "));
  const funded = await call(`/sandbox/payments/${payment.id}/fund`, "POST");
  console.log("Funding:", JSON.stringify(funded));
  const repeated = await call(`/sandbox/payments/${payment.id}/fund`, "POST");
  if (repeated.stellarTransactionId !== funded.stellarTransactionId) throw Error("Retry hash mismatch");
  for (let i = 0; i < 60; i++) {
    tx = (await call("/sep31/transactions/" + payment.id)).transaction;
    if (tx.status === "completed") {
      await fs.writeFile(`.local/browser-smoke-${method}.json`, JSON.stringify({senderId:sender.id,receiverId:receiver.id,quoteId:quote.id,transaction:tx}, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(tx, null, 2)); return;
    }
    if (["error", "expired", "refunded"].includes(tx.status)) throw Error("Payment status: " + tx.status);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw Error("Payment still pending; reconcile existing ID");
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
