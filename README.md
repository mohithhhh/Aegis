# Aegis

Private, recurring subscription payments on Starknet. A subscriber shields
funds and pays a merchant on a schedule through the STRK20 privacy pool —
payer identity stays private, per-cycle amount is k-anonymous within a
published tier, and aggregate metrics (total active subscriptions, total
revenue) stay publicly verifiable. No exposed subscriber lists, no visible
payment history — just proof that the numbers add up.

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/build)
(`starkience/strk20-hackathon`, RFP-12).

## Status

Built and tested against a local `starknet-devnet`. **Not yet deployed to a
real network** (Sepolia or Mainnet) — that's the current blocker, waiting on
faucet-funding a Sepolia deployer account.

| Phase | State |
|---|---|
| 1 — Foundation (starter kit, shield/unshield/transfer) | Scaffolded and builds clean; live wallet click-through not yet run |
| 2 — Core contract (`contracts/subscription`) | Written, 13 unit tests pass, rehearsed twice end-to-end on devnet (declare → deploy → fund → execute → cancel) |
| 3 — Execution layer (`keeper/`) | Written, rehearsed on devnet incl. a third unrelated account calling it (proving it's permissionless) |
| 4 — Frontend (Subscribe / My Subscriptions / Creator / Stats) | Built, typechecks, builds; read path verified live against devnet |
| 5 — Mainnet execution | Not started — gated on Sepolia deployment first |
| 6 — Docs, demo, submission | In progress (this README); demo video and `strk20.json` not yet filled in |

See [`docs/subscription-model.md`](docs/subscription-model.md) for the full
design and the privacy reasoning behind every choice below.

## How it works

- **Shield / unshield / private transfer / balances** — vendored from the
  [STRK20 starter kit](https://github.com/Akashneelesh/strk20-starter-kit)
  (`src/app/components/client/WalletHandle/`), talking to the privacy pool via
  `WalletAccountV6` (starknet.js v10). See [`ATTRIBUTION.md`](ATTRIBUTION.md).
- **The subscription mechanism** (the actual differentiator) is custom: a
  Cairo vault contract (`contracts/subscription`) split into two legs with
  very different trust requirements:
  - **Funding leg** — the payer's own privacy-pool transaction: `withdraw`
    STRK to the vault, then `invoke` it in the same transaction. Only the
    pool can call this entrypoint (named `privacy_invoke` — not a choice, see
    [`contracts/subscription/README.md`](contracts/subscription/README.md)).
    This is the only leg that ever touches a payer's shielded balance.
  - **Release leg** (`execute_cycle`) — a plain, permissionless call that
    pays the merchant out of already-escrowed funds once a cycle is due. It
    carries no payer-identifying information, so anyone can call it safely —
    a keeper bot (`keeper/execute-cycles.ts`), the merchant, or the
    subscriber.
- **Tiers, not arbitrary amounts.** Merchants publish one of a few fixed
  amounts. Every subscriber on a tier is indistinguishable from every other —
  amount k-anonymity, not just identity privacy.
- **Public aggregates come straight from contract storage** —
  `total_active_subscriptions()` and `total_revenue()` — no per-subscriber
  breakdown exists anywhere, on-chain or off.

## Quick start

```bash
npm install
cp .env.example .env.local     # add your Alchemy key (free at alchemy.com)
npm run dev                    # http://localhost:3000
```

Needs a privacy-enabled Starknet wallet — [Ready](https://www.ready.co/) is
the one that currently supports the STRK20 pool actions — on Sepolia or
Mainnet. The Subscriptions panel stays disabled with an explanatory banner
until `NEXT_PUBLIC_SUBSCRIPTION_VAULT_SEPOLIA` / `_MAINNET` point at a real
deployment (see `.env.example`).

## Repo layout

```
src/                    Next.js app - wallet connect, shield/unshield/transfer,
                         and the Subscriptions panel (Subscribe / My
                         Subscriptions / Creator / Stats)
contracts/echo-helper/   Starter kit's demo anonymizer (privacy_invoke round-trip)
contracts/subscription/  The Aegis subscription vault - the differentiator
keeper/                  Permissionless execute_cycle trigger, run on a schedule
docs/                    Design docs (start with subscription-model.md)
```

## Contracts

```bash
cd contracts/subscription
scarb build
snforge test
```

Toolchain: [starkup](https://github.com/software-mansion/starkup) installs a
matching `scarb`/`snforge`/`sncast` (this repo pins `scarb 2.18.0` via
`.tool-versions`, same as `contracts/echo-helper`).

## Keeper

```bash
RPC_URL=... VAULT_ADDRESS=0x... npm run keeper                # dry run
RPC_URL=... VAULT_ADDRESS=0x... KEEPER_ADDRESS=0x... KEEPER_PRIVATE_KEY=0x... npm run keeper   # live
```

One sweep: discovers every subscription ever funded, executes the ones due,
exits. Meant to run on a schedule (cron/CI), not as a daemon. Details in
[`keeper/README.md`](keeper/README.md).

## License

MIT — see [`LICENSE`](LICENSE). Vendored starter-kit code is also MIT; see
[`ATTRIBUTION.md`](ATTRIBUTION.md).
