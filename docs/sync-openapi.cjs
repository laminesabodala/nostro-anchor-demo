'use strict';

const fs = require('node:fs');
const path = require('node:path');

const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/public-openapi.json'), 'utf8'));
if (process.env.ANCHOR_PUBLIC_URL) {
  const url = new URL(process.env.ANCHOR_PUBLIC_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ANCHOR_PUBLIC_URL must be an HTTPS origin with no credentials, path, query or fragment');
  }
  spec.servers = [{ url: url.origin, description: 'Operator-configured Stellar Testnet / PI-SPI sandbox gateway; no real funds' }];
}
fs.writeFileSync(path.join(__dirname, 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`);
console.log('Updated documentation OpenAPI from the public contract.');
