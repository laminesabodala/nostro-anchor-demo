"use strict";
const { PGlite } = require("@electric-sql/pglite");
async function createStore(directory) {
  const db = new PGlite(directory);
  await db.waitReady;
  await db.exec(`CREATE TABLE IF NOT EXISTS customers(id uuid PRIMARY KEY,account text NOT NULL,memo text NOT NULL,type text NOT NULL,first_name text NOT NULL,last_name text NOT NULL,alias text,UNIQUE(account,memo,type));
 CREATE TABLE IF NOT EXISTS quotes(id uuid PRIMARY KEY,account text NOT NULL,sell_amount text NOT NULL,buy_amount integer NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS payouts(id text PRIMARY KEY,quote_id uuid UNIQUE NOT NULL REFERENCES quotes(id),customer_id uuid NOT NULL REFERENCES customers(id),stellar_operation text UNIQUE NOT NULL,stellar_hash text NOT NULL,amount_xof integer NOT NULL,state text NOT NULL,intent jsonb NOT NULL,result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS funding_intents(transaction_id text PRIMARY KEY,destination text NOT NULL,memo text NOT NULL,memo_type text NOT NULL,asset text NOT NULL,amount text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS events(id text PRIMARY KEY,type text NOT NULL,received_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE funding_intents ALTER COLUMN amount DROP NOT NULL;
 ALTER TABLE customers ADD COLUMN IF NOT EXISTS destination jsonb;
 ALTER TABLE quotes ADD COLUMN IF NOT EXISTS delivery_method text;
 CREATE TABLE IF NOT EXISTS payment_requests(
   quote_id uuid PRIMARY KEY REFERENCES quotes(id),
   transaction_id text UNIQUE,
   request jsonb NOT NULL,
   destination jsonb NOT NULL,
   state text NOT NULL DEFAULT 'CREATING',
   created_at timestamptz NOT NULL DEFAULT now()
 );`);
  return db;
}
module.exports = { createStore };
