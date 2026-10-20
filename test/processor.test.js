"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/store");
const { createProcessor } = require("../src/processor");
const config = {
  assetCode: "USDC",
  assetIssuer: "issuer",
  senderPublicKey: "sender",
  bankPublicKey: "bank",
  platformUrl: "http://platform",
  platformApiKey: "secret",
};
const hash = "a".repeat(64);
const qid = "00000000-0000-4000-8000-000000000001",
  cid = "00000000-0000-4000-8000-000000000002";
async function setup(
  t,
  { sendError = false, rpcError = false, operation = {} } = {},
) {
  const db = await createStore();
  t.after(() => db.close());
  await db.query(
    "INSERT INTO customers VALUES($1,'sender','memo','sep31-receiver','Amina','Diop','alias')",
    [cid],
  );
  await db.query(
    "INSERT INTO quotes(id,account,sell_amount,buy_amount,expires_at) VALUES($1,'sender','1.0000000',500,'2099-01-01')",
    [qid],
  );
  await db.query(
    "INSERT INTO funding_intents(transaction_id,destination,memo,memo_type,asset,amount) VALUES('ap-id','bank','123','id','stellar:USDC:issuer','1.0000000')",
  );
  const transaction = {
    id: "ap-id",
    sep: 31,
    creator: { account: "sender" },
    amount_in: { asset: "stellar:USDC:issuer", amount: "1.0000000" },
    amount_out: { asset: "iso4217:XOF", amount: "500" },
    quote_id: qid,
    customers: { receiver: { id: cid } },
    transfer_received_at: "2026-10-20",
    status: "pending_receiver",
    stellar_transactions: [{ id: hash }],
  };
  let sends = 0,
    reads = 0,
    rpcs = 0;
  const pispi = {
    prepare: () => ({ txId: "unique", payeAlias: "alias", montant: 500 }),
    send: async () => {
      sends++;
      if (sendError) throw Error("timeout");
      return {
        txId: "unique",
        status: "completed",
        amountXof: 500,
        recipientAlias: "alias",
        endToEndId: "E2E",
      };
    },
    getStatus: async () => {
      reads++;
      return {
        txId: "unique",
        status: "completed",
        amountXof: 500,
        recipientAlias: "alias",
        endToEndId: "E2E",
      };
    },
  };
  const fetchJson = async (url, options = {}) => {
    if (url.includes("/operations"))
      return {
        _embedded: {
          records: [
            {
              type: "payment",
              id: "op1",
              from: "sender",
              to: "bank",
              asset_code: "USDC",
              asset_issuer: "issuer",
              amount: "1.0000000",
              ...operation,
            },
          ],
        },
      };
    if (url.includes("horizon"))
      return {
        successful: true,
        memo: "123",
        memo_type: "id",
        created_at: "2026-10-20T00:00:00Z",
      };
    if (url === "http://platform/") {
      assert.equal(options.method, "POST");
      const batch = JSON.parse(options.body);
      assert.ok(Array.isArray(batch));
      assert.equal(batch.length, 1);
      assert.equal(batch[0].jsonrpc, "2.0");
      rpcs++;
      if (rpcError) throw Error("RPCdown");
      return [{ result: {} }];
    }
    throw Error("UnexpectedURL");
  };
  return {
    db,
    transaction,
    processor: createProcessor({ db, config, pispi, fetchJson }),
    counts: () => ({ sends, reads, rpcs }),
  };
}
test("official AP31 shape with no destination/memo uses persisted signer reference and completes once", async (t) => {
  const s = await setup(t);
  await s.processor.processTransaction(s.transaction);
  await s.processor.processTransaction(s.transaction);
  assert.deepEqual(s.counts(), { sends: 1, reads: 0, rpcs: 1 });
  assert.equal(
    (await s.db.query("SELECT state FROM payouts")).rows[0].state,
    "COMPLETE",
  );
});
test("ambiguous send is reconciled without another submission", async (t) => {
  const s = await setup(t, { sendError: true });
  await s.processor.processTransaction(s.transaction);
  assert.equal(
    (await s.db.query("SELECT state FROM payouts")).rows[0].state,
    "UNKNOWN",
  );
  await s.processor.processTransaction(s.transaction);
  assert.deepEqual(s.counts(), { sends: 1, reads: 1, rpcs: 1 });
});
test("paid payout retries AP notification without paying again", async (t) => {
  const s = await setup(t, { rpcError: true });
  await assert.rejects(s.processor.processTransaction(s.transaction));
  await assert.rejects(s.processor.processTransaction(s.transaction));
  assert.equal(
    (await s.db.query("SELECT state FROM payouts")).rows[0].state,
    "PAID",
  );
  assert.deepEqual(s.counts(), { sends: 1, reads: 0, rpcs: 2 });
});
test("funding from another source is not accepted even if wallet and amount match", async (t) => {
  const s = await setup(t, { operation: { from: "attacker" } });
  await assert.rejects(
    s.processor.processTransaction(s.transaction),
    /AMBIGUOUS_OR_MISSING/,
  );
  assert.equal(s.counts().sends, 0);
});
test("quote and signer reference mismatch stops payout", async (t) => {
  const s = await setup(t);
  await s.db.query("UPDATE funding_intents SET amount='2.0'");
  await assert.rejects(
    s.processor.processTransaction(s.transaction),
    /FUNDING_INTENT_MISMATCH/,
  );
  assert.equal(s.counts().sends, 0);
});
test("processor starts at zero and drains following full pages", async () => {
  const paths = [];
  const p = createProcessor({
    db: {},
    config,
    pispi: {},
    fetchJson: async (url) => {
      paths.push(url);
      return {
        records:
          paths.length === 1
            ? Array.from({ length: 100 }, () => ({ sep: 24 }))
            : [],
      };
    },
  });
  await p.tick();
  assert.match(paths[0], /order_by=created_at/);
  assert.match(paths[0], /page_number=0$/);
  assert.match(paths[1], /page_number=1$/);
});
test("one Stellar operation cannot authorize a second payout", async (t) => {
  const s = await setup(t);
  await s.processor.processTransaction(s.transaction);
  const second = "00000000-0000-4000-8000-000000000003";
  await s.db.query(
    "INSERT INTO quotes(id,account,sell_amount,buy_amount,expires_at) VALUES($1,'sender','1.0000000',500,'2099-01-01')",
    [second],
  );
  await s.db.query(
    "INSERT INTO funding_intents(transaction_id,destination,memo,memo_type,asset,amount) VALUES('ap-other','bank','123','id','stellar:USDC:issuer','1.0000000')",
  );
  await assert.rejects(
    s.processor.processTransaction({
      ...s.transaction,
      id: "ap-other",
      quote_id: second,
    }),
    /unique/,
  );
  assert.equal(s.counts().sends, 1);
});
test("official unique-address callback can bind memo before the quote amount is known", async (t) => {
  const s = await setup(t);
  await s.db.query("UPDATE funding_intents SET amount=NULL");
  await s.processor.processTransaction(s.transaction);
  assert.equal(s.counts().sends, 1);
  assert.equal(
    (await s.db.query("SELECT state FROM payouts")).rows[0].state,
    "COMPLETE",
  );
});
