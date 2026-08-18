# Aegis subscription data model

This is a design doc, not an implementation — it's the contract for what Phase 2
(Cairo) and Phase 3 (billing trigger) build against. It's grounded in the actual
STRK20 pool contract and TS SDK (`starkware-libs/starknet-privacy`,
`PRIVACY-0.14.3-RC.2`), not just the starter kit's demo — see [Sources](#sources).

## Actors

| Actor | Role |
|---|---|
| **Payer / subscriber** | Shields STRK, authorizes a recurring payment to one merchant at a fixed amount and interval. |
| **Merchant / creator** | Publishes a subscription tier (amount + interval). Receives payment each cycle without learning who any given subscriber is. |
| **Aegis subscription contract** | A custom Cairo "anonymizer" contract (Phase 2) that the pool's `InvokeExternal` action calls into. Holds subscription state and, for prepaid subscriptions, holds the escrowed funds between cycles. |
| **Keeper / caller** | Whoever triggers a due billing cycle — a bot, the merchant, or the subscriber. See [Trigger mechanism](#billing-cycle-trigger-mechanism); this can be permissionless because the trigger carries no payer-identifying information. |

## How the pool actually works (the part that shapes everything below)

The pool contract (`packages/privacy`) processes a transaction as an ordered list
of `ClientAction`s, phase 0–7: `SetViewingKey → OpenChannel → OpenSubchannel →
Deposit → UseNote → CreateEncNote/CreateOpenNote → Withdraw → InvokeExternal`
(at most one `InvokeExternal` per transaction). Two facts fall out of this that
constrain the whole design:

1. **Every action in that list is inside one proof, submitted in one transaction
   signed by the payer.** There is no delegation primitive — no session key, no
   pre-authorized future debit — that lets a third party spend from a payer's
   shielded balance without the payer's own signature being in that same
   transaction. This is confirmed by the official `shadow_account_anonymizer`
   package: its `calls` are driven through `privacy_invoke_with_computation`,
   which only the pool contract can call, which only happens inside the payer's
   own `apply_actions` transaction. **A payer must be present (transacting) to
   move money out of their shielded balance — every time.**
2. **`InvokeExternal` calls a plain Starknet contract**, and the STRK20 SDK's own
   examples (Ekubo swap anonymizer, Vesu lending anonymizer) show the pattern:
   `withdraw({ recipient: ANONYMIZER, amount: X })` then `invoke(...)` then
   `transfer({ recipient: self, amount: Open })` to re-shield the result. The
   `amount` in that `withdraw` is plaintext calldata to a plain contract — the
   pool's zk layer does not extend into external contracts. Shielded-to-shielded
   `transfer` hides amount+sender+recipient; withdraw-to-a-contract hides *who*
   withdrew (anonymity set = every pool depositor) but not *how much*, in that
   one transaction.

Both facts directly determine the trigger mechanism and the privacy boundary
below — they're not implementation details, they're why the design looks the
way it does.

## Data model

Per subscription, the Aegis contract stores:

| Field | Type | Notes |
|---|---|---|
| `subscription_id` | `felt252` | An identity commitment, `hash(hash(payer_identity_key, "aegis"), nonce)` — same scheme as `shadow_account_anonymizer`'s `IdentityCommitment`. Derivable only by the payer; unrecoverable from on-chain data. This is the public handle everyone (merchant, keeper, block explorer) uses — never the payer's address. |
| `merchant` | `ContractAddress` | Public. Merchants are not trying to hide who they are — they're publishing a tier to attract subscribers. |
| `token` | `ContractAddress` | STRK for the hackathon; field is generic. |
| `tier_amount` | `u128` | Per-cycle payment. See [Privacy boundary](#privacy-boundary) for why this is a small set of merchant-published tiers, not an arbitrary payer-chosen number. |
| `interval_seconds` | `u64` | Billing cadence, set by the merchant's tier. |
| `cycles_total` | `u64` | 0 = open-ended (manual-renew model); >0 = prepaid for N cycles. |
| `cycles_executed` | `u64` | Incremented on each successful `execute_cycle`. |
| `next_due_at` | `u64` | Block timestamp; `execute_cycle` reverts before this. |
| `status` | `Active \| Cancelled \| Completed` | Public. |
| `escrow_balance` | `u128` | STRK currently held by the contract for this subscription, available for the next release. |

None of this maps a `subscription_id` back to a payer's L2 address anywhere in
contract state — that link exists only in the payer's own derivation of
`identity_key`, off-chain.

## Privacy boundary

| Stays private | Publicly visible |
|---|---|
| Payer's L2 address / wallet identity — never appears in Aegis contract state or events. The one place the payer's shielded balance is touched (the funding transaction) only reveals *that some pool depositor* withdrew to the Aegis contract, not *which one* (pool-wide anonymity set). | `subscription_id` (a commitment, not an identity), `merchant`, `tier_amount`, `interval_seconds`, `status`, `cycles_executed` — all contract storage, all public by construction. |
| Which specific subscriptions belong to the same payer (nonce-derived commitments are unlinkable to each other without the payer's `identity_key`). | The STRK amount moved in the funding transaction's `withdraw` calldata/event (plaintext — see point 2 above) and in each `execute_cycle` release. |
| The payer's total shielded balance / wealth. | Total active subscriptions, total revenue (both trivially computable by summing/counting contract storage — this *is* the "publicly verifiable aggregate" the RFP asks for). |

**The amount is not perfectly hidden, and that's a real constraint, not an
oversight.** Once STRK leaves the shielded pool into a plain contract (Aegis's),
the amount in that transaction is calldata/event data like any other Starknet
call — the pool doesn't have a "shielded amount into a plain contract" primitive.
Mitigation: **merchants publish a small number of fixed tiers** (e.g. 5 / 10 / 25
STRK per month) rather than accepting arbitrary payer-chosen amounts. This turns
"amount" from a uniquely identifying number into a k-anonymity set — an observer
sees "a 10 STRK/mo payment happened," indistinguishable from every other
subscriber on that tier, not "subscriber X paid $17.42." This is the same
denomination-standardization trick fixed-value mixers use, applied here because
it's what the underlying pool primitives actually support today. If the
underlying SDK grows a way to pass a shielded amount into `InvokeExternal`
calldata, this constraint goes away and tiers become optional — worth
rechecking against the SDK changelog before Phase 2 locks the contract interface.

The merchant's own receipt is re-shielded the same way the Ekubo/Vesu anonymizers
re-shield their output: `execute_cycle` deposits into an **open note** for the
merchant (`deposit_to_open_note`) rather than a plain ERC20 transfer, so the
merchant's running balance stays private too — only each individual cycle's
tier amount is momentarily visible in that release transaction, not their
cumulative revenue.

## Billing-cycle trigger mechanism

Given fact (1) above — a payer must sign to move money out of their shielded
balance, every time, with no delegation primitive available — a subscription
splits into two legs with very different trust/automation properties:

- **Funding leg** (payer-signed, privacy-pool transaction): `withdraw` STRK to
  the Aegis contract + `InvokeExternal` to open or top up a subscription. This
  is the only leg that ever touches the payer's shielded balance, so it's the
  only leg that *requires* the payer to be present.
- **Release leg** (permissionless, plain contract call): `execute_cycle(subscription_id)`
  moves already-escrowed STRK from the Aegis contract to the merchant (a plain
  ERC20 transfer in the current implementation — see "not yet implemented" in
  `contracts/subscription/README.md` for why it isn't an open-note deposit yet).
  It needs zero information about the payer — just the public `subscription_id`
  and enough elapsed time — so **anyone can call it safely**: a keeper bot, the
  merchant, or the subscriber. This leg genuinely is privacy-preserving to
  automate, because it was never carrying payer identity in the first place.

That split gives two shippable models, both using the same contract fields:

1. **MVP — subscriber-initiated renew** (`cycles_total = 0`, ship this first).
   The payer funds one cycle at a time: each interval, they submit a small
   privacy-pool transaction topping up `escrow_balance` by exactly
   `tier_amount`. The release leg (`execute_cycle`) can still run automated /
   permissionlessly the moment funds are present and due — only the funding
   step is manual. No capital lockup, no refund logic needed (nothing is ever
   prepaid), simplest to get right for Sepolia testing and the mainnet demo.
2. **Stretch — prepaid N-cycle subscription** (`cycles_total = N`). One funding
   transaction escrows `tier_amount * N` up front; every `execute_cycle` after
   that is 100% automated with *no* payer transaction for the life of the
   subscription. This is the fully-automated version the original brief asked
   for, and it is achievable without any privacy compromise — the trade-off
   isn't privacy, it's capital efficiency (N cycles locked up front) and the
   need for a cancel/refund path (return unspent escrow, gated by a secret only
   the payer holds, since the contract can't otherwise authenticate them without
   deanonymizing them).

Recommendation: build (1) for Phase 2/3 so the demo ships reliably, and treat (2)
as a stretch goal if time allows — this is exactly the "flag early, fall back to
subscriber-initiated renew" instruction, now with a concrete reason *why*
automation is hard (no delegation primitive in the pool, not a privacy leak) and
a concrete reason it's still worth attempting as a stretch (the release leg was
always safe to automate; only the funding leg was ever the blocker).

## Resolved during Phase 4: the funding entrypoint's name is not a choice

The frontend has to submit the funding leg through the wallet the starter kit
actually integrates (`WalletAccountV6` / Ready), not the raw `starknet-privacy`
SDK — that SDK's `invoke()` builder does support an arbitrary `entrypoint` (see
the Ekubo/Vesu anonymizer examples in its README), but it isn't published to npm
and needs a proving-service round trip this project has no access to. The
wallet-standard's `WALLET_API.STRK20_INVOKE_ACTION` (`@starknet-io/types-js`) has
no `entrypoint` field at all — it always calls a contract's `privacy_invoke`,
confirmed by `StrkInvokeHelper`'s own docstring
(`"Called by the privacy pool via selector!(\"privacy_invoke\")"`). So the Aegis
vault's funding entrypoint is named `privacy_invoke`, not `fund_subscription` as
first written — everything else about it (params, checks, escrow accounting) is
unchanged. See `contracts/subscription/README.md` for the corrected call shape.

## Open questions for Phase 2 / still open

- Whether to build the Aegis contract directly against `InvokeExternal` (like
  `StrkInvokeHelper` in the starter kit — what's implemented now) or on top of
  the generic, already-audited `ShadowAccountAnonymizer` package (per-subscription
  shadow accounts via `identity_commitment`) — the latter is more "integration
  depth" (30% of judging) but needs checking whether it's deployed on
  Sepolia/Mainnet or needs its own deployment.
- Exact cancellation / refund mechanics for the prepaid stretch variant.
- Fee handling: the pool takes a STRK fee per `apply_actions` call
  (`get_fee_amount`) — who pays it on the funding leg (subscriber, presumably)
  and does `execute_cycle` incur one (it's a plain call, not a pool
  `apply_actions`, so likely just normal gas).

## Sources

- `Akashneelesh/strk20-starter-kit` — `WalletAccountV6Tag.tsx`, `cairo/src/lib.cairo` (the `StrkInvokeHelper` echo pattern this doc generalizes).
- `starkware-libs/starknet-privacy` — `packages/privacy/README.md` (client action phases, events), `packages/shadow_account_anonymizer/src/shadow_account_anonymizer.cairo` (identity commitment scheme), `sdk/README.md` (Ekubo/Vesu anonymizer call patterns, withdraw/transfer semantics).
