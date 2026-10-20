"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const S = require("@stellar/stellar-sdk");
const { createStore } = require("../src/store");
const { createSandbox } = require("../src/sandbox");
const { FIXTURES } = require("../src/business");
async function setup(t, sell = "0.2", buy = "100", hosted = false) {
  const pair = S.Keypair.random(), bank = S.Keypair.random(), signer = S.Keypair.random();
  const config = { networkPassphrase: S.Networks.TESTNET, senderPublicKey: pair.publicKey(),
    bankPublicKey: bank.publicKey(), assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    signingPublicKey: signer.publicKey(), publicUrl: "https://sandbox.example",
    ...(hosted ? { sepUrl: "http://platform:8080", platformUrl: "http://platform:8085" } : {}) };
  const db = await createStore();
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", receiver = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const asset = `stellar:USDC:${config.assetIssuer}`, memo = Buffer.alloc(32, 1).toString("base64");
  const tx = { id, receiver_id: receiver, quote_id: id, stellar_account_id: bank.publicKey(),
    stellar_memo: memo, stellar_memo_type: "hash", amount_in: sell, amount_out: buy,
    amount_in_asset: asset, amount_out_asset: "iso4217:XOF", status: "pending_sender" };
  const quote = { id, sell_asset: asset, buy_asset: "iso4217:XOF", sell_amount: sell, buy_amount: buy,
    expires_at: new Date(Date.now() + 600000).toISOString() };
  await db.query("INSERT INTO customers(id,account,memo,type,first_name,last_name,alias) VALUES($1,$2,'fixture','sep31-receiver','Amina','Diop',$3)", [receiver, pair.publicKey(), FIXTURES[0].alias]);
  await db.query("INSERT INTO funding_intents(transaction_id,destination,memo,memo_type,asset) VALUES($1,$2,$3,'hash',$4)", [id, bank.publicKey(), memo, asset]);
  await db.query("INSERT INTO quotes(id,account,sell_amount,buy_amount,expires_at,delivery_method) VALUES($1,$2,$4,$5,$3,'bank_account')", [id,pair.publicKey(),quote.expires_at,sell,Number(buy)]);
  await db.query("INSERT INTO payment_requests(quote_id,transaction_id,request,destination,state) VALUES($1::uuid,$1::text,$2,$3,'BOUND')",
    [id,JSON.stringify({receiver_id:receiver,sender_id:"sender-id",amount:sell}),JSON.stringify(require("../src/destinations").destinationFor(FIXTURES[0]))]);
  let submissions = 0, confirmed = false, failAfterSubmit = false;
  const horizon = {
    ledgers: () => ({ order: () => ({ limit: () => ({ call: async () => ({
      records: [{ closed_at: new Date().toISOString() }]
    }) }) }) }),
    loadAccount: async () => new S.Account(pair.publicKey(), "1"),
    fetchBaseFee: async () => 100,
    transactions: () => ({ transaction: hash => ({ call: async () => {
      assert.match(hash, /^[a-f0-9]{64}$/);
      if (!confirmed) throw { response: { status: 404 } };
      return { successful: true };
    } }) }),
    submitTransaction: async (signed) => { assert.equal(signed.operations[0].amount, Number(sell).toFixed(7)); submissions++; confirmed = true; if (failAfterSubmit) throw Error("timeout"); return { successful: true }; }
  };
  const fetchImpl = async (url, options) => {
    if (url.startsWith((hosted ? "http://platform:8085" : "http://127.0.0.1:8089") + "/transactions/"))
      return { ok: true, json: async () => ({ id, quote_id: id, creator: { account: pair.publicKey() }, customers: { receiver: { id: receiver }, sender: { id: "sender-id" } }, amount_in: { asset, amount:sell } }) };
    if (url.includes("/sep31/") || url.includes("/sep38/")) {
      assert.ok(url.startsWith(hosted ? "http://platform:8080/" : "http://127.0.0.1:8088/"));
      const body = url.includes("/sep31/") ? { transaction: tx } : quote;
      if (options.headers.Authorization !== "Bearer valid")
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }
    throw Error("Unexpected request");
  };
  const app = await createSandbox({ db, config, wallet: { publicKey: pair.publicKey(), secret: pair.secret() }, horizon, fetchImpl });
  t.after(async () => { await app.close(); await db.close(); });
  const fund = (token = "valid") => app.inject({ method: "POST", url: `/sandbox/payments/${id}/fund`, headers: { authorization: "Bearer " + token } });
  const expired = async () => {
    const old = new S.TransactionBuilder(new S.Account(pair.publicKey(), "1"), {
      fee: 100, networkPassphrase: S.Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) - 60 }
    }).addOperation(S.Operation.payment({ destination: bank.publicKey(),
      asset: new S.Asset("USDC", config.assetIssuer), amount: sell }))
      .addMemo(S.Memo.hash(Buffer.from(memo, "base64"))).build();
    old.sign(pair);
    await db.query("INSERT INTO sandbox_funding(transaction_id,xdr,hash) VALUES($1,$2,$3)",
      [id, old.toXDR(), Buffer.from(old.hash()).toString("hex")]);
  };
  return { app, tx, quote, fund, expired, submissions: () => submissions, uncertain: () => { failAfterSubmit = true; } };
}
test("hosted gateway funds through private Docker Anchor addresses", async t => {
  const s = await setup(t, "0.2", "100", true);
  const result = await s.fund();
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, "funding_confirmed");
  assert.equal(s.submissions(), 1);
});
test("sandbox gateway denies internal routes and invalid authentication", async t => {
  const { app, fund, submissions } = await setup(t);
  assert.equal((await app.inject("/internal/anchor/customer")).statusCode, 404);
  assert.equal((await app.inject("/transactions")).statusCode, 404);
  assert.equal((await fund("invalid")).statusCode, 401);
  assert.equal(submissions(), 0);
});
test("sandbox funding rejects destination, amount and expired quote changes", async t => {
  const { tx, quote, fund, submissions } = await setup(t);
  tx.amount_in = "5"; assert.equal((await fund()).statusCode, 400);
  tx.amount_in = "0.2"; quote.expires_at = "2020-01-01"; assert.equal((await fund()).statusCode, 409);
  assert.equal(submissions(), 0);
});
test("concurrent retries fund once and reconcile a lost response", async t => {
  const { fund, submissions, uncertain } = await setup(t);
  uncertain();
  assert.equal((await fund()).statusCode, 503);
  const responses = await Promise.all([fund(), fund()]);
  assert.deepEqual(responses.map(r => r.statusCode), [200, 200]);
  assert.equal(submissions(), 1);
});
test("expired unused envelope is replaced only after ledger and sequence reconciliation", async t => {
  const { expired, fund, submissions } = await setup(t);
  await expired();
  const first = await fund();
  assert.equal(first.statusCode, 200, first.body);
  assert.match(first.json().stellarTransactionId, /^[a-f0-9]{64}$/);
  assert.equal((await fund()).statusCode, 200);
  assert.equal(submissions(), 1);
});

