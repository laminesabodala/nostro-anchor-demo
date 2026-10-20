"use strict";
const S = require("@stellar/stellar-sdk");
const { amountUnits } = require("./business");
const { createPayments } = require("./payments");
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stellarExplorerUrl = hash => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)
  ? `https://stellar.expert/explorer/testnet/tx/${hash.toLowerCase()}` : null;

// This gateway exposes only public SEP routes and two bounded Testnet helpers.
async function createSandbox({ db, config, wallet, fetchImpl = fetch, horizon = new S.Horizon.Server("https://horizon-testnet.stellar.org") }) {
  const sepUrl = config.sepUrl || "http://127.0.0.1:8088";
  const platformUrl = config.platformUrl || "http://127.0.0.1:8089";
  if (!["http://127.0.0.1:8088", "http://platform:8080"].includes(sepUrl) ||
      !["http://127.0.0.1:8089", "http://platform:8085"].includes(platformUrl))
    throw Error("Unsupported internal Anchor address");
  if (config.networkPassphrase !== S.Networks.TESTNET ||
      config.assetIssuer !== "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" ||
      wallet.publicKey !== config.senderPublicKey ||
      S.Keypair.fromSecret(wallet.secret).publicKey() !== config.senderPublicKey)
    throw Error("Sandbox requires the configured Stellar Testnet wallet");
  const app = require("fastify")({ logger: false, bodyLimit: 65536 });
  // Some playground proxies send an empty body without a JSON content type.
  // Only bodyless sandbox helpers accept that form; other APIs remain strict.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (req, body, done) => {
    const helper = req.method === "POST" && /^\/sandbox\/(?:auth|payments\/[a-f0-9-]+\/fund)$/.test(req.url);
    const text = body.toString("utf8").trim();
    if (helper && (text === "" || text === "{}")) return done(null, undefined);
    return done(fail("Use application/json for a request body.", 415));
  });
  const asset = `stellar:USDC:${config.assetIssuer}`;
  const payments = createPayments({ db, config });
  await db.exec(`CREATE TABLE IF NOT EXISTS sandbox_funding(
    transaction_id text PRIMARY KEY, xdr text NOT NULL, hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE sandbox_funding ADD COLUMN IF NOT EXISTS previous_hashes jsonb NOT NULL DEFAULT '[]';
    CREATE TABLE IF NOT EXISTS sandbox_requests(
    bucket text PRIMARY KEY, count integer NOT NULL);`);
  let queue = Promise.resolve();
  const serial = (fn) => {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  };
  async function expiredAndUnused(xdr) {
    const signed = S.TransactionBuilder.fromXDR(xdr, S.Networks.TESTNET);
    if (Number(signed.timeBounds.maxTime) > Date.now() / 1000) return false;
    const ledger = (await horizon.ledgers().order("desc").limit(1).call()).records?.[0];
    const account = await horizon.loadAccount(wallet.publicKey);
    return !!ledger && Date.parse(ledger.closed_at) / 1000 > Number(signed.timeBounds.maxTime) &&
      BigInt(account.sequenceNumber()) + 1n === BigInt(signed.sequence);
  }
  async function limit(kind, maximum, interval = 60000) {
    const bucket = `${kind}:${Math.floor(Date.now() / interval)}`;
    const row = (await db.query(
      "INSERT INTO sandbox_requests(bucket,count) VALUES($1,1) ON CONFLICT(bucket) DO UPDATE SET count=sandbox_requests.count+1 RETURNING count",
      [bucket])).rows[0];
    if (row.count > maximum) throw fail("Sandbox request limit reached; retry later.", 429);
  }
  async function upstream(path, token, method = "GET", body) {
    const response = await fetchImpl(sepUrl + path, {
      method, redirect: "error", signal: AbortSignal.timeout(25000),
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      let error;
      try { error = (await response.json()).error; } catch {}
      throw fail(response.status < 500 && typeof error === "string"
        ? error.slice(0, 500) : "Anchor rejected the request; check the token, payment and quote.", response.status);
    }
    return response.json();
  }
  app.setErrorHandler((e, req, reply) => {
    if (!e.statusCode || e.statusCode >= 500)
      console.error(JSON.stringify({ event: "sandbox-error", name: e.name, code: e.code,
        message: String(e.message).slice(0, 180) }));
    return reply.code(e.statusCode || 503).send({
    error: e.statusCode && e.statusCode < 500 ? e.message : "Sandbox temporarily unavailable; retry the same payment."
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin === "https://nostro.mintlify.site") {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "Authorization,Content-Type,ngrok-skip-browser-warning");
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
    await limit("requests", 180);
  });
  app.post("/sandbox/auth", async () => {
    await limit("auth", 10);
    const challenge = await upstream("/auth?account=" + wallet.publicKey);
    const domain = new URL(config.publicUrl).hostname;
    const parsed = S.WebAuth.readChallengeTx(challenge.transaction, config.signingPublicKey,
      S.Networks.TESTNET, domain, domain);
    if (parsed.clientAccountID !== wallet.publicKey) throw Error("Unexpected challenge account");
    parsed.tx.sign(S.Keypair.fromSecret(wallet.secret));
    const result = await upstream("/auth", null, "POST", { transaction: parsed.tx.toXDR() });
    return { account: wallet.publicKey, token: result.token,
      environment: "testnet", sharedDemoAccount: true };
  });
  app.post("/sep31/transactions", async (req, reply) => serial(async () => {
    reply.code(201);
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) throw fail("Bearer token required", 401);
    const token = auth.slice(7);
    // Authenticate through the official AP before reserving any local state.
    await upstream("/sep12/customer?account=" + config.senderPublicKey +
      "&type=sep31-sender&memo=payment-preflight&memo_type=text", token);
    const { fresh, record } = await payments.reserve(req.body);
    if (!fresh) {
      if (record.state === "REJECTED") throw fail("The previous payment request was rejected. Request a new quote.", 409);
      if (!record.transaction_id)
        throw fail("Payment creation is awaiting reconciliation. Retry this same request; do not fund a second payment.", 409);
      const tx = (await upstream("/sep31/transactions/" + record.transaction_id, token)).transaction;
      return { id: tx.id, stellar_account_id: tx.stellar_account_id,
        stellar_memo: tx.stellar_memo, stellar_memo_type: tx.stellar_memo_type };
    }
    let result;
    try { result = await upstream("/sep31/transactions", token, "POST", record.request); }
    catch (e) {
      await payments.mark(record.quote_id, e.statusCode && e.statusCode < 500 ? "REJECTED" : "UNKNOWN");
      throw e;
    }
    await payments.bind(result.id, record.quote_id);
    return result;
  }));
  app.post("/sandbox/payments/:id/fund", async (req) => {
    if (!UUID.test(req.params.id)) throw fail("Invalid payment ID");
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) throw fail("Bearer token required", 401);
    const token = authorization.slice(7);
    await limit("fund", 15);
    return serial(async () => {
      const id = req.params.id;
      // Anchor authenticates the caller and enforces ownership before any signing.
      const tx = (await upstream("/sep31/transactions/" + id, token)).transaction;
      const quote = await upstream("/sep38/quote/" + tx.quote_id, token);
      // SEP-31's public response omits customer IDs. Resolve the binding privately.
      const internalResponse = await fetchImpl(platformUrl + "/transactions/" + id, {
        headers: { "X-Api-Key": config.platformApiKey },
        redirect: "error", signal: AbortSignal.timeout(15000)
      });
      if (!internalResponse.ok) throw Error("Cannot resolve payment binding");
      const internal = await internalResponse.json();
      if (internal.id !== id || internal.creator?.account !== config.senderPublicKey ||
          internal.quote_id !== tx.quote_id)
        throw fail("Payment sender or quote mismatch.", 403);
      await payments.forTransaction(internal);
      const intent = (await db.query("SELECT * FROM funding_intents WHERE transaction_id=$1", [id])).rows[0];
      if (tx.id !== id || quote.id !== tx.quote_id || !Number.isFinite(Date.parse(quote.expires_at)) ||
          tx.stellar_account_id !== config.bankPublicKey ||
          tx.amount_in_asset !== asset || amountUnits(tx.amount_in) !== amountUnits(quote.sell_amount) ||
          tx.amount_out_asset !== "iso4217:XOF" || !/^\d+$/.test(tx.amount_out) ||
          Number(tx.amount_out) < 100 || Number(tx.amount_out) > 2500 ||
          amountUnits(tx.amount_in) !== BigInt(tx.amount_out) * 20000n ||
          quote.sell_asset !== asset || quote.buy_asset !== "iso4217:XOF" ||
          amountUnits(quote.buy_amount) !== amountUnits(tx.amount_out) ||
          !intent || intent.asset !== asset || intent.destination !== tx.stellar_account_id ||
          intent.memo !== tx.stellar_memo || intent.memo_type !== tx.stellar_memo_type)
        throw fail("Choose a payment between 100 and 2500 XOF and use its matching quote.");
      let saved = (await db.query("SELECT * FROM sandbox_funding WHERE transaction_id=$1", [id])).rows[0];
      if (tx.status === "completed") return { transactionId: id, status: tx.status,
        stellarTransactionId: tx.stellar_transaction_id,
        stellarExplorerUrl: stellarExplorerUrl(tx.stellar_transaction_id) };
      if (!saved) {
        if (tx.status !== "pending_sender" || Date.parse(quote.expires_at) <= Date.now())
          throw fail("Payment must be awaiting funding with an unexpired quote.", 409);
        const count = Number((await db.query("SELECT count(*) AS count FROM sandbox_funding")).rows[0].count);
        if (count >= 50) throw fail("Public demo funding budget exhausted.", 429);
        // A single outstanding signed transaction avoids ambiguous sequence reuse.
        const previous = (await db.query("SELECT * FROM sandbox_funding ORDER BY created_at DESC LIMIT 1")).rows[0];
        if (previous) {
          try {
            const result = await horizon.transactions().transaction(previous.hash).call();
            if (result.successful !== true) throw Error("Failed funding");
          }
          catch (e) {
            if (e.response?.status !== 404 || !await expiredAndUnused(previous.xdr))
              throw fail("Previous funding is awaiting reconciliation; retry that payment.", 409);
          }
        }
        const account = await horizon.loadAccount(wallet.publicKey);
        const memo = tx.stellar_memo_type === "hash" ? S.Memo.hash(Buffer.from(tx.stellar_memo, "base64")) : null;
        if (!memo) throw fail("Unsupported funding memo");
        const payment = new S.TransactionBuilder(account, {
          fee: await horizon.fetchBaseFee(), networkPassphrase: S.Networks.TESTNET
        }).addOperation(S.Operation.payment({ destination: config.bankPublicKey,
          asset: new S.Asset("USDC", config.assetIssuer), amount: tx.amount_in }))
          .addMemo(memo).setTimeout(180).build();
        payment.sign(S.Keypair.fromSecret(wallet.secret));
        saved = { xdr: payment.toXDR(), hash: Buffer.from(payment.hash()).toString("hex") };
        await db.query("INSERT INTO sandbox_funding(transaction_id,xdr,hash) VALUES($1,$2,$3)", [id, saved.xdr, saved.hash]);
      }
      if (!/^[a-f0-9]{64}$/.test(saved.hash)) {
        saved.hash = Buffer.from(S.TransactionBuilder.fromXDR(saved.xdr, S.Networks.TESTNET).hash()).toString("hex");
        await db.query("UPDATE sandbox_funding SET hash=$2 WHERE transaction_id=$1", [id, saved.hash]);
      }
      let found;
      try { found = await horizon.transactions().transaction(saved.hash).call(); }
      catch (e) { if (e.response?.status !== 404) throw e; }
      if (found && found.successful !== true) throw fail("Funding failed on Testnet; contact Nostro for reconciliation.", 409);
      if (!found) {
        if (Date.parse(quote.expires_at) <= Date.now()) throw fail("Quote expired; funding requires reconciliation.", 409);
        let signed = S.TransactionBuilder.fromXDR(saved.xdr, S.Networks.TESTNET);
        if (Number(signed.timeBounds.maxTime) <= Date.now() / 1000) {
          if (!await expiredAndUnused(saved.xdr))
            throw fail("Funding window expired; contact Nostro for reconciliation.", 409);
          const account = await horizon.loadAccount(wallet.publicKey);
          // Horizon has passed the old validity window and its sequence remains unused.
          // Replace only the expired envelope, preserving payment, amount and memo.
          const replacement = new S.TransactionBuilder(account, {
            fee: await horizon.fetchBaseFee(), networkPassphrase: S.Networks.TESTNET
          }).addOperation(S.Operation.payment({ destination: config.bankPublicKey,
            asset: new S.Asset("USDC", config.assetIssuer), amount: tx.amount_in }))
            .addMemo(signed.memo).setTimeout(180).build();
          replacement.sign(S.Keypair.fromSecret(wallet.secret));
          const newHash = Buffer.from(replacement.hash()).toString("hex");
          await db.query("UPDATE sandbox_funding SET previous_hashes=previous_hashes || $3::jsonb,xdr=$4,hash=$2 WHERE transaction_id=$1",
            [id, newHash, JSON.stringify([saved.hash]), replacement.toXDR()]);
          saved.hash = newHash;
          signed = replacement;
        }
        const result = await horizon.submitTransaction(signed);
        if (result.successful !== true) throw fail("Funding requires reconciliation.", 409);
      }
      return { transactionId: id, status: "funding_confirmed", stellarTransactionId: saved.hash,
        stellarExplorerUrl: stellarExplorerUrl(saved.hash),
        message: "Testnet funding confirmed. Read the SEP-31 payment until its status is completed." };
    });
  });
  // Never proxy callbacks, Platform API, arbitrary upstream URLs or management routes.
  app.all("/*", async (req, reply) => {
    const pathname = req.url.split("?")[0];
    const allowed = {
      GET: /^\/(?:auth|\.well-known\/stellar\.toml|sep12\/customer|sep31\/info|sep31\/transactions\/[a-f0-9-]{36}|sep38\/(?:info|prices|price|quote\/[a-f0-9-]{36}))$/,
      POST: /^\/(?:auth|sep31\/transactions|sep38\/quote)$/,
      PUT: /^\/sep12\/customer$/,
    };
    if (!allowed[req.method]?.test(pathname)) return reply.code(404).send({ error: "Not found" });
    if (req.method === "PUT" && pathname === "/sep12/customer" &&
        (req.body?.account_number_type != null || req.body?.destination != null))
      throw fail("Use the standard flat bank or mobile-money fields shown in the examples.");
    const response = await fetchImpl(sepUrl + req.url, {
      method: req.method, redirect: "error", signal: AbortSignal.timeout(25000),
      headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.body ? { "Content-Type": "application/json" } : {}) },
      body: req.body ? JSON.stringify(req.body) : undefined
    });
    reply.code(response.status).header("Content-Type", response.headers.get("content-type") || "application/json");
    // Presentation-only sandbox extension; Anchor remains the source of the hash.
    if (response.ok && req.method === "GET" && /^\/sep31\/transactions\/[a-f0-9-]{36}$/.test(pathname)) {
      const result = await response.json();
      if (result.transaction) result.transaction.stellar_explorer_url =
        stellarExplorerUrl(result.transaction.stellar_transaction_id);
      return reply.send(result);
    }
    return reply.send(await response.text());
  });
  return app;
}
module.exports = { createSandbox };
