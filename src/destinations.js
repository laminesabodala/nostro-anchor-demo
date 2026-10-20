"use strict";
const { isDeepStrictEqual } = require("node:util");
// This is a fictional BIMAO route, not a BIMAO PI participant code.
// PI requires alias addressing within SNB999. The public recipient uses an
// account number; only this explicit sandbox mapping supplies the internal alias.
const BANK_NUMBER = "BIMAO_SANDBOX";
const WALLET_PROVIDER = "PI_SPI_EME_CI_SANDBOX";
// A test input mapped explicitly to the existing PI virtual account below.
// This number is not claimed to be registered with a commercial wallet provider.
const WALLET_NUMBER = "+2250700000000";
const FIXTURES = Object.freeze([
  Object.freeze({ first_name: "Amina", last_name: "Diop", accountNumber: "31432",
    alias: "f77fdb95-7053-4389-bd45-b3bba0311c7c" }),
  Object.freeze({ first_name: "Moussa", last_name: "Ndiaye", accountNumber: "41625",
    alias: "6632f81a-6fbc-4b68-8ddc-c7e3a24cda40" }),
]);
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
function destinationFor(fixture) {
  return { type: "bank_account", bankNumber: BANK_NUMBER,
    accountNumber: fixture.accountNumber, simulation: true,
    route: { participant: "SNB999", alias: fixture.alias } };
}
function walletDestination() {
  return { type: "mobile_money", provider: WALLET_PROVIDER, phoneNumber: WALLET_NUMBER,
    simulation: true, route: { participant: "CIC999", accountNumber: "53774" } };
}
function approvedDestination(destination) {
  if (destination?.type === "mobile_money") return isDeepStrictEqual(walletDestination(), destination);
  const f = FIXTURES.find(f => f.accountNumber === destination?.accountNumber);
  return !!f && isDeepStrictEqual(destinationFor(f), destination);
}
function parseDestination(q) {
  const bank = q.bank_number != null || q.bank_account_number != null;
  const wallet = q.mobile_money_provider != null || q.mobile_money_number != null;
  if (bank && wallet) throw fail("Provide either bank-account fields or mobile-money fields, never both.");
  if (wallet) {
    if (q.mobile_money_provider !== WALLET_PROVIDER || q.mobile_money_number !== WALLET_NUMBER)
      throw fail("Unsupported wallet. Use PI_SPI_EME_CI_SANDBOX and +2250700000000 (test-number mapping to PI virtual account 53774).");
    if (q.first_name !== "Lamine" || q.last_name !== "Tall")
      throw fail("The PI-SPI virtual wallet fixture belongs to Lamine Tall.");
    return walletDestination();
  }
  if (q.account_number_type != null)
    throw fail("account_number_type is not supported; submit bank_account_number.");
  if (q.bank_number !== BANK_NUMBER)
    throw fail("Unsupported institution. Use BIMAO_SANDBOX.");
  const f = FIXTURES.find(f => f.accountNumber === q.bank_account_number);
  if (!f) throw fail("Unsupported sandbox account. Use 31432 (Amina Diop) or 41625 (Moussa Ndiaye). IBAN payouts are not enabled in this demo.");
  if (f.first_name !== q.first_name || f.last_name !== q.last_name)
    throw fail("The name must match the selected account.");
  return destinationFor(f);
}
function recipientFields() {
  return {
    first_name: { type: "string", description: "Virtual holder: Amina or Moussa (bank), Lamine (EME wallet)." },
    last_name: { type: "string", description: "Diop for bank account 31432; Ndiaye for 41625; Tall for the EME wallet fixture." },
    bank_number: { type: "string", optional: true, choices: [BANK_NUMBER],
      description: "Bank code. Use BIMAO_SANDBOX for the bank test profiles." },
    bank_account_number: { type: "string", optional: true, choices: FIXTURES.map(f => f.accountNumber),
      description: "31432: Amina Diop; 41625: Moussa Ndiaye." },
    mobile_money_provider: { type: "string", optional: true, choices: [WALLET_PROVIDER],
      description: "PI-SPI EME Côte d'Ivoire 999 simulator. Required with mobile_money_number; omit bank fields." },
    mobile_money_number: { type: "string", optional: true, choices: [WALLET_NUMBER],
      description: "Test phone input mapped to virtual CIC999 account 53774. No phone ownership verification or SMS. Required with mobile_money_provider." },
  };
}
module.exports = { BANK_NUMBER, WALLET_PROVIDER, WALLET_NUMBER, FIXTURES, destinationFor, walletDestination, approvedDestination, parseDestination, recipientFields };
