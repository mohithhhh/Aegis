// Aegis subscription vault - frontend wiring for contracts/subscription. See
// docs/subscription-model.md for the design this implements.
"use client";

import { hash, num } from "starknet";
import * as constants from "@/utils/constants";
import vaultAbiJson from "@/utils/abi/AegisSubscriptionVault.abi.json";
import type { Abi } from "starknet";

export const vaultAbi = vaultAbiJson as unknown as Abi;

// DEMO VALUES: not deployed yet. Set NEXT_PUBLIC_SUBSCRIPTION_VAULT_SEPOLIA /
// _MAINNET once contracts/subscription is declared+deployed for real (see
// contracts/subscription/README.md). "0x0" = not deployed - the Subscriptions UI
// stays disabled with an explanatory banner, same pattern as the echo helper.
export const SubscriptionVaultSepolia = process.env.NEXT_PUBLIC_SUBSCRIPTION_VAULT_SEPOLIA ?? "0x0";
export const SubscriptionVaultMainnet = process.env.NEXT_PUBLIC_SUBSCRIPTION_VAULT_MAINNET ?? "0x0";

// Mirrors constants.echoHelperForIndex: 0 = Mainnet, 2 = Sepolia frontend provider index.
export function vaultAddressForIndex(index: number): string {
  if (index === 0) return SubscriptionVaultMainnet;
  if (index === 2) return SubscriptionVaultSepolia;
  return "0x0";
}

export function hasVault(index: number): boolean {
  try {
    return num.toBigInt(vaultAddressForIndex(index)) !== 0n;
  } catch {
    return false;
  }
}

// Fixed subscription tiers, in STRK smallest unit (1e18 = 1 STRK). Merchants pick
// one of these rather than an arbitrary amount - see the privacy boundary section
// of docs/subscription-model.md: a small, public, shared set of tiers gives every
// subscriber on the same tier k-anonymity for their payment amount, which an
// arbitrary payer-chosen number would not.
export const TIERS = [
  { label: "5 STRK / month", amount: 5n * 10n ** 18n },
  { label: "10 STRK / month", amount: 10n * 10n ** 18n },
  { label: "25 STRK / month", amount: 25n * 10n ** 18n },
] as const;

// Fixed interval, in seconds. One option for the MVP demo; a real deployment
// would offer a few (weekly/monthly/yearly), same reasoning as the tiers above.
export const INTERVAL_SECONDS = 30n * 24n * 60n * 60n; // 30 days

// A locally-created subscription this browser knows the secret for. `secret` is
// what makes `cancel_subscription` callable - anyone can read `subscriptionId`
// on-chain, but only whoever holds `secret` can cancel and refund it. Losing this
// (e.g. clearing site data) means losing the ability to self-serve-cancel; there
// is no recovery path in the MVP contract, by design (recovering it any other way
// would mean the contract could identify the payer).
export interface LocalSubscription {
  subscriptionId: string; // felt252, hex
  secret: string; // felt252, hex - never sent anywhere except as cancel_subscription calldata
  merchant: string;
  tierAmount: string; // decimal string (bigint doesn't survive JSON.stringify)
  intervalSeconds: string;
  token: string;
  createdAt: number;
  label?: string;
}

const SUBSCRIPTIONS_KEY = "aegis:subscriptions";
const TIERS_KEY = "aegis:creator-tiers";

export function loadLocalSubscriptions(): LocalSubscription[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(SUBSCRIPTIONS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveLocalSubscription(sub: LocalSubscription) {
  if (typeof window === "undefined") return;
  const all = loadLocalSubscriptions();
  all.push(sub);
  window.localStorage.setItem(SUBSCRIPTIONS_KEY, JSON.stringify(all));
}

export function removeLocalSubscription(subscriptionId: string) {
  if (typeof window === "undefined") return;
  const all = loadLocalSubscriptions().filter((s) => s.subscriptionId !== subscriptionId);
  window.localStorage.setItem(SUBSCRIPTIONS_KEY, JSON.stringify(all));
}

// A tier a creator has published from this browser - purely a local convenience
// for generating shareable subscribe links; the contract has no tier registry
// (see contracts/subscription/README.md - "not yet implemented").
export interface LocalTier {
  merchant: string;
  tierAmount: string;
  intervalSeconds: string;
  label: string;
  createdAt: number;
}

export function loadLocalTiers(): LocalTier[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(TIERS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveLocalTier(tier: LocalTier) {
  if (typeof window === "undefined") return;
  const all = loadLocalTiers();
  all.push(tier);
  window.localStorage.setItem(TIERS_KEY, JSON.stringify(all));
}

// Cryptographically random felt252 (252 bits fits in 31 bytes; use 31 to stay
// safely under the field's modulus without needing a reduction).
function randomFelt(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}

export function randomSubscriptionId(): bigint {
  return randomFelt();
}

export function randomSecret(): bigint {
  return randomFelt();
}

// Matches the contract's `PoseidonTrait::new().update(secret).finalize()`.
export function cancelCommitmentFor(secret: bigint): string {
  return num.toHex(hash.computePoseidonHashOnElements([secret]));
}
