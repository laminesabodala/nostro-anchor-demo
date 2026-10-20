"use strict";
const { createHash } = require("node:crypto");
const BASE = "https://no-mtls.piz.simulateurs.pi-bceao.com/SNB999";
const TOKEN =
  "https://piz-simulateur-business-sandbox.auth.eu-west-1.amazoncognito.com/oauth2/token";
class PispiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
function createPispiPayout({
  clientId,
  clientSecret,
  apiKey,
  payerAlias,
  allowedRecipientAliases = [],
  maxAmountXof = 10000,
  baseUrl = BASE,
  tokenUrl = TOKEN,
  fetchImpl = fetch,
}) {
  if (baseUrl !== BASE || tokenUrl !== TOKEN)
    throw new Error("This demo adapter permits only the PI-SPI sandbox");
  if (
    ![clientId, clientSecret, apiKey, payerAlias].every(
      (v) => typeof v === "string" && v,
    )
  )
    throw new Error("Missing PI-SPI configuration");
  if (
    !Number.isSafeInteger(maxAmountXof) ||
    maxAmountXof < 1 ||
    maxAmountXof > 10000
  )
    throw new Error("Invalid sandbox transfer cap");
  const recipients = new Set(allowedRecipientAliases);
  if (!recipients.size)
    throw new Error("Explicit sandbox beneficiary allowlist required");
  let cached, pending;
  async function token() {
    if (cached?.until > Date.now()) return cached.value;
    if (!pending)
      pending = (async () => {
        let r;
        try {
          r = await fetchImpl(TOKEN, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: clientId,
              client_secret: clientSecret,
              scope:
                "piz/compte.read piz/enrolement_alias.read piz/paiement.write piz/paiement.read",
            }).toString(),
          });
        } catch {
          throw new PispiError(
            "PROVIDER_UNAVAILABLE",
            "PI-SPI authentication unavailable",
          );
        }
        if (!r.ok)
          throw new PispiError(
            "AUTH_FAILED",
            "PI-SPI authentication failed",
            r.status,
          );
        const t = await r.json();
        if (
          typeof t.access_token !== "string" ||
          !Number.isFinite(t.expires_in)
        )
          throw new PispiError(
            "INVALID_RESPONSE",
            "Invalid PI-SPI authentication response",
          );
        cached = {
          value: t.access_token,
          until: Date.now() + Math.max(0, t.expires_in - 60) * 1000,
        };
        return cached.value;
      })().finally(() => (pending = null));
    return pending;
  }
  async function request(path, method = "GET", body) {
    const accessToken = await token();
    let r;
    try {
      r = await fetchImpl(BASE + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-API-Key": apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new PispiError(
        method === "POST" ? "OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE",
        "PI-SPI response unavailable; reconcile the existing transaction",
      );
    }
    if (r.status === 401) cached = null;
    if (r.status === 404 && method === "GET") return null;
    if (!r.ok)
      throw new PispiError(
        method === "POST" ? "OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE",
        "PI-SPI request failed; reconcile before retry",
        r.status,
      );
    try {
      return await r.json();
    } catch {
      throw new PispiError(
        method === "POST" ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE",
        "Invalid PI-SPI response",
      );
    }
  }
  function prepare({ paymentId, recipientAlias, amountXof }) {
    if (typeof paymentId !== "string" || !paymentId || paymentId.length > 200)
      throw new Error("Invalid paymentId");
    if (!recipients.has(recipientAlias))
      throw new Error("Sandbox beneficiary not permitted");
    if (
      !Number.isSafeInteger(amountXof) ||
      amountXof < 1 ||
      amountXof > maxAmountXof
    )
      throw new Error("Invalid sandbox XOF amount");
    return Object.freeze({
      txId:
        "NST" +
        createHash("sha256").update(paymentId).digest("hex").slice(0, 30),
      payeurAlias: payerAlias,
      payeAlias: recipientAlias,
      montant: amountXof,
      confirmation: false,
      motif: "Nostro Stellar Testnet demo - virtual funds",
    });
  }
  function validateIntent(i) {
    if (
      !i ||
      !/^NST[0-9a-f]{30}$/.test(i.txId) ||
      i.payeurAlias !== payerAlias ||
      !recipients.has(i.payeAlias) ||
      !Number.isSafeInteger(i.montant) ||
      i.montant < 1 ||
      i.montant > maxAmountXof ||
      i.confirmation !== false
    )
      throw new Error("Invalid persisted PI-SPI intent");
    return {
      txId: i.txId,
      payeurAlias: i.payeurAlias,
      payeAlias: i.payeAlias,
      montant: i.montant,
      confirmation: false,
      motif: "Nostro Stellar Testnet demo - virtual funds",
    };
  }
  function normalize(raw, txId) {
    if (!raw || raw.txId !== txId || typeof raw.statut !== "string")
      throw new PispiError(
        "INVALID_RESPONSE",
        "PI-SPI response does not match transaction",
      );
    const providerStatus = raw.statut;
    const status =
      providerStatus === "IRREVOCABLE"
        ? "completed"
        : ["REJETE", "ANNULE"].includes(providerStatus) &&
            raw.statutRaison !== "DU03"
          ? "failed"
          : "pending";
    return {
      txId,
      status,
      providerStatus,
      ...(raw.end2endId ? { endToEndId: raw.end2endId } : {}),
      ...(raw.statutRaison ? { reason: raw.statutRaison } : {}),
      ...(raw.montant !== undefined ? { amountXof: raw.montant } : {}),
      ...(raw.payeAlias ? { recipientAlias: raw.payeAlias } : {}),
      ...(raw.dateIrrevocabilite
        ? { completedAt: raw.dateIrrevocabilite }
        : {}),
    };
  }
  return {
    kind: "pispi-sandbox",
    prepare,
    async send(intent) {
      const body = validateIntent(intent);
      const result = normalize(
        await request("/paiements-envoyes", "POST", body),
        body.txId,
      );
      if (
        (result.amountXof !== undefined && result.amountXof !== body.montant) ||
        (result.recipientAlias !== undefined &&
          result.recipientAlias !== body.payeAlias)
      )
        throw new PispiError(
          "INVALID_RESPONSE",
          "PI-SPI response does not match payout intent",
        );
      return result;
    },
    async getStatus(txId) {
      if (!/^NST[0-9a-f]{30}$/.test(txId)) throw new Error("Invalid txId");
      const raw = await request(
        "/paiements-envoyes/" + encodeURIComponent(txId),
      );
      return raw ? normalize(raw, txId) : null;
    },
    async getBalance(accountNumber) {
      if (!/^\d{1,35}$/.test(accountNumber)) throw new Error("Invalid account");
      return request("/comptes/" + accountNumber);
    },
    async resolveAlias(alias) {
      if (!recipients.has(alias) && alias !== payerAlias)
        throw new Error("Alias not permitted");
      return request("/alias/" + encodeURIComponent(alias));
    },
  };
}
module.exports = { createPispiPayout, PispiError };
