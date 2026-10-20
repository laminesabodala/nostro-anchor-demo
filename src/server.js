"use strict";
const fs = require("node:fs/promises"),
  path = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const { createStore } = require("./store");
const { createBusiness, FIXTURES } = require("./business");
const { createProcessor } = require("./processor");
const { createPispiPayout } = require("./pispi");
async function start() {
  const root = path.resolve(__dirname, "..");
  const config = JSON.parse(
    await fs.readFile(path.join(root, ".local-platform/runtime.json"), "utf8"),
  );
  if (
    config.assetCode !== "USDC" ||
    config.assetIssuer !==
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" ||
    config.platformUrl !== "http://127.0.0.1:8089"
  )
    throw new Error("Testnet-only configuration required");
  const privateConfig = JSON.parse(
    await fs.readFile(
      process.env.PISPI_CONFIG_FILE ||
        path.resolve(root, "../../backend/.local-integrations/providers.json"),
      "utf8",
    ),
  );
  const pispi = createPispiPayout({
    ...privateConfig.pispi,
    payerAlias: "9a60b796-ad4c-4cbb-8558-0852a368e71f",
    allowedRecipientAliases: FIXTURES.map((f) => f.alias),
    maxAmountXof: 2500,
  });
  await fs.mkdir(path.join(root, ".local"), { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".local/business.lock");
  await fs.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  let db, app, timer;
  try {
    db = await createStore(path.join(root, ".local/business-db"));
    app = require("fastify")({ logger: false, bodyLimit: 65536 });
    const business = createBusiness({ db, config });
    const processor = createProcessor({ db, config, pispi });
    app.setErrorHandler((e, req, reply) =>
      reply
        .code(e.statusCode || 500)
        .send({
          error:
            e.statusCode && e.statusCode < 500
              ? e.message
              : "Sandbox service unavailable",
        }),
    );
    app.get("/health", async () => ({
      status: "ready",
      environment: "testnet-pispi-sandbox",
    }));
    app.register(
      async (routes) => {
        routes.addHook("onRequest", async (req, reply) => {
          const got = Buffer.from(req.headers["x-api-key"] || "");
          const wanted = Buffer.from(config.callbackApiKey);
          if (got.length !== wanted.length || !timingSafeEqual(got, wanted))
            return reply.code(401).send({ error: "Unauthorized" });
        });
        routes.get("/customer", (req) => business.getCustomer(req.query));
        routes.put("/customer", async (req, reply) =>
          reply.code(202).send(await business.putCustomer(req.body)),
        );
        routes.get("/rate", (req) => business.rate(req.query));
        routes.get("/unique_address", async (req) => {
          const id = req.query.transaction_id;
          if (typeof id !== "string" || !/^[a-zA-Z0-9-]{16,64}$/.test(id))
            throw Object.assign(new Error("Invalid transaction reference"), {
              statusCode: 400,
            });
          const memo = require("node:crypto")
            .createHash("sha256")
            .update("nostro-testnet:" + id)
            .digest("base64");
          await db.query(
            "INSERT INTO funding_intents(transaction_id,destination,memo,memo_type,asset) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [
              id,
              config.bankPublicKey,
              memo,
              "hash",
              `stellar:USDC:${config.assetIssuer}`,
            ],
          );
          const saved = (
            await db.query(
              "SELECT * FROM funding_intents WHERE transaction_id=$1",
              [id],
            )
          ).rows[0];
          return {
            unique_address: {
              stellar_address: saved.destination,
              memo: saved.memo,
              memo_type: saved.memo_type,
            },
          };
        });
        routes.post("/event", async (req) => {
          const e = req.body;
          if (typeof e.id !== "string" || typeof e.type !== "string")
            throw Object.assign(new Error("Invalid event"), {
              statusCode: 400,
            });
          await db.query(
            "INSERT INTO events(id,type) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [e.id, e.type],
          );
          return { code: 200, message: "accepted" };
        });
      },
      { prefix: "/internal/anchor" },
    );
    const run = () =>
      processor
        .tick()
        .catch(() =>
          console.error(
            JSON.stringify({
              event: "anchor-poll",
              code: "PLATFORM_UNAVAILABLE",
            }),
          ),
        );
    await app.listen({ host: "0.0.0.0", port: 3010 });
    timer = setInterval(run, 2500);
    run();
    async function close() {
      clearInterval(timer);
      await app.close();
      await processor.drain();
      await db.close();
      await fs.unlink(lock).catch(() => {});
    }
    process.once("SIGINT", () => close());
    process.once("SIGTERM", () => close());
    console.log("Nostro isolated anchor business server ready on port 3010");
    return { app, db, processor, close };
  } catch (e) {
    clearInterval(timer);
    await app?.close();
    await db?.close();
    await fs.unlink(lock).catch(() => {});
    throw e;
  }
}
if (require.main === module)
  start().catch(() => {
    console.error(
      "Anchor business startup failed; inspect isolated configuration or lock without exposing credentials.",
    );
    process.exitCode = 1;
  });
module.exports = { start };