test("sandbox funds a chosen amount up to the cap and retries without another transfer", async t => {
  const {fund,submissions,tx}=await setup(t,"5","2500");
  const first = await fund();
  assert.equal(first.statusCode,200);
  const body = first.json();
  assert.equal(body.stellarExplorerUrl, `https://stellar.expert/explorer/testnet/tx/${body.stellarTransactionId}`);
  assert.equal((await fund()).statusCode,200);
  tx.status = "completed";
  tx.stellar_transaction_id = body.stellarTransactionId;
  assert.equal((await fund()).json().stellarExplorerUrl, body.stellarExplorerUrl);
  assert.equal(submissions(),1);
});
test("payment status exposes a Testnet link only for a valid confirmed hash and preserves auth errors", async t => {
  const {app,tx}=await setup(t);
  const read = token => app.inject({url:`/sep31/transactions/${tx.id}`,headers:{authorization:`Bearer ${token}`}});
  assert.equal((await read("valid")).json().transaction.stellar_explorer_url,null);
  tx.stellar_transaction_id = "a".repeat(64);
  const result = await read("valid");
  assert.equal(result.statusCode,200);
  assert.equal(result.json().transaction.stellar_explorer_url,`https://stellar.expert/explorer/testnet/tx/${tx.stellar_transaction_id}`);
  assert.equal(result.json().transaction.id,tx.id);
  tx.stellar_transaction_id = "https://example.com";
  assert.equal((await read("valid")).json().transaction.stellar_explorer_url,null);
  const denied = await read("invalid");
  assert.equal(denied.statusCode,401);
  assert.deepEqual(denied.json(),{error:"Unauthorized"});
});
test("sandbox rejects a correctly matched but over-cap payment before signing", async t => {
  const {fund,submissions}=await setup(t,"5.002","2501");
  assert.equal((await fund()).statusCode,400);
  assert.equal(submissions(),0);
});
test("bodyless funding accepts an empty proxy payload but other APIs still require JSON", async t => {
  const {app,tx,submissions}=await setup(t);
  const result=await app.inject({method:"POST",url:`/sandbox/payments/${tx.id}/fund`,headers:{authorization:"Bearer valid","content-type":"application/octet-stream"},payload:"{}"});
  assert.equal(result.statusCode,200,result.body);
  assert.equal(submissions(),1);
  assert.equal((await app.inject({method:"POST",url:"/sep38/quote",headers:{"content-type":"application/octet-stream"},payload:"{}"})).statusCode,415);
});
