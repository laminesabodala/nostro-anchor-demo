#!/usr/bin/env bash
# Requires Bash, curl 7.76+ and jq. Uses test funds only.
# Set DESTINATION=wallet for mobile money; default is bank.
set -euo pipefail
API=https://sandbox-api.nostro.finance
ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
DESTINATION=${DESTINATION:-bank}
DEMO_AMOUNT=${DEMO_AMOUNT:-0.2}
case "$DESTINATION" in bank|wallet) ;; *) echo 'Use DESTINATION=bank or wallet' >&2; exit 1;; esac

# 1. Session: no body or authentication.
SESSION=$(curl --fail-with-body --silent --show-error --max-time 30 -X POST "$API/sandbox/auth")
TOKEN=$(jq -er '.token' <<<"$SESSION")
ACCOUNT=$(jq -er '.account' <<<"$SESSION")

# 2. Customers: register the sender, then one receiver.
SENDER=$(curl --fail-with-body --silent --show-error --max-time 30 -X PUT "$API/sep12/customer" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg account "$ACCOUNT" '{account:$account,memo:"browser-demo-sender",memo_type:"text",type:"sep31-sender",first_name:"Demo",last_name:"Sender"}')")
SENDER_ID=$(jq -er '.id' <<<"$SENDER")
if [[ "$DESTINATION" == bank ]]; then
  METHOD=bank_account
  RECEIVER_BODY=$(jq -n --arg account "$ACCOUNT" '{account:$account,memo:"bimao-bank-amina-v1",memo_type:"text",type:"sep31-receiver",first_name:"Amina",last_name:"Diop",bank_number:"BIMAO_SANDBOX",bank_account_number:"31432"}')
else
  METHOD=mobile_money
  RECEIVER_BODY=$(jq -n --arg account "$ACCOUNT" '{account:$account,memo:"eme-wallet-lamine-v1",memo_type:"text",type:"sep31-receiver",first_name:"Lamine",last_name:"Tall",mobile_money_provider:"PI_SPI_EME_CI_SANDBOX",mobile_money_number:"+2250700000000"}')
fi
RECEIVER=$(curl --fail-with-body --silent --show-error --max-time 30 -X PUT "$API/sep12/customer" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$RECEIVER_BODY")
RECEIVER_ID=$(jq -er '.id' <<<"$RECEIVER")

# 3. Quote: default 0.2 USDC -> 100 XOF; expires in ten minutes.
QUOTE=$(curl --fail-with-body --silent --show-error --max-time 30 -X POST "$API/sep38/quote" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg asset "stellar:USDC:$ISSUER" --arg amount "$DEMO_AMOUNT" --arg method "$METHOD" '{context:"sep31",sell_asset:$asset,buy_asset:"iso4217:XOF",sell_amount:$amount,buy_delivery_method:$method}')")
QUOTE_ID=$(jq -er '.id' <<<"$QUOTE")
SELL_AMOUNT=$(jq -er '.sell_amount' <<<"$QUOTE")
printf 'Quote: %s; sender: %s; receiver: %s\n' "$QUOTE_ID" "$SENDER_ID" "$RECEIVER_ID"

# 4. Create: does not move funds. Keep these instructions for safe retries.
PAYMENT_BODY=$(jq -n --arg amount "$SELL_AMOUNT" --arg issuer "$ISSUER" --arg quote "$QUOTE_ID" --arg sender "$SENDER_ID" --arg receiver "$RECEIVER_ID" '{amount:$amount,asset_code:"USDC",asset_issuer:$issuer,destination_asset:"iso4217:XOF",quote_id:$quote,sender_id:$sender,receiver_id:$receiver,fields:{transaction:{}}}')
PAYMENT=$(curl --fail-with-body --silent --show-error --max-time 30 -X POST "$API/sep31/transactions" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PAYMENT_BODY")
PAYMENT_ID=$(jq -er '.id' <<<"$PAYMENT")
printf 'Payment ID: %s\n' "$PAYMENT_ID"

# 5. Fund: if uncertain, track/retry this SAME ID, never restart the whole script.
if ! curl --fail-with-body --silent --show-error --max-time 90 -X POST \
  "$API/sandbox/payments/$PAYMENT_ID/fund" -H "Authorization: Bearer $TOKEN"; then
  printf '\nFunding result uncertain. Track or retry payment %s; do not create another.\n' "$PAYMENT_ID" >&2
fi
printf '\n'

# 6. Track: bounded polling; completed confirms the off-chain payout.
for ((attempt=1; attempt<=40; attempt++)); do
  RESULT=$(curl --fail-with-body --silent --show-error --max-time 30 \
    "$API/sep31/transactions/$PAYMENT_ID" -H "Authorization: Bearer $TOKEN")
  STATUS=$(jq -er '.transaction.status' <<<"$RESULT")
  printf 'Status: %s\n' "$STATUS"
  case "$STATUS" in
    completed) jq '.transaction | {id,status,amount_in,amount_out,stellar_explorer_url,external_transaction_id}' <<<"$RESULT"; exit 0 ;;
    error) jq . <<<"$RESULT"; exit 1 ;;
  esac
  sleep 3
done
printf 'Still pending. Keep payment %s and continue reading its status; do not restart this script.\n' "$PAYMENT_ID" >&2
exit 2
