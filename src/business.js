"use strict";
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FIXTURES, parseDestination, approvedDestination, recipientFields } = require("./destinations");
const bad = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
function amountUnits(value) {
  if (typeof value !== "string" || !/^\d{1,10}(\.\d{1,7})?$/.test(value))
    throw bad("Invalid decimal amount");
  const [a, b = ""] = value.split(".");
  return BigInt(a) * 10000000n + BigInt(b.padEnd(7, "0"));
}
function decimal(units) {
  return `${units / 10000000n}.${(units % 10000000n).toString().padStart(7, "0")}`;
}
function createBusiness({ db, config }) {
  const asset = `stellar:${config.assetCode}:${config.assetIssuer}`;
  const allowed = (account) => {
    if (account !== config.senderPublicKey)
      throw bad("Unapproved demo sending partner", 403);
  };
  async function getCustomer(q) {
    if (q.account || !q.id) allowed(q.account);
    if (q.id && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(q.id))
      throw bad("Customer not found", 404);
    let r;
    if (q.id)
      r = (
        await db.query("SELECT * FROM customers WHERE id=$1 AND account=$2", [
          q.id,
          q.account || config.senderPublicKey,
        ])
      ).rows[0];
    else
      r = (
        await db.query(
          "SELECT * FROM customers WHERE account=$1 AND memo=$2 AND type=$3",
          [q.account, q.memo || "", q.type],
        )
      ).rows[0];
    if (r && q.type && r.type !== q.type) throw bad("Customer type mismatch");
    if (!r && q.id) throw bad("Customer not found", 404);
    if (!r)
      return {
        status: "NEEDS_INFO",
        fields: q.type === "sep31-receiver" ? recipientFields() : {
          first_name: {
            type: "string",
            description: "Sender first name",
          },
          last_name: {
            type: "string",
            description: "Sender last name",
          },
        },
      };
    if (r.type === "sep31-receiver" && !approvedDestination(r.destination))
      return { id: r.id, status: "NEEDS_INFO",
        message: "Legacy alias recipient. Register a new account-number recipient with a new memo.",
        fields: recipientFields() };
    return {
      id: r.id,
      status: "ACCEPTED",
      message: "Customer ready for sandbox payments.",
    };
  }
  async function putCustomer(q) {
    allowed(q.account);
    if (!["sep31-sender", "sep31-receiver"].includes(q.type))
      throw bad("Unsupported customer type");
    if (typeof q.memo !== "string" || !q.memo || q.memo.length > 128)
      throw bad("A stable customer memo is required");
    const destination = q.type === "sep31-receiver" ? parseDestination(q) : null;
    if (q.type === "sep31-sender" && ["bank_number", "bank_account_number", "mobile_money_provider", "mobile_money_number"].some(k => q[k] != null))
      throw bad("Payout destination fields belong to the receiver, not the sender.");
    if (
      q.type === "sep31-sender" &&
      (q.first_name !== "Demo" || q.last_name !== "Sender")
    )
      throw bad("Use the synthetic Demo Sender");
    const existing = (
      await db.query(
        "SELECT * FROM customers WHERE account=$1 AND memo=$2 AND type=$3",
        [q.account, q.memo, q.type],
      )
    ).rows[0];
    if (q.id && q.id !== existing?.id) throw bad("Customer not found", 404);
    if (
      existing &&
      (existing.first_name !== q.first_name ||
        existing.last_name !== q.last_name)
    )
      throw bad("Fixture identity cannot change");
    if (existing && !isDeepStrictEqual(existing.destination, destination))
      throw bad("Recipient destination cannot change. Register a new recipient with a new memo.");
    const id = existing?.id || randomUUID();
    await db.query(
      "INSERT INTO customers(id,account,memo,type,first_name,last_name,alias,destination) VALUES($1,$2,$3,$4,$5,$6,NULL,$7) ON CONFLICT(account,memo,type) DO NOTHING",
      [
        id,
        q.account,
        q.memo,
        q.type,
        q.first_name,
        q.last_name,
        destination ? JSON.stringify(destination) : null,
      ],
    );
    const saved = (
        await db.query(
          "SELECT * FROM customers WHERE account=$1 AND memo=$2 AND type=$3",
          [q.account, q.memo, q.type],
        )
      ).rows[0];
    if (saved.first_name !== q.first_name || saved.last_name !== q.last_name ||
        !isDeepStrictEqual(saved.destination, destination))
      throw bad("This memo already identifies another recipient. Use a new memo.");
    return { id: saved.id };
  }
  async function rate(q) {
    if (q.type === "firm") allowed(q.client_id);
    if (
      q.sell_asset !== asset ||
      q.buy_asset !== "iso4217:XOF" ||
      (q.buy_delivery_method && !["bank_account", "mobile_money"].includes(q.buy_delivery_method))
    )
      throw bad("Unsupported demo corridor");
    if (!!q.sell_amount === !!q.buy_amount)
      throw bad("Supply exactly one amount");
    let units, buy;
    if (q.sell_amount) {
      units = amountUnits(q.sell_amount);
      if (units % 20000n !== 0n) throw bad("Quote must produce whole XOF");
      buy = Number(units / 20000n);
    } else {
      if (!/^\d+$/.test(q.buy_amount))
        throw bad("XOF amount must be an integer");
      buy = Number(q.buy_amount);
      units = BigInt(buy) * 20000n;
    }
    if (buy < 100 || buy > 2500) throw bad("Demo quote limit is 100–2500 XOF");
    const result = {
      price: "0.002",
      sell_amount: decimal(units),
      buy_amount: String(buy),
      fee: { total: "0", asset },
    };
    if (q.type === "firm") {
      const expiry = new Date(Date.now() + 10 * 60000);
      const requested = q.expire_after || q.expires_after;
      if (
        requested &&
        (!Number.isFinite(Date.parse(requested)) ||
          Date.parse(requested) > expiry.getTime())
      )
        throw bad("Maximum demo quote validity is ten minutes");
      const id = randomUUID();
      await db.transaction(async (tx) => {
        const reserved = Number(
          (
            await tx.query(
              "SELECT coalesce(sum(buy_amount),0) AS amount FROM quotes q WHERE expires_at>now() OR EXISTS(SELECT 1 FROM payouts p WHERE p.quote_id=q.id AND p.state NOT IN ('REJECTED'))",
            )
          ).rows[0].amount,
        );
        if (reserved + buy > (config.demoXofBudget || 25000))
          throw bad("Demo liquidity budget exhausted", 503);
        await tx.query(
          "INSERT INTO quotes(id,account,sell_amount,buy_amount,expires_at,delivery_method) VALUES($1,$2,$3,$4,$5,$6)",
          [id, q.client_id, result.sell_amount, buy, expiry.toISOString(), q.buy_delivery_method || "bank_account"],
        );
      });
      Object.assign(result, { id, expires_at: expiry.toISOString() });
    } else if (q.type !== "indicative") throw bad("Unsupported quote type");
    return { rate: result };
  }
  return { getCustomer, putCustomer, rate };
}
module.exports = { createBusiness, amountUnits, decimal, FIXTURES };
