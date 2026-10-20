'use strict';
// Generates local-only Testnet credentials. Never use these accounts on Public Network.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Keypair } = require('@stellar/stellar-sdk');
const root = process.env.ANCHOR_RUNTIME_DIR
  ? path.resolve(process.env.ANCHOR_RUNTIME_DIR)
  : path.resolve(__dirname, '../.local-platform');
fs.mkdirSync(root,{recursive:true,mode:0o700});
const runtimePath=path.join(root,'runtime.json');
const write=(name,value)=>fs.writeFileSync(path.join(root,name),value,{mode:0o600});
let runtime;
if (fs.existsSync(runtimePath)) runtime=JSON.parse(fs.readFileSync(runtimePath));
else {
 const bank=Keypair.random(),sender=Keypair.random(),signer=Keypair.random();
 runtime={publicUrl:'http://localhost:8088',platformUrl:'http://127.0.0.1:8089',callbackApiKey:crypto.randomBytes(32).toString('hex'),platformApiKey:crypto.randomBytes(32).toString('hex'),jwtSecret:crypto.randomBytes(32).toString('hex'),databasePassword:crypto.randomBytes(32).toString('hex'),signingSeed:signer.secret(),signingPublicKey:signer.publicKey(),bankPublicKey:bank.publicKey(),senderPublicKey:sender.publicKey(),assetCode:'USDC',assetIssuer:'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',networkPassphrase:'Test SDF Network ; September 2015'};
 write('runtime.json',JSON.stringify(runtime,null,2));write('sender.json',JSON.stringify({publicKey:sender.publicKey(),secret:sender.secret()},null,2));write('bank.json',JSON.stringify({publicKey:bank.publicKey(),secret:bank.secret()},null,2));
}
const entries={
'secret.data.username':'anchor','secret.data.password':runtime.databasePassword,'POSTGRES_USER':'anchor','POSTGRES_PASSWORD':runtime.databasePassword,'POSTGRES_DB':'anchor',
'secret.platform_api.auth_secret':runtime.platformApiKey,'secret.callback_api.auth_secret':runtime.callbackApiKey,'secret.sep10.jwt_secret':runtime.jwtSecret,'secret.sep10.signing_seed':runtime.signingSeed,
'app_logging.stellar_level':'INFO','app_logging.request_logger_enabled':'false','languages':'en','stellar_network.network':'TESTNET','stellar_network.horizon_url':'https://horizon-testnet.stellar.org',
'callback_api.base_url':'http://host.docker.internal:3010/internal/anchor','callback_api.auth.type':'api_key','platform_api.base_url':'http://platform:8085','platform_api.auth.type':'api_key','platform_server.auth.type':'api_key',
'data.type':'postgres','data.server':'db:5432','data.database':'anchor','data.flyway_enabled':'true','assets.type':'file','assets.value':'/config/assets.yaml',
'sep1.enabled':'true','sep1.toml.type':'file','sep1.toml.value':'/config/stellar.toml','sep6.enabled':'false','sep24.enabled':'false','sep10.enabled':'true','sep10.web_auth_domain':new URL(runtime.publicUrl).host,'sep10.home_domains':new URL(runtime.publicUrl).host,'sep12.enabled':'true','sep31.enabled':'true','sep31.deposit_info_generator_type':'api','sep38.enabled':'true','sep38.sep10_enforced':'true',
'clients[0].name':'nostro-demo-sender','clients[0].type':'custodial','clients[0].signing_key':runtime.senderPublicKey,'sep10.client_allow_list':'nostro-demo-sender',
'events.enabled':'true','events.queue.type':'kafka','events.queue.kafka.bootstrap_server':'kafka:9092','event_processor.client_status_callback.enabled':'false','event_processor.callback_api_request.enabled':'true','JVM_FLAGS':'-Xms128m -Xmx512m'
};
write('runtime.env',Object.entries(entries).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
write('assets.yaml',`assets:
  - schema: stellar
    code: USDC
    issuer: ${runtime.assetIssuer}
    distribution_account: ${runtime.bankPublicKey}
    significant_decimals: 7
    deposit:
      enabled: false
    withdraw:
      enabled: false
    send:
      fee_fixed: 0
      fee_percent: 0
      min_amount: 0
      max_amount: 5
    sep31:
      quotes_supported: true
      quotes_required: true
      sep12:
        sender:
          types:
            sep31-sender:
              description: Sandbox sender
        receiver:
          types:
            sep31-receiver:
              description: BIMAO-simulated bank account or PI-SPI virtual EME account
      fields:
        transaction: {}
    sep38:
      exchangeable_assets:
        - iso4217:XOF
    sep6_enabled: false
    sep24_enabled: false
    sep31_enabled: true
    sep38_enabled: true
  - schema: iso4217
    code: XOF
    significant_decimals: 0
    sep38:
      exchangeable_assets:
        - stellar:USDC:${runtime.assetIssuer}
      country_codes:
        - SEN
        - CIV
      buy_delivery_methods:
        - name: bank_account
          description: Bank account
        - name: mobile_money
          description: Mobile-money account
    sep38_enabled: true
`);
write('stellar.toml',`VERSION="2.7.0"
NETWORK_PASSPHRASE="${runtime.networkPassphrase}"
SIGNING_KEY="${runtime.signingPublicKey}"
WEB_AUTH_ENDPOINT="${runtime.publicUrl}/auth"
KYC_SERVER="${runtime.publicUrl}/sep12"
DIRECT_PAYMENT_SERVER="${runtime.publicUrl}/sep31"
ANCHOR_QUOTE_SERVER="${runtime.publicUrl}/sep38"
[DOCUMENTATION]
ORG_NAME="Nostro Testnet Demonstration"
ORG_DESCRIPTION="Synthetic customers, Circle test USDC and PI-SPI virtual money only. No real bank deposits."
[[CURRENCIES]]
code="USDC"
issuer="${runtime.assetIssuer}"
is_asset_anchored=false
desc="Circle Testnet USDC. No monetary value."
`);
console.log('Local Testnet configuration prepared (secrets not displayed).');
