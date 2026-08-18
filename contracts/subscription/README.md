# Aegis subscription vault

The differentiator contract — see [`docs/subscription-model.md`](../../docs/subscription-model.md)
for the full design and privacy reasoning. This directory is standalone (own `Scarb.toml`), same
layout as [`contracts/echo-helper`](../echo-helper).

## Build & test

```bash
scarb build
scarb test   # once tests are added
```

## Entrypoints

| Function | Called by | Touches the privacy pool? |
|---|---|---|
| `privacy_invoke` | The STRK20 pool's `InvokeExternal`, in the same transaction as a `withdraw` to this contract. Opens or tops up a subscription. | Yes — this is the payer-signed funding leg. |
| `execute_cycle` | Anyone — keeper, merchant, or subscriber. Pays out one due cycle from escrow. | No — plain permissionless call, carries no payer-identifying data. |
| `cancel_subscription` | Anyone holding the `secret` behind a subscription's `cancel_commitment`. Refunds unused escrow. | No. |
| `get_subscription` / `is_due` / `total_active_subscriptions` / `total_revenue` | Anyone (views). | No. |

## Calling `privacy_invoke` from the wallet

Same `withdraw` → `invoke` shape as the starter kit's echo helper
(`WalletAccountV6Tag.tsx`). The entrypoint **must** be named `privacy_invoke` —
`WALLET_API.STRK20_INVOKE_ACTION` (`@starknet-io/types-js`) has no `entrypoint`
field, so the wallet always calls that exact name on whatever `contract` you
target. Our calldata (everything after `self`) is entirely our own:

```ts
const actions: WALLET_API.STRK20_ACTION[] = [
  { type: "withdraw", token: TOKEN, amount: num.toHex(amount), recipient: vaultAddress },
  {
    type: "invoke",
    contract: vaultAddress, // entrypoint is implicit - always privacy_invoke
    calldata: [
      "${poolAddress}",           // substituted by the wallet — do not hex-normalize
      num.toHex(TOKEN),
      subscriptionId,             // felt252 identity commitment, derived off-chain
      num.toHex(merchantAddress),
      num.toHex(tierAmount),
      num.toHex(intervalSeconds),
      num.toHex(cyclesAdded),
      num.toHex(amount),
      cancelCommitment,           // 0 to skip the cancel/refund option
    ],
  },
];
```

The real, lower-level `@starkware-libs/starknet-privacy-sdk` TS package *does*
support an arbitrary `entrypoint` in its `invoke()` builder (see the Ekubo/Vesu
anonymizer examples in its README) — but it isn't published to npm and needs a
proving-service round trip this project doesn't have access to, so it wasn't a
realistic option here. The wallet-standard's fixed-name constraint is the actual
governing interface for this hackathon build.

## Not yet implemented (tracked for later phases)

- **Merchant re-shielding.** `execute_cycle` pays the merchant with a plain ERC20 `transfer`, so
  each cycle's payout is momentarily public (tier amount + merchant address), same as any other
  external-contract leg — see the privacy boundary table in the design doc. Re-shielding into the
  merchant's own open note (like the Ekubo/Vesu anonymizers do) needs the merchant to have a note
  ready to fill each cycle, which needs its own UX; deferred past the hackathon MVP.
- **Tests.** No `snforge` tests yet — next step once the toolchain install finishes.
- **Deployment.** Not declared or deployed anywhere yet. Sepolia first, per the phase plan.
