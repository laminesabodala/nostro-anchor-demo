"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPispiPayout } = require("../src/pispi");
const config = {
  clientId: "test",
  clientSecret: "test",
  apiKey: "test",
  payerAlias: "payer",
  allowedRecipientAliases: ["recipient"],
};
function fake(responses) {
  let calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("oauth2"))
      return new Response(
        JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
      );
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status || 200,
    });
  };
  return { calls, api: createPispiPayout({ ...config, fetchImpl }) };
}
test("fixed sandbox origins, recipient allowlist and whole bounded XOF enforce demo limits", () => {
  assert.throws(() =>
    createPispiPayout({ ...config, baseUrl: "https://production.example" }),
  );
  const { api } = fake([]);
  for (const amountXof of [0, -1, 0.5, 10001, NaN])
    assert.throws(() =>
      api.prepare({ paymentId: "x", recipientAlias: "recipient", amountXof }),
    );
  assert.throws(() =>
    api.prepare({ paymentId: "x", recipientAlias: "other", amountXof: 100 }),
  );
});
test("stable transaction id and immutable prepared instruction", () => {
  const { api } = fake([]);
  const i = api.prepare({
    paymentId: "anchor-transaction",
    recipientAlias: "recipient",
    amountXof: 600,
  });
  assert.deepEqual(
    i,
    api.prepare({
      paymentId: "anchor-transaction",
      recipientAlias: "recipient",
      amountXof: 600,
    }),
  );
  assert.ok(Object.isFrozen(i));
  assert.equal(i.confirmation, false);
});
test("ENVOYE is not completion; IRREVOCABLE final status reconciles same transaction", async () => {
  const { api, calls } = fake([]);
  const i = api.prepare({
    paymentId: "x",
    recipientAlias: "recipient",
    amountXof: 600,
  });
  const f = fake([
    { body: { txId: i.txId, statut: "ENVOYE" } },
    {
      body: {
        txId: i.txId,
        statut: "IRREVOCABLE",
        montant: 600,
        payeAlias: "recipient",
        end2endId: "E2E",
      },
    },
  ]);
  assert.equal((await f.api.send(i)).status, "pending");
  assert.equal((await f.api.getStatus(i.txId)).status, "completed");
  assert.equal(f.calls.filter((c) => c.url.includes("oauth2")).length, 1);
  assert.match(f.calls[2].url, /paiements-envoyes\/NST/);
});
test("network timeout is unknown and adapter does not automatically repeat transfer", async () => {
  const f = fake([new Error("network")]);
  const i = f.api.prepare({
    paymentId: "x",
    recipientAlias: "recipient",
    amountXof: 600,
  });
  await assert.rejects(f.api.send(i), { code: "OUTCOME_UNKNOWN" });
  assert.equal(f.calls.length, 2);
});
test("unmatched provider transaction is rejected and missing status remains absent", async () => {
  const f = fake([
    { body: { txId: "different", statut: "IRREVOCABLE" } },
    { status: 404, body: {} },
  ]);
  const i = f.api.prepare({
    paymentId: "x",
    recipientAlias: "recipient",
    amountXof: 600,
  });
  await assert.rejects(f.api.send(i), { code: "INVALID_RESPONSE" });
  assert.equal(await f.api.getStatus(i.txId), null);
});
test("cannot mutate persisted payout destination or cap before sending", async () => {
  const { api } = fake([]);
  const i = api.prepare({
    paymentId: "x",
    recipientAlias: "recipient",
    amountXof: 100,
  });
  await assert.rejects(api.send({ ...i, payeAlias: "attacker" }));
  await assert.rejects(api.send({ ...i, montant: 50000 }));
});
test("duplicate txId response requires reconciliation rather than marking original payment failed", async () => {
  const { api } = fake([]);
  const i = api.prepare({
    paymentId: "same",
    recipientAlias: "recipient",
    amountXof: 100,
  });
  const f = fake([
    { body: { txId: i.txId, statut: "REJETE", statutRaison: "DU03" } },
  ]);
  assert.equal((await f.api.send(i)).status, "pending");
});
