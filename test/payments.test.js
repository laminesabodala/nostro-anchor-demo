"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createStore } = require("../src/store");
const { createBusiness } = require("../src/business");
const { createPayments } = require("../src/payments");
const config = {assetCode:"USDC",assetIssuer:"issuer",senderPublicKey:"partner"};
async function setup(t, method = "bank_account") {
  const db = await createStore(); t.after(()=>db.close());
  const business = createBusiness({db,config}), payments = createPayments({db,config});
  const common = {account:"partner",memo_type:"text"};
  const sender = await business.putCustomer({...common,memo:"sender",type:"sep31-sender",first_name:"Demo",last_name:"Sender"});
  const receiverInput = {...common,memo:"receiver",type:"sep31-receiver",...(method==="bank_account"
    ? {first_name:"Amina",last_name:"Diop",bank_number:"BIMAO_SANDBOX",bank_account_number:"31432"}
    : {first_name:"Lamine",last_name:"Tall",mobile_money_provider:"PI_SPI_EME_CI_SANDBOX",mobile_money_number:"+2250700000000"})};
  const receiver = await business.putCustomer(receiverInput);
  const quote = (await business.rate({type:"firm",client_id:"partner",sell_asset:"stellar:USDC:issuer",
    buy_asset:"iso4217:XOF",sell_amount:"0.2",buy_delivery_method:method})).rate;
  const body = {amount:"0.2",asset_code:"USDC",asset_issuer:"issuer",destination_asset:"iso4217:XOF",
    sender_id:sender.id,receiver_id:receiver.id,quote_id:quote.id,fields:{transaction:{}}};
  return {db,business,payments,body,receiverInput};
}
test("quote reservation is stable across concurrent retries and rejects a different instruction", async t => {
  const {payments,body} = await setup(t);
  const results = await Promise.all([payments.reserve(body),payments.reserve(body)]);
  assert.deepEqual(results.map(r=>r.fresh).sort(),[false,true]);
  await assert.rejects(payments.reserve({...body,amount:"0.3"}),{statusCode:409});
});
test("expired quote, wrong method, wrong amount and legacy customer rejected before funding", async t => {
  const {db,payments,body} = await setup(t);
  await assert.rejects(payments.reserve({...body,amount:"1"}),/must match/);
  await db.query("UPDATE quotes SET delivery_method='mobile_money'");
  await assert.rejects(payments.reserve(body),/does not match/);
  await db.query("UPDATE quotes SET delivery_method='bank_account',expires_at='2020-01-01'");
  await assert.rejects(payments.reserve(body),/expired/);
  await db.query("UPDATE quotes SET expires_at='2099-01-01'");
  await db.query("UPDATE customers SET destination=NULL WHERE id=$1",[body.receiver_id]);
  await assert.rejects(payments.reserve(body),/Legacy/);
});
test("bank destination immutable and reserved snapshot survives later customer changes", async t => {
  const {db,business,payments,body,receiverInput} = await setup(t);
  await assert.rejects(business.putCustomer({...receiverInput,first_name:"Moussa",last_name:"Ndiaye",bank_account_number:"41625"}));
  const {record} = await payments.reserve(body);
  await db.query("UPDATE customers SET destination=NULL WHERE id=$1",[body.receiver_id]);
  await payments.mark(body.quote_id,"UNKNOWN");
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const bound = await payments.forTransaction({id,quote_id:body.quote_id,creator:{account:"partner"},
    customers:{sender:{id:body.sender_id},receiver:{id:body.receiver_id}},
    amount_in:{asset:"stellar:USDC:issuer",amount:"0.2"}});
  assert.deepEqual(bound.destination, record.destination);
  assert.equal(bound.transaction_id,id);
  await assert.rejects(payments.bind("bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",body.quote_id),/reconciliation/);
});
test("mobile-money profile reserves independently with the matching quote",async t=>{
  const {payments,body} = await setup(t,"mobile_money");
  const {record} = await payments.reserve(body);
  assert.equal(record.destination.type,"mobile_money");
  assert.equal(record.destination.provider,"PI_SPI_EME_CI_SANDBOX");
});
