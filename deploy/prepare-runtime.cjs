"use strict";
// Build a SEPARATE private runtime directory; never change the running Mac demo.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
function prepare({ source, providers, target, publicUrl }) {
  const url = new URL(publicUrl);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.port || url.search || url.hash || url.pathname !== "/" ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname))
    throw Error("Use an HTTPS hostname without a path, port or credentials");
  const runtime = JSON.parse(fs.readFileSync(path.join(source, "runtime.json")));
  if (runtime.networkPassphrase !== "Test SDF Network ; September 2015")
    throw Error("Only the Stellar Testnet demo can be deployed");
  const pispi = JSON.parse(fs.readFileSync(providers)).pispi;
  if (!pispi || !["clientId", "clientSecret", "apiKey"].every(k => typeof pispi[k] === "string" && pispi[k]))
    throw Error("Missing PI-SPI sandbox credentials");
  // Fail rather than overwriting an earlier runtime or live directory.
  fs.mkdirSync(target, { mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(path.join(target, name),
    JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  runtime.publicUrl = url.origin;
  runtime.sepUrl = "http://platform:8080";
  runtime.platformUrl = "http://platform:8085";
  write("runtime.json", runtime);
  write("sender.json", JSON.parse(fs.readFileSync(path.join(source, "sender.json"))));
  // Transfer only this provider's required credentials, not the onboarding config.
  write("pispi.json", { pispi: Object.fromEntries(
    ["clientId", "clientSecret", "apiKey", "baseUrl", "tokenUrl"]
      .filter(k => pispi[k] !== undefined).map(k => [k, pispi[k]])) });
  execFileSync(process.execPath, [path.resolve(__dirname, "../platform/prepare.cjs")], {
    env: { ...process.env, ANCHOR_RUNTIME_DIR: path.resolve(target) },
    stdio: "pipe",
  });
}
if (require.main === module) {
  const [source, providers, target, publicUrl] = process.argv.slice(2);
  if (![source, providers, target, publicUrl].every(Boolean)) {
    console.error("Usage: node deploy/prepare-runtime.cjs SOURCE_RUNTIME PROVIDERS_JSON NEW_TARGET HTTPS_URL");
    process.exitCode = 1;
  } else {
    try { prepare({ source, providers, target, publicUrl }); console.log("Private OVH runtime prepared; no secrets displayed."); }
    catch { console.error("OVH runtime preparation failed; check paths, Testnet configuration and destination permissions."); process.exitCode = 1; }
  }
}
module.exports = { prepare };
