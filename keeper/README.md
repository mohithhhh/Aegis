# Aegis keeper

The release-leg trigger for `contracts/subscription`'s billing cycles — see
[`docs/subscription-model.md`](../docs/subscription-model.md) for why this leg (and
only this leg) is safe to automate.

`execute-cycles.ts` does one sweep: discover every subscription the vault has ever
seen, check which are due, pay out the due ones, and exit. It's meant to be run on
a schedule (cron, GitHub Actions, a serverless function on a timer) — it is not a
long-running daemon itself.

## Run it

```bash
# Dry run - reports what it would do, signs and sends nothing
RPC_URL=https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/<key> \
VAULT_ADDRESS=0x... \
npm run keeper

# Live - actually pays out due cycles
RPC_URL=https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/<key> \
VAULT_ADDRESS=0x... \
KEEPER_ADDRESS=0x... \
KEEPER_PRIVATE_KEY=0x... \
npm run keeper
```

`KEEPER_ADDRESS` / `KEEPER_PRIVATE_KEY` just need to be *some* funded Starknet
account able to pay gas — `execute_cycle` doesn't check who calls it. There is
nothing sensitive about this key beyond normal wallet hygiene: it never touches
subscriber funds, never signs anything privacy-pool-related, and losing it costs
at most its own gas balance.

## Verified against

Rehearsed against a local `starknet-devnet` instance (declare → deploy → fund two
subscriptions → dry-run discovery → live `execute_cycle` → time-travel via
`devnet_increaseTime` → second cycle → completion), not just unit tests. Not yet
run against a real deployed Sepolia/Mainnet address — that's the next step once
the contract is actually declared there.

## Design notes

- **Discovery has no other way to work.** A Cairo `Map` isn't enumerable from
  outside the contract, so the only way to find every `subscription_id` that's
  ever existed is to scan `SubscriptionFunded` events from genesis. This is fine
  at hackathon scale; a production keeper would want an indexer (or the discovery
  service the STRK20 pool itself ships) instead of `getEvents` over the whole
  chain on every sweep.
- **One subscription failing doesn't stop the sweep.** If `execute_cycle` reverts
  for one id (e.g. a race with another keeper that already executed it), the
  script logs it and moves on to the rest.
- **No coordination between multiple keepers is needed or attempted.** Two
  keepers racing on the same due subscription just means one call succeeds and
  the other reverts (harmlessly) - that's why anyone can run this safely, which
  is the entire premise of the release leg being permissionless.
