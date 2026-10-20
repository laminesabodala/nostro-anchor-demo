"use strict";
// Real Testnet / virtual PI-SPI only. Re-running resumes the same payment.
const fs = require("node:fs/promises"),
  path = require("node:path");
const S = require("@stellar/stellar-sdk");
const root = path.resolve(__dirname, "..");
async function main() {
  const config = JSON.parse(
    await fs.readFile(path.join(root, ".local-platform/runtime.json")),
  );
  const wallet = JSON.parse(
    await fs.readFile(path.join(root, ".local-platform/sender.json")),
  );
  if (
    config.networkPassphrase !== S.Networks.TESTNET ||
    config.assetIssuer !==
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" ||
    wallet.publicKey !== config.senderPublicKey
  )
    throw Error("Testnet configuration mismatch");
  const authOnly = process.argv[2] === "--auth-only";
  const fundExisting = process.argv[2] === "--fund" ? process.argv[3] : null;
  if (process.argv[2] === "--fund" && !/^[a-f0-9-]{36}$/.test(fundExisting || ""))
    throw Error("Supply the existing SEP-31 transaction UUID after --fund");
  const runName = authOnly ? "playground-auth" : fundExisting ? "fund-" + fundExisting : process.argv[2] || "first-payment";
  if (!/^[a-z0-9-]{1,64}$/.test(runName)) throw Error("Use a simple run name");
  const filename = path.join(root, ".local", runName + ".json");
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const lock = filename + ".lock";
  try {
    await fs.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code === "EEXIST")
      throw Error(
        "This run is locked; confirm its process has stopped before clearing the lock",
      );
    throw e;
  }
  process.once("exit", () => {
    try {
      require("node:fs").unlinkSync(lock);
    } catch {}
  });
  let state;
  try {
    state = JSON.parse(await fs.readFile(filename));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    state = { runName };
  }
  const save = async () => {
    await fs.writeFile(filename + ".tmp", JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
    await fs.rename(filename + ".tmp", filename);
  };
  let token;
  async function call(p, method = "GET", body) {
    const r = await fetch(config.publicUrl + p, {
      method,
      headers: {
        "ngrok-skip-browser-warning": "1",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw Error(`Non-JSON response ${p} (${r.status})`);
    }
    if (!r.ok)
      throw Error(
        `${method} ${p}: ${r.status} ${JSON.stringify(data).slice(0, 500)}`,
      );
    return data;
  }
  const challenge = await call("/auth?account=" + wallet.publicKey);
  const domain = new URL(config.publicUrl).hostname;
  const read = S.WebAuth.readChallengeTx(
    challenge.transaction,
    config.signingPublicKey,
    S.Networks.TESTNET,
    domain,
    domain,
  );
  if (read.clientAccountID !== wallet.publicKey)
    throw Error("Challenge account mismatch");
  read.tx.sign(S.Keypair.fromSecret(wallet.secret));
  token = (await call("/auth", "POST", { transaction: read.tx.toXDR() })).token;
  console.log("SEP-10 challenge verified and authenticated");
  if (authOnly) {
    await fs.writeFile(path.join(root, ".local/sep10-token.txt"), token, {
      mode: 0o600,
    });
    console.log("Playground bearer token saved privately to .local/sep10-token.txt; no payment created.");
    return;
  }
  if (fundExisting && !state.transaction) {
    const existing = (await call("/sep31/transactions/" + fundExisting)).transaction;
    if (existing.id !== fundExisting) throw Error("Transaction identifier mismatch");
    state.transaction = { id: existing.id };
    state.quote = await call("/sep38/quote/" + existing.quote_id);
    await save();
  }
  if (!fundExisting && !state.senderId) {
    state.senderId = (
      await call("/sep12/customer", "PUT", {
        account: wallet.publicKey,
        memo: "demo-sender",
        memo_type: "text",
        type: "sep31-sender",
        first_name: "Demo",
        last_name: "Sender",
      })
    ).id;
    await save();
  }
  if (!fundExisting && !state.receiverId) {
    state.receiverId = (
      await call("/sep12/customer", "PUT", {
        account: wallet.publicKey,
        memo: "receiver-amina-demo",
        memo_type: "text",
        type: "sep31-receiver",
        first_name: "Amina",
        last_name: "Diop",
      })
    ).id;
    await save();
  }
  const asset = `stellar:USDC:${config.assetIssuer}`;
  if (!state.quote) {
    state.quote = await call("/sep38/quote", "POST", {
      context: "sep31",
      sell_asset: asset,
      buy_asset: "iso4217:XOF",
      sell_amount: "0.2",
      buy_delivery_method: "PI_SPI",
    });
    await save();
  }
  if (!state.transaction) {
    if (state.creationStarted)
      throw Error(
        "Uncertain payment creation: reconcile before starting another",
      );
    state.creationStarted = true;
    await save();
    state.transaction = await call("/sep31/transactions", "POST", {
      amount: "0.2",
      asset_code: "USDC",
      asset_issuer: config.assetIssuer,
      destination_asset: "iso4217:XOF",
      quote_id: state.quote.id,
      sender_id: state.senderId,
      receiver_id: state.receiverId,
      fields: { transaction: {} },
    });
    await save();
  }
  const id = state.transaction.id;
  console.log("SEP-31 payment: " + id);
  const tx = (await call("/sep31/transactions/" + id)).transaction;
  if (
    tx.stellar_account_id !== config.bankPublicKey ||
    tx.quote_id !== state.quote.id
  )
    throw Error("Funding details mismatch");
  if (
    Number(tx.amount_in) !== 0.2 ||
    tx.amount_in_asset !== asset ||
    Number(tx.amount_out) !== 100 ||
    tx.amount_out_asset !== "iso4217:XOF"
  )
    throw Error("Funding amount or asset mismatch");
  if (tx.status === "completed") {
    console.log(JSON.stringify({
      transactionId: id,
      status: tx.status,
      stellarHash: tx.stellar_transaction_id,
      externalTransactionId: tx.external_transaction_id,
      amountUSDC: tx.amount_in,
      amountXOF: tx.amount_out,
      message: "Already completed; no payment submitted."
    }, null, 2));
    return;
  }
  const horizon = new S.Horizon.Server("https://horizon-testnet.stellar.org");
  if (!state.fundingXdr) {
    if (tx.status !== "pending_sender")
      throw Error(
        "Payment is not awaiting new funding; reconcile existing funds",
      );
    if (Date.parse(state.quote.expires_at) <= Date.now())
      throw Error("Quote expired; do not fund");
    const intent = {
      transaction_id: id,
      destination: tx.stellar_account_id,
      memo: tx.stellar_memo,
      memo_type: tx.stellar_memo_type,
      asset,
      amount: "0.2",
    };
    const account = await horizon.loadAccount(wallet.publicKey);
    const memo =
      intent.memo_type === "id"
        ? S.Memo.id(intent.memo)
        : intent.memo_type === "text"
          ? S.Memo.text(intent.memo)
          : intent.memo_type === "hash"
            ? S.Memo.hash(Buffer.from(intent.memo, "base64"))
            : null;
    if (!memo) throw Error("Unsupported memo");
    const payment = new S.TransactionBuilder(account, {
      fee: await horizon.fetchBaseFee(),
      networkPassphrase: S.Networks.TESTNET,
    })
      .addOperation(
        S.Operation.payment({
          destination: config.bankPublicKey,
          asset: new S.Asset("USDC", config.assetIssuer),
          amount: "0.2",
        }),
      )
      .addMemo(memo)
      .setTimeout(180)
      .build();
    payment.sign(S.Keypair.fromSecret(wallet.secret));
    state.fundingXdr = payment.toXDR();
    state.stellarHash = Buffer.from(payment.hash()).toString("hex");
    await save();
  }
  if (!/^[a-f0-9]{64}$/.test(state.stellarHash)) {
    state.stellarHash = Buffer.from(
      S.TransactionBuilder.fromXDR(state.fundingXdr, S.Networks.TESTNET).hash(),
    ).toString("hex");
    await save();
  }
  let found;
  try {
    found = await horizon.transactions().transaction(state.stellarHash).call();
  } catch (e) {
    if (e.response?.status !== 404) throw e;
  }
  if (!found) {
    if (Date.parse(state.quote.expires_at) <= Date.now())
      throw Error("Quote expired; do not submit stored payment");
    await horizon.submitTransaction(
      S.TransactionBuilder.fromXDR(state.fundingXdr, S.Networks.TESTNET),
    );
  }
  console.log("Stellar Testnet funding confirmed: " + state.stellarHash);
  for (let i = 0; i < 90; i++) {
    const current = (await call("/sep31/transactions/" + id)).transaction;
    if (current.status !== state.lastStatus) {
      state.lastStatus = current.status;
      await save();
      console.log("SEP-31 status: " + current.status);
    }
    if (current.status === "completed") {
      state.receipt = {
        environment: "Stellar Testnet + PI-SPI sandbox",
        transactionId: id,
        stellarHash: state.stellarHash,
        amountUSDC: "0.2",
        amountXOF: current.amount_out,
        externalTransactionId: current.external_transaction_id,
        status: current.status,
        completedAt: current.completed_at,
      };
      await save();
      console.log(JSON.stringify(state.receipt, null, 2));
      return;
    }
    if (["error", "refunded", "expired"].includes(current.status))
      throw Error("Payment requires reconciliation: " + current.status);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw Error(
    "Still pending; rerun the SAME run name to resume without another transfer",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
