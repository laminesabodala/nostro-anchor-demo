"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { parseDestination, approvedDestination, walletDestination, BANK_NUMBER } = require("../src/destinations");
const bank = { first_name: "Amina", last_name: "Diop", bank_number: BANK_NUMBER, bank_account_number: "31432" };
const wallet = { first_name: "Lamine", last_name: "Tall", mobile_money_provider: "PI_SPI_EME_CI_SANDBOX", mobile_money_number: "+2250700000000" };
test("fixed bank and wallet test profiles map to explicit simulated routes", () => {
  assert.equal(parseDestination(bank).type, "bank_account");
  assert.deepEqual(parseDestination(wallet), walletDestination());
  assert.equal(approvedDestination(parseDestination(bank)), true);
  assert.equal(approvedDestination(parseDestination(wallet)), true);
});
test("unknown bank, wallet, account, name and mixed fields fail closed", () => {
  for (const input of [
    {...bank,bank_number:"ANOTHER_BANK"}, {...bank,bank_account_number:"99999"},
    {...bank,bank_account_number:"SN15SN0150101307430029018"}, {...bank,last_name:"Other"},
    {...wallet,mobile_money_provider:"Orange"}, {...wallet,mobile_money_number:"+221771111111"},
    {...bank,...wallet}, {...bank,account_number_type:"iban"}
  ]) assert.throws(() => parseDestination(input), {statusCode:400});
  const tampered = parseDestination(bank); tampered.route.alias = "other";
  assert.equal(approvedDestination(tampered), false);
});
