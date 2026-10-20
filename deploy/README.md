# OVH sandbox deployment

Status: deployed on 2026-10-20 to OVH, Ubuntu 24.04, Gravelines.

- Public API: `https://sandbox-api.nostro.finance`
- VPS: `vps-12d00b77.vps.ovh.net` / `217.182.66.131`
- Install directory: `/opt/nostro-anchor-demo`
- SSH user: `ubuntu`; dedicated key in the ignored local `.local-ovh-ssh` directory.
- SSH is restricted to the current operator IP (`88.86.232.107`). If it changes,
  update the firewall through OVH KVM before attempting remote access.
- Only ports 80/443 are publicly exposed. Databases, callback API and Platform API
  remain private. The original mobile backend is not part of this deployment.
- GoDaddy has the `sandbox-api` A record. Website and email records are unchanged.

## Packaging

The override uses the existing pinned Anchor Platform, PostgreSQL and Kafka
images. Business callbacks and the Platform API are private Docker services;
only Caddy publishes ports 80/443. Caddy obtains/renews HTTPS certificates.
The mobile backend is not included. Node's build context explicitly excludes
local state, credentials and unrelated files.

Prepare credentials into a NEW ignored directory, preserving the existing
Testnet wallets and signing identity:

```sh
node deploy/prepare-runtime.cjs \
  .local-platform ../../backend/.local-integrations/providers.json \
  .local-ovh-runtime https://sandbox-api.nostro.finance
```

Only PI-SPI sandbox credentials are copied, not Twilio, Didit or bank production
settings. The bank wallet's private key is not needed on the VPS.
Transfer the private directory over SSH and install it as `.local-platform`
on the server, owned by UID/GID 1000 with directory mode 0700 and file mode 0600.
The business `.local` directory must also be owned by UID/GID 1000.
Node and Caddy are pinned to the image digests used for this release.

```sh
export DEMO_DOMAIN=sandbox-api.nostro.finance
docker compose -f platform/compose.yaml -f deploy/compose.ovh.yaml config --quiet
docker compose -f platform/compose.yaml -f deploy/compose.ovh.yaml build business
```

## Cutover (perform only once the VPS is reachable)

1. Install SSH key access, security updates, Docker and firewall rules.
   Permit SSH from the operator's address and public TCP 80/443 only.
   Enable Docker at boot. Confirm a second SSH connection before changing SSH.
2. Verify that the demo has no unresolved funded payouts. Stop public funding
   first and let processing settle. Shut down the local business process
   gracefully, then stop the demo's platform, observer and Kafka.
3. Export Anchor PostgreSQL with `pg_dump -Fc`. Copy the closed
   `.local/business-db.nosync` directory and archive the stopped Kafka volume.
   Store a private checksum manifest and keep the original local state.
   Never copy live database pages, reset wallets or recreate payment identities.
4. Transfer only demo code, private runtime, database dump, Kafka archive and
   business state using SSH. Restore PostgreSQL and Kafka into the remote
   demo volumes before starting the remote processors. Keep local processors
   stopped: never run both copies against the same funded payment records.
5. Add GoDaddy A record `sandbox-api` pointing to the VPS IPv4 address.
   Check for a conflicting AAAA record. Start the full Compose stack.
6. Verify HTTPS, SEP-1, SEP-10, private-route denial, persisted historical
   payments, and a complete new sandbox payment. Restart the containers and
   confirm the records survive with no duplicate payout.
7. Update all three OpenAPI copies and the Mintlify guide to the permanent
   URL; publish. Run the full flow from the public Mintlify playground.
   Stop ngrok and recheck Mintlify to prove it no longer depends on the Mac.

## Operations

Use the same two Compose files for every server operation. All long-running
services restart automatically; container logs are bounded. The business
container holds an OS lock on its state volume and can recover its old PID
file after a forced stop. Do not start a host Node process against that volume.

`nostro-anchor-backup.timer` runs `deploy/backup.sh` daily at 04:15 UTC.
It briefly stops the demo, saves both databases, Kafka and private configuration,
encrypts them with age to the dedicated SSH public key, then restarts services.
Backups live in `/opt/nostro-anchor-backups`. This deliberately introduces a short
daily maintenance interruption. OVH's standard backup is also enabled.

The 2026-10-20 backup was copied off-server into the ignored local
`.local-ovh-transfer` directory, decrypted, checksum-verified and restored into
isolated local databases: 11 completed payouts, 9 funding records, and 2 unfunded
pending Anchor transactions. The temporary restored instances were removed.
Automatic off-server backup copying and external availability alerts are not
configured. Check backup job results and copy recent encrypted archives off-server
regularly. Preserve the dedicated private SSH key separately: it is also the
backup decryption key. No backup retention pruning is configured yet.

Recovery: decrypt an archive with `age -d -i <private-key>`, unpack it privately,
restore `anchor.dump` into a fresh PostgreSQL database, unpack the closed business
database and Kafka archives into their respective directories/volume, and restore
runtime configuration with the ownership/modes documented above. Keep all payment
processors stopped until reconciliation is complete. Do not test restoration over
the running deployment.

Retain the previous application image for code rollback. Never restore an old
payment database and resume payouts without reconciliation against Stellar
and PI-SPI, because external payments do not roll back.

Check HTTPS availability, free disk space, container health and the Testnet
USDC/PI-SPI balances. The existing demo payment caps still apply; do not reset
the funding history to replenish the demo. Testnet resets and provider sandbox
outages can interrupt the demonstration independently of this server.

This single server is a demo deployment, not a high-availability production
system. Full Mintlify bank (700 XOF) and mobile-wallet (300 XOF) flows completed
on 2026-10-20, including Stellar Testnet funding and PI-SPI irrevocable payouts.
A full VPS reboot was tested with the existing records preserved.
