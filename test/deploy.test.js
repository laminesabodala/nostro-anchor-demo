"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { prepare } = require("../deploy/prepare-runtime.cjs");
test("OVH preparation preserves local runtime and exports only demo provider secrets", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nostro-ovh-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source);
  const runtime = { networkPassphrase: "Test SDF Network ; September 2015",
    publicUrl: "https://old.example", platformUrl: "http://127.0.0.1:8089",
    signingPublicKey: "test-signer", signingSeed: "test-seed",
    senderPublicKey: "test-sender", bankPublicKey: "test-bank",
    databasePassword: "test-db", callbackApiKey: "test-callback",
    platformApiKey: "test-platform", jwtSecret: "test-jwt",
    assetIssuer: "test-issuer" };
  const original = JSON.stringify(runtime);
  fs.writeFileSync(path.join(source, "runtime.json"), original);
  fs.writeFileSync(path.join(source, "sender.json"), '{"secret":"test-only"}');
  const providers = path.join(root, "providers.json");
  fs.writeFileSync(providers, JSON.stringify({ pispi: { clientId: "test", clientSecret: "test", apiKey: "test",
    unrelated: "exclude" }, twilio: { secret: "exclude" } }));
  prepare({ source, providers, target, publicUrl: "https://sandbox-api.example.com" });
  assert.equal(fs.readFileSync(path.join(source, "runtime.json"), "utf8"), original);
  const result = JSON.parse(fs.readFileSync(path.join(target, "runtime.json")));
  assert.equal(result.platformUrl, "http://platform:8085");
  assert.equal(result.sepUrl, "http://platform:8080");
  assert.equal(result.signingSeed, runtime.signingSeed);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, "pispi.json"))),
    { pispi: { clientId: "test", clientSecret: "test", apiKey: "test" } });
  assert.match(fs.readFileSync(path.join(target, "stellar.toml"), "utf8"),
    /WEB_AUTH_ENDPOINT="https:\/\/sandbox-api.example.com\/auth"/);
  assert.equal(fs.statSync(path.join(target, "runtime.json")).mode & 0o777, 0o600);
  assert.throws(() => prepare({ source, providers, target, publicUrl: "https://sandbox-api.example.com" }));
  assert.throws(() => prepare({ source, providers, target: path.join(root, "bad"), publicUrl: "http://bad.example" }));
});
