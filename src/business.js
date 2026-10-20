"use strict";
const { randomUUID } = require("node:crypto");
const FIXTURES = [
  {
    first_name: "Amina",
    last_name: "Diop",
    alias: "f77fdb95-7053-4389-bd45-b3bba0311c7c",
  },
  {
    first_name: "Moussa",
    last_name: "Ndiaye",
    alias: "6632f81a-6fbc-4b68-8ddc-c7e3a24cda40",
  },
];
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
    if (!r)
      return {
        status: "NEEDS_INFO",
        fields: {
          first_name: {
            type: "string",
            description: "Synthetic demo first name",
          },
          last_name: {
            type: "string",
            description: "Synthetic demo last name",
          },
        },
      };
    return {
      id: r.id,
      status: "ACCEPTED",
      message: "Synthetic sandbox fixture only; no live KYC performed.",
    };
  }
  async function putCustomer(q) {
    allowed(q.account);
    if (!["sep31-sender", "sep31-receiver"].includes(q.type))
      throw bad("Unsupported customer type");
    if (typeof q.memo !== "string" || !q.memo || q.memo.length > 128)
      throw bad("A stable customer memo is required");
    const fixture =
      q.type === "sep31-receiver"
        ? FIXTURES.find(
            (f) => f.first_name === q.first_name && f.last_name === q.last_name,
          )
        : null;
    if (q.type === "sep31-receiver" && !fixture)
      throw bad("Use an approved synthetic beneficiary fixture");
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
    const id = existing?.id || randomUUID();
    await db.query(
      "INSERT INTO customers(id,account,memo,type,first_name,last_name,alias) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account,memo,type) DO NOTHING",
      [
        id,
        q.account,
        q.memo,
        q.type,
        q.first_name,
        q.last_name,
        fixture?.alias || null,
      ],
    );
    return {
      id: (
        await db.query(
          "SELECT id FROM customers WHERE account=$1 AND memo=$2 AND type=$3",
          [q.account, q.memo, q.type],
        )
      ).rows[0].id,
    };
  }
  async function rate(q) {
    if (q.type === "firm") allowed(q.client_id);
    if (
      q.sell_asset !== asset ||
      q.buy_asset !== "iso4217:XOF" ||
      (q.buy_delivery_method && q.buy_delivery_method !== "PI_SPI")
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
          "INSERT INTO quotes(id,account,sell_amount,buy_amount,expires_at) VALUES($1,$2,$3,$4,$5)",
          [id, q.client_id, result.sell_amount, buy, expiry.toISOString()],
        );
      });
      Object.assign(result, { id, expires_at: expiry.toISOString() });
    } else if (q.type !== "indicative") throw bad("Unsupported quote type");
    return { rate: result };
  }
  return { getCustomer, putCustomer, rate };
}
module.exports = { createBusiness, amountUnits, decimal, FIXTURES };
