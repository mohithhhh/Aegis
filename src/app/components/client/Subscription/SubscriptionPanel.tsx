"use client";

import { useEffect, useState } from "react";
import { Contract, num } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";
import styles from "../../../uni.module.css";
import * as constants from "@/utils/constants";
import { useStoreWallet } from "../../Wallet/walletContext";
import { useFrontendProvider } from "../provider/providerContext";
import {
  vaultAbi,
  vaultAddressForIndex,
  hasVault,
  TIERS,
  INTERVAL_SECONDS,
  type LocalSubscription,
  loadLocalSubscriptions,
  saveLocalSubscription,
  removeLocalSubscription,
  type LocalTier,
  loadLocalTiers,
  saveLocalTier,
  randomSubscriptionId,
  randomSecret,
  cancelCommitmentFor,
} from "@/utils/subscriptionVault";

const TOKEN = constants.addrSTRK;

function fmtStrk(amount: bigint): string {
  const whole = amount / 10n ** 18n;
  const frac = (amount % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
function shortHex(h: string): string {
  const hex = num.toHex(h);
  return hex.length <= 13 ? hex : `${hex.slice(0, 7)}...${hex.slice(-4)}`;
}

type ResultRow = { label: string; value: string; hash?: string };
type ActionResult = { status: "pending" | "ok" | "error"; title: string; rows?: ResultRow[]; note?: string };

type TabKey = "subscribe" | "mine" | "creator" | "stats";
const TABS: { key: TabKey; label: string }[] = [
  { key: "subscribe", label: "Subscribe" },
  { key: "mine", label: "My Subscriptions" },
  { key: "creator", label: "Creator" },
  { key: "stats", label: "Stats" },
];

export default function SubscriptionPanel() {
  const myFrontendProviderIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const myWalletAccount = useStoreWallet((s) => s.myWalletAccount);
  const connectedAddress = useStoreWallet((s) => s.address);
  const isConnected = useStoreWallet((s) => s.isConnected);

  const networkName = constants.Strk20Networks[myFrontendProviderIndex];
  const isStrk20Network = networkName !== undefined;
  const vaultAddress = vaultAddressForIndex(myFrontendProviderIndex);
  const vaultDeployed = hasVault(myFrontendProviderIndex);
  const provider = constants.myFrontendProviders[myFrontendProviderIndex];

  const [tab, setTab] = useState<TabKey>("subscribe");

  // --- Subscribe tab -------------------------------------------------------
  const [merchantInput, setMerchantInput] = useState("");
  const [tierIndex, setTierIndex] = useState(0);
  const [subscribeResult, setSubscribeResult] = useState<ActionResult | null>(null);
  const [subscribing, setSubscribing] = useState(false);

  // Prefill from a creator's shared link: ?merchant=0x..&amount=<wei>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const merchant = params.get("merchant");
    const amount = params.get("amount");
    if (merchant) {
      setMerchantInput(merchant);
      setTab("subscribe");
    }
    if (amount) {
      const idx = TIERS.findIndex((t) => t.amount.toString() === amount);
      if (idx >= 0) setTierIndex(idx);
    }
  }, []);

  async function handleSubscribe() {
    setSubscribeResult(null);
    if (!myWalletAccount || !connectedAddress) {
      setSubscribeResult({ status: "error", title: "Connect a wallet first." });
      return;
    }
    let merchant: string;
    try {
      merchant = num.toHex(merchantInput.trim());
    } catch {
      setSubscribeResult({ status: "error", title: "Enter a valid merchant address." });
      return;
    }
    const tier = TIERS[tierIndex];
    const subscriptionId = randomSubscriptionId();
    const secret = randomSecret();
    const cancelCommitment = cancelCommitmentFor(secret);

    // Funding leg: withdraw the tier amount to the vault, then invoke it. The wallet always
    // calls the target contract's `privacy_invoke` entrypoint - see
    // contracts/subscription/README.md for why the name is fixed and this shape is required.
    const actions: WALLET_API.STRK20_ACTION[] = [
      { type: "withdraw", token: TOKEN, amount: num.toHex(tier.amount), recipient: vaultAddress },
      {
        type: "invoke",
        contract: vaultAddress,
        calldata: [
          "${poolAddress}",
          num.toHex(TOKEN),
          num.toHex(subscriptionId),
          merchant,
          num.toHex(tier.amount),
          num.toHex(INTERVAL_SECONDS),
          num.toHex(1n), // cycles_added - one cycle per subscribe/renew (MVP manual-renew model)
          num.toHex(tier.amount), // amount claimed from the withdraw above
          cancelCommitment,
        ],
      },
    ];

    setSubscribing(true);
    try {
      const r = await myWalletAccount.strk20InvokeTransaction(actions);
      const txH = r.transaction_hash;
      setSubscribeResult({
        status: "pending",
        title: "Waiting for confirmation…",
        rows: [{ label: "Transaction", value: shortHex(txH), hash: txH }],
      });
      await provider.waitForTransaction(txH, { retries: 400, retryInterval: 3000 });
      const local: LocalSubscription = {
        subscriptionId: num.toHex(subscriptionId),
        secret: num.toHex(secret),
        merchant,
        tierAmount: tier.amount.toString(),
        intervalSeconds: INTERVAL_SECONDS.toString(),
        token: TOKEN,
        createdAt: Date.now(),
        label: tier.label,
      };
      saveLocalSubscription(local);
      setSubscribeResult({
        status: "ok",
        title: "Subscribed",
        rows: [
          { label: "Merchant", value: shortHex(merchant) },
          { label: "Tier", value: tier.label },
          { label: "Subscription", value: shortHex(local.subscriptionId) },
          { label: "Transaction", value: shortHex(txH), hash: txH },
        ],
        note: "This browser now remembers this subscription (see the My Subscriptions tab). There is no other way to look it up - it isn't tied to your address on-chain.",
      });
    } catch (error: any) {
      setSubscribeResult({
        status: "error",
        title: "Subscribe failed",
        note: error?.message ?? String(error),
      });
    } finally {
      setSubscribing(false);
    }
  }

  // --- My Subscriptions tab -------------------------------------------------
  const [mine, setMine] = useState<LocalSubscription[]>([]);
  const [mineState, setMineState] = useState<Record<string, any>>({});
  const [mineBusy, setMineBusy] = useState<string | null>(null);

  async function refreshMine() {
    const list = loadLocalSubscriptions();
    setMine(list);
    if (!vaultDeployed) return;
    const contract = new Contract({ abi: vaultAbi, address: vaultAddress, providerOrAccount: provider });
    const next: Record<string, any> = {};
    for (const s of list) {
      try {
        const [sub, due] = await Promise.all([
          contract.get_subscription(s.subscriptionId),
          contract.is_due(s.subscriptionId),
        ]);
        next[s.subscriptionId] = { sub, due };
      } catch (error: any) {
        next[s.subscriptionId] = { error: error?.message ?? String(error) };
      }
    }
    setMineState(next);
  }

  useEffect(() => {
    if (tab === "mine") refreshMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, vaultAddress]);

  async function handleRenew(s: LocalSubscription) {
    setMineBusy(s.subscriptionId);
    if (!myWalletAccount) {
      setMineBusy(null);
      return;
    }
    const actions: WALLET_API.STRK20_ACTION[] = [
      { type: "withdraw", token: s.token, amount: num.toHex(BigInt(s.tierAmount)), recipient: vaultAddress },
      {
        type: "invoke",
        contract: vaultAddress,
        calldata: [
          "${poolAddress}",
          num.toHex(s.token),
          s.subscriptionId,
          s.merchant,
          num.toHex(BigInt(s.tierAmount)),
          num.toHex(BigInt(s.intervalSeconds)),
          num.toHex(1n),
          num.toHex(BigInt(s.tierAmount)),
          num.toHex(0), // no new cancel_commitment on a top-up - the one set at creation still applies
        ],
      },
    ];
    try {
      const r = await myWalletAccount.strk20InvokeTransaction(actions);
      await provider.waitForTransaction(r.transaction_hash, { retries: 400, retryInterval: 3000 });
      await refreshMine();
    } catch (error) {
      console.error("Renew failed", error);
    } finally {
      setMineBusy(null);
    }
  }

  async function handleCancel(s: LocalSubscription) {
    setMineBusy(s.subscriptionId);
    if (!myWalletAccount) {
      setMineBusy(null);
      return;
    }
    try {
      const contract = new Contract({ abi: vaultAbi, address: vaultAddress, providerOrAccount: myWalletAccount as any });
      const { transaction_hash } = await contract.cancel_subscription(
        s.subscriptionId,
        s.secret,
        connectedAddress,
      );
      await provider.waitForTransaction(transaction_hash, { retries: 400, retryInterval: 3000 });
      removeLocalSubscription(s.subscriptionId);
      await refreshMine();
    } catch (error) {
      console.error("Cancel failed", error);
    } finally {
      setMineBusy(null);
    }
  }

  // --- Creator tab -----------------------------------------------------------
  const [creatorTierIndex, setCreatorTierIndex] = useState(0);
  const [tiers, setTiers] = useState<LocalTier[]>([]);
  const [shareLink, setShareLink] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "creator") setTiers(loadLocalTiers());
  }, [tab]);

  function handlePublishTier() {
    if (!connectedAddress) return;
    const tier = TIERS[creatorTierIndex];
    const local: LocalTier = {
      merchant: connectedAddress,
      tierAmount: tier.amount.toString(),
      intervalSeconds: INTERVAL_SECONDS.toString(),
      label: tier.label,
      createdAt: Date.now(),
    };
    saveLocalTier(local);
    setTiers(loadLocalTiers());
    const url = new URL(window.location.href);
    url.search = `?merchant=${connectedAddress}&amount=${tier.amount.toString()}`;
    setShareLink(url.toString());
  }

  // --- Stats tab (public, no wallet needed) -----------------------------------
  const [stats, setStats] = useState<{ active: string; revenue: string } | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  async function refreshStats() {
    setStatsError(null);
    if (!vaultDeployed) return;
    try {
      const contract = new Contract({ abi: vaultAbi, address: vaultAddress, providerOrAccount: provider });
      const [active, revenue] = await Promise.all([
        contract.total_active_subscriptions(),
        contract.total_revenue(),
      ]);
      setStats({ active: String(active), revenue: fmtStrk(BigInt(revenue)) });
    } catch (error: any) {
      setStatsError(error?.message ?? String(error));
    }
  }

  useEffect(() => {
    if (tab === "stats") refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, vaultAddress]);

  const ResultCard = ({ r }: { r: ActionResult }) => (
    <div
      className={`${styles.receipt} ${
        r.status === "error" ? styles.receiptError : r.status === "pending" ? styles.receiptPending : styles.receiptOk
      }`}
    >
      <div className={styles.receiptHead}>
        <span className={styles.receiptIcon}>{r.status === "ok" ? "✓" : r.status === "error" ? "!" : "⋯"}</span>
        <span>{r.title}</span>
      </div>
      {r.rows?.length ? (
        <div className={styles.receiptRows}>
          {r.rows.map((row) => (
            <div key={row.label} className={styles.receiptRow}>
              <span className={styles.receiptLabel}>{row.label}</span>
              <span className={styles.receiptValue}>{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {r.note ? <pre className={styles.receiptNote}>{r.note}</pre> : null}
    </div>
  );

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.feeRow}>
        <span>Subscription vault</span>
        <span className={`${styles.feeVal} ${vaultDeployed ? styles.netOk : styles.netBad}`}>
          <span className={`${styles.netDot} ${vaultDeployed ? styles.netOkDot : styles.netBadDot}`} />
          {vaultDeployed ? shortHex(vaultAddress) : `Not deployed on ${networkName ?? "this network"}`}
        </span>
      </div>

      {!isStrk20Network && (
        <div className={styles.warn}>STRK20 actions require Mainnet or Sepolia - switch your wallet network.</div>
      )}
      {isStrk20Network && !vaultDeployed && (
        <div className={styles.warn}>
          The subscription vault isn't deployed on {networkName} yet - set NEXT_PUBLIC_SUBSCRIPTION_VAULT_
          {networkName} once it is (see contracts/subscription/README.md).
        </div>
      )}

      {tab === "subscribe" && (
        <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Merchant address</span>
            <input
              className={styles.fieldInput}
              placeholder="0x..."
              value={merchantInput}
              onChange={(e) => setMerchantInput(e.target.value)}
            />
          </div>
          <div className={styles.tierGrid}>
            {TIERS.map((t, i) => (
              <button
                key={t.label}
                className={`${styles.tierOption} ${i === tierIndex ? styles.tierOptionActive : ""}`}
                onClick={() => setTierIndex(i)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className={styles.subLine} style={{ marginBottom: 8 }}>
            <span>Every subscriber on a tier pays the same public amount - only who they are stays hidden.</span>
          </div>
          {isConnected ? (
            <button
              className={styles.btnCta}
              disabled={!vaultDeployed || !merchantInput || subscribing}
              onClick={handleSubscribe}
            >
              {subscribing ? "Subscribing…" : "Subscribe"}
            </button>
          ) : (
            <div className={styles.emptyHint}>Connect a wallet to subscribe.</div>
          )}
          {subscribeResult ? <ResultCard r={subscribeResult} /> : null}
        </>
      )}

      {tab === "mine" && (
        <>
          {mine.length === 0 ? (
            <div className={styles.emptyHint}>
              No subscriptions from this browser yet. Subscribe to something, or import a subscription id/secret
              (not yet supported in this UI - see localStorage key aegis:subscriptions).
            </div>
          ) : (
            mine.map((s) => {
              const state = mineState[s.subscriptionId];
              const sub = state?.sub;
              return (
                <div key={s.subscriptionId} className={styles.subCard}>
                  <div className={styles.subCardHead}>
                    <span>{s.label ?? shortHex(s.subscriptionId)}</span>
                    <span>{sub ? String(sub.status?.activeVariant?.() ?? sub.status) : "…"}</span>
                  </div>
                  <div className={styles.subCardRow}>
                    <span>Merchant</span>
                    <span>{shortHex(s.merchant)}</span>
                  </div>
                  <div className={styles.subCardRow}>
                    <span>Cycles</span>
                    <span>{sub ? `${sub.cycles_executed} / ${sub.cycles_total}` : "…"}</span>
                  </div>
                  <div className={styles.subCardRow}>
                    <span>Due now</span>
                    <span>{state?.due === undefined ? "…" : state.due ? "yes" : "no"}</span>
                  </div>
                  <div className={styles.subCardActions}>
                    <button
                      className={styles.btn}
                      disabled={mineBusy === s.subscriptionId || !isConnected}
                      onClick={() => handleRenew(s)}
                    >
                      Renew (fund next cycle)
                    </button>
                    <button
                      className={styles.btn}
                      disabled={mineBusy === s.subscriptionId || !isConnected}
                      onClick={() => handleCancel(s)}
                    >
                      Cancel & refund
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </>
      )}

      {tab === "creator" && (
        <>
          <div className={styles.subLine} style={{ marginBottom: 10 }}>
            <span>Publish a tier as your connected address, get a shareable subscribe link.</span>
          </div>
          <div className={styles.tierGrid}>
            {TIERS.map((t, i) => (
              <button
                key={t.label}
                className={`${styles.tierOption} ${i === creatorTierIndex ? styles.tierOptionActive : ""}`}
                onClick={() => setCreatorTierIndex(i)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {isConnected ? (
            <button className={styles.btnCta} onClick={handlePublishTier}>
              Get shareable link
            </button>
          ) : (
            <div className={styles.emptyHint}>Connect a wallet to publish a tier.</div>
          )}
          {shareLink ? (
            <div className={styles.receipt + " " + styles.receiptOk}>
              <div className={styles.receiptHead}>
                <span className={styles.receiptIcon}>✓</span>
                <span>Share this link with subscribers</span>
              </div>
              <pre className={styles.receiptNote}>{shareLink}</pre>
            </div>
          ) : null}
          {tiers.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {tiers.map((t, i) => (
                <div key={i} className={styles.subCard}>
                  <div className={styles.subCardHead}>
                    <span>{t.label}</span>
                    <span>{shortHex(t.merchant)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className={styles.emptyHint}>
            There's no on-chain tier registry - a per-merchant subscriber count isn't tracked anywhere (that's
            intentional, see docs/subscription-model.md). Your own revenue is visible the normal way: check your
            STRK balance.
          </div>
        </>
      )}

      {tab === "stats" && (
        <>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{stats?.active ?? "—"}</div>
              <div className={styles.statLabel}>Active subscriptions</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{stats?.revenue ?? "—"}</div>
              <div className={styles.statLabel}>Total revenue (STRK)</div>
            </div>
          </div>
          <button className={`${styles.btn} ${styles.btnBlock}`} onClick={refreshStats} style={{ marginTop: 12 }}>
            Refresh
          </button>
          {statsError ? <div className={styles.errorText}>{statsError}</div> : null}
          <div className={styles.emptyHint}>
            Public, no wallet needed - both numbers come straight from the vault contract's own storage. No
            individual subscriber or payment is exposed.
          </div>
        </>
      )}
    </div>
  );
}
