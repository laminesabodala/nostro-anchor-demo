"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/store");
const { createBusiness, amountUnits } = require("../src/business");
const config = {
  assetCode: "USDC",
  assetIssuer: "issuer",
  senderPublicKey: "sender",
  demoXofBudget: 5000,
};
async function setup(t) {
  const db = await createStore();
  t.after(() => db.close());
  return { db, business: createBusiness({ db, config }) };
}
test("decimal amounts retain precision without floating point rounding", () => {
  assert.equal(amountUnits("1.0000001"), 10000001n);
  assert.throws(() => amountUnits("1e3"));
  assert.throws(() => amountUnits(1));
});
test("customer fixture is stable and scoped to approved partner", async (t) => {
  const { business } = await setup(t);
  const q = {
    account: "sender",
    memo: "beneficiary1",
    type: "sep31-receiver",
    bank_number: "BIMAO_SANDBOX",
    bank_account_number: "31432",
    first_name: "Amina",
    last_name: "Diop",
  };
  const r = await business.putCustomer(q);
  assert.deepEqual(await business.putCustomer(q), r);
  assert.equal(
    (await business.getCustomer({ ...q, id: r.id })).status,
    "ACCEPTED",
  );
  await assert.rejects(
    business.getCustomer({ ...q, account: "attacker", id: r.id }),
    /Unapproved/,
  );
  await assert.rejects(business.putCustomer({ ...q, last_name: "Other" }));
});
test("SEP31 internal customer callback supplies only id/type", async (t) => {
  const { business } = await setup(t);
  const r = await business.putCustomer({
    account: "sender",
    memo: "receiver",
    type: "sep31-receiver",
    bank_number: "BIMAO_SANDBOX",
    bank_account_number: "31432",
    first_name: "Amina",
    last_name: "Diop",
  });
  assert.equal(
    (await business.getCustomer({ id: r.id, type: "sep31-receiver" })).status,
    "ACCEPTED",
  );
  await assert.rejects(
    business.getCustomer({ id: r.id, type: "sep31-sender" }),
    /type mismatch/,
  );
});
test("unknown and malformed customer IDs return not found rather than requirements or a database error", async (t) => {
  const { business } = await setup(t);
  for (const id of ["not-a-customer", "00000000-0000-4000-8000-000000000000"])
    await assert.rejects(business.getCustomer({ id }), { statusCode: 404, message: "Customer not found" });
  assert.equal((await business.getCustomer({ account: "sender", memo: "new", type: "sep31-receiver" })).status, "NEEDS_INFO");
});
test("firm quote has exact synthetic FX and zero fees; unsupported corridor rejected", async (t) => {
  const { business } = await setup(t);
  const q = {
    type: "firm",
    client_id: "sender",
    sell_asset: "stellar:USDC:issuer",
    buy_asset: "iso4217:XOF",
    sell_amount: "1.0",
    buy_delivery_method: "bank_account",
  };
  const { rate } = await business.rate(q);
  assert.equal(rate.sell_amount, "1.0000000");
  assert.equal(rate.buy_amount, "500");
  assert.equal(rate.fee.total, "0");
  assert.ok(rate.id);
  await assert.rejects(business.rate({ ...q, buy_asset: "iso4217:EUR" }));
  await assert.rejects(business.rate({ ...q, client_id: "attacker" }));
});
test("quote liquidity budget rejects overcommit", async (t) => {
  const { business } = await setup(t);
  const q = {
    type: "firm",
    client_id: "sender",
    sell_asset: "stellar:USDC:issuer",
    buy_asset: "iso4217:XOF",
    sell_amount: "5.0",
  };
  await business.rate(q);
  await business.rate(q);
  await assert.rejects(business.rate(q), /budget exhausted/);
});
