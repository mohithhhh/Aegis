#!/usr/bin/env tsx
/**
 * Aegis keeper — the release leg's trigger.
 *
 * This is the "anyone can call it" side of the billing cycle (see
 * docs/subscription-model.md). It never touches the STRK20 privacy pool and never
 * sees a payer's identity: it just discovers every `subscription_id` the vault has
 * ever seen (from `SubscriptionFunded` events), checks `is_due(subscription_id)`,
 * and calls `execute_cycle` on the ones that are. Anyone can run this against any
 * RPC with any funded account - there's nothing privileged about it, which is the
 * whole point.
 *
 * Usage:
 *   RPC_URL=...        Starknet RPC endpoint (required)
 *   VAULT_ADDRESS=...  Deployed AegisSubscriptionVault address (required)
 *   KEEPER_ADDRESS=...     Account paying gas for execute_cycle calls (optional)
 *   KEEPER_PRIVATE_KEY=... Its private key (optional)
 *
 * Without KEEPER_ADDRESS / KEEPER_PRIVATE_KEY, this runs in dry-run mode: it
 * reports what it *would* execute without signing or sending anything. That's the
 * safe default - set both explicitly to actually pay out cycles.
 *
 *   npm run keeper                  # dry run
 *   KEEPER_ADDRESS=0x.. KEEPER_PRIVATE_KEY=0x.. npm run keeper   # live
 *
 * Run this on a schedule (cron, GitHub Actions, etc.) - it does one sweep and
 * exits; it is not a long-running daemon.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Account,
  Contract,
  RpcProvider,
  hash,
  num,
  type Abi,
} from "starknet";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.RPC_URL;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const KEEPER_ADDRESS = process.env.KEEPER_ADDRESS;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

if (!RPC_URL || !VAULT_ADDRESS) {
  console.error("RPC_URL and VAULT_ADDRESS are required. See keeper/README.md.");
  process.exit(1);
}

const abi: Abi = JSON.parse(
  readFileSync(path.join(__dirname, "abi/AegisSubscriptionVault.abi.json"), "utf8"),
);

const provider = new RpcProvider({ nodeUrl: RPC_URL });

// Discover every subscription_id the vault has ever funded, by scanning
// SubscriptionFunded events. `#[key] subscription_id` is keys[1] (keys[0] is the
// event selector). Paginated via continuation_token - there is no other way to
// enumerate a Cairo Map's keys from outside the contract.
async function discoverSubscriptionIds(): Promise<string[]> {
  const selector = num.toHex(hash.getSelectorFromName("SubscriptionFunded"));
  const ids = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const page: any = await provider.getEvents({
      address: VAULT_ADDRESS!,
      keys: [[selector]],
      chunk_size: 100,
      from_block: { block_number: 0 },
      to_block: "latest",
      continuation_token: continuationToken,
    });
    for (const ev of page.events ?? []) {
      const subscriptionId = ev.keys?.[1];
      if (subscriptionId) ids.add(num.toHex(subscriptionId));
    }
    continuationToken = page.continuation_token;
  } while (continuationToken);
  return [...ids];
}

async function main() {
  const readVault = new Contract({ abi, address: VAULT_ADDRESS!, providerOrAccount: provider });

  const ids = await discoverSubscriptionIds();
  console.log(`Discovered ${ids.length} subscription(s) ever funded.`);

  const due: string[] = [];
  for (const id of ids) {
    const isDue: boolean = await readVault.is_due(id);
    if (isDue) due.push(id);
  }
  console.log(`${due.length} subscription(s) due right now: ${due.join(", ") || "(none)"}`);

  if (due.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const canSign = KEEPER_ADDRESS && KEEPER_PRIVATE_KEY;
  if (!canSign) {
    console.log(
      "DRY RUN (no KEEPER_ADDRESS/KEEPER_PRIVATE_KEY set) - would call execute_cycle on:",
    );
    for (const id of due) console.log(`  - ${id}`);
    return;
  }

  const account = new Account({ provider, address: KEEPER_ADDRESS!, signer: KEEPER_PRIVATE_KEY! });
  const writeVault = new Contract({ abi, address: VAULT_ADDRESS!, providerOrAccount: account });

  for (const id of due) {
    try {
      const { transaction_hash } = await writeVault.execute_cycle(id);
      console.log(`execute_cycle(${id}) -> ${transaction_hash}, waiting for confirmation...`);
      await provider.waitForTransaction(transaction_hash);
      const sub: any = await readVault.get_subscription(id);
      const status =
        typeof sub.status?.activeVariant === "function" ? sub.status.activeVariant() : sub.status;
      console.log(`  confirmed - cycles_executed=${sub.cycles_executed} status=${status}`);
    } catch (error: any) {
      // One subscription failing (e.g. a race with another keeper) shouldn't stop
      // the sweep from trying the rest.
      console.error(`  execute_cycle(${id}) failed:`, error?.message ?? error);
    }
  }

  const totalActive: bigint = await readVault.total_active_subscriptions();
  const totalRevenue: bigint = await readVault.total_revenue();
  console.log(`Sweep done. total_active_subscriptions=${totalActive} total_revenue=${totalRevenue}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
