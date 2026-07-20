"use client";

/**
 * Top-up page (/agent/wallet): add funds to the account balance via Stripe Checkout.
 * Reuses the /agent shell (persistent sidebar + chat). Reached from the wallet card's
 * "Top up" button in AgentSidebar. Contract: docs/stripe-frontend-integration.md.
 *
 * Money is USD everywhere — the platform's base currency (§4). The edition only changes the *display* unit:
 *  - cn   edition → amounts shown/entered in credits ($1 = 1000 credits, see constants/Credit.ts).
 *  - intl edition → amounts shown/entered in US dollars.
 * Either way the Stripe charge is sent in dollars.
 *
 * Payment flow (§2): create the order → send the user to Stripe's hosted page → poll `query-order`
 * until it is terminal. Two rules this page exists to honour:
 *  - the wallet is NEVER credited client-side; Stripe's webhook is the only source of truth, so we
 *    trust the polled order status rather than "the user came back";
 *  - a closed browser does not lose the payment, so the pending order is persisted and polling resumes
 *    on the next visit (or after an app restart).
 *
 * Desktop vs web: in Electron the renderer has no http origin to return to, so we open Checkout in the
 * system browser (setWindowOpenHandler routes it) and poll in-app with no returnUrl. On the web we do the
 * required full-page redirect and read `?stripeOrderId=` back on return.
 *
 * Top-up is account-bound, so paying is gated behind requireLogin() (guests may still view the page).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Coins,
  CreditCard,
  Loader2,
  RefreshCw,
  Check,
  Lock,
  Sparkles,
  CircleCheck,
  CircleAlert,
  Clock,
  TriangleAlert,
  ExternalLink,
} from "lucide-react";
import { getStorage, setStorage, removeStorage } from "@zzcpt/zztool";
import { useT } from "@/lib/i18n";
import { useAuthStore } from "@/store/authStore";
import { useLoginModalStore } from "@/store/loginModalStore";
import { isAuthenticated } from "@/lib/actions/auth.actions";
import { Toast } from "@/lib/toast";
import { isCnEdition, formatWallet } from "@/lib/edition";
import { isShellAvailable } from "@/lib/electron/shell";
import { CREDITS_PER_USD, MIN_CUSTOM_CREDITS } from "@/constants/Credit";
import {
  createStripeCheckout,
  queryStripeOrder,
  repayStripeOrder,
  MIN_TOPUP_USD,
  LOW_BALANCE_USD,
  type PaymentOrderStatus,
} from "@/lib/api/wallet";
import STORAGE_KEY from "@/constants/Storage";

// Preset amounts, in the edition's display unit (credits for cn, dollars for intl).
const PRESETS = isCnEdition ? [5000, 10000, 30000, 60000, 100000] : [5, 10, 20, 50, 100];
const DEFAULT_AMOUNT = isCnEdition ? 10000 : 10;
const POPULAR_AMOUNT = DEFAULT_AMOUNT; // one preset carries a subtle "Popular" badge
// Minimum / maximum purchasable amount per top-up, in the display unit. The minimum mirrors the
// backend's $2.00 floor — going below it is rejected with a 400.
const MIN_AMOUNT = isCnEdition ? MIN_CUSTOM_CREDITS : MIN_TOPUP_USD;
const MAX_AMOUNT = isCnEdition ? 1_000_000 : 100000;

// Polling cadence for query-order. A few seconds of `pending` right after payment is expected; past
// POLL_TIMEOUT_MS we stop and tell the user it will still be credited by the webhook.
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
// Consecutive query-order failures (network / 404) tolerated before we stop polling.
const MAX_POLL_MISSES = 5;
// A stored pending order older than this is stale — Stripe sessions expire, so stop resuming it.
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** Payment-flow state. "idle" = nothing in flight; "stalled" = still pending when polling timed out. */
type Phase = "idle" | "awaiting" | "success" | "failed" | "stalled";

/** The order we are following, persisted so polling survives a reload / app restart. */
interface PendingTopup {
  outTradeNo: string;
  /** Charge amount in USD, for the "credited" message. */
  amountUsd: number;
  createdAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Module scope so the React-compiler purity rule doesn't see Date.now() inside the component. */
const nowMs = () => Date.now();

export default function WalletPage() {
  const t = useT();
  const router = useRouter();
  const userInfo = useAuthStore((s) => s.userInfo);
  const refreshWallet = useAuthStore((s) => s.refreshWallet);
  const requireLogin = useLoginModalStore((s) => s.requireLogin);

  const [amount, setAmount] = useState<number>(DEFAULT_AMOUNT); // selected preset (display unit)
  const [custom, setCustom] = useState(""); // custom-amount input (display unit); non-empty overrides the preset
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [order, setOrder] = useState<PendingTopup | null>(null);
  const [creditedUsd, setCreditedUsd] = useState<number | null>(null); // amount the backend says it credited

  const walletText = formatWallet(userInfo?.walletBalance);
  const balance = userInfo?.walletBalance ?? 0;
  const lowBalance = phase === "idle" && balance < LOW_BALANCE_USD;

  // Effective amount (display unit): the custom input when present, else the selected preset. Integer units.
  const effective = useMemo(() => {
    const raw = custom.trim() === "" ? amount : Math.floor(Number(custom));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }, [custom, amount]);
  const valid = effective >= MIN_AMOUNT && effective <= MAX_AMOUNT;
  const usingCustom = custom.trim() !== "";

  // What Stripe actually charges, in USD dollars: cn edition enters credits (1000 = $1), intl enters dollars.
  const chargeUsd = isCnEdition ? effective / CREDITS_PER_USD : effective;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const unitLabel = (n: number) =>
    isCnEdition ? `${n.toLocaleString()} ${t("wallet.creditsUnit")}` : usd(n);
  const minLabel = unitLabel(MIN_AMOUNT);
  const maxLabel = unitLabel(MAX_AMOUNT);
  const fmtDisplay = (n: number) => (isCnEdition ? n.toLocaleString() : `$${n}`);
  // Price of a display-unit amount, always in the settlement currency (USD).
  const fmtPrice = (n: number) => usd(isCnEdition ? n / CREDITS_PER_USD : n);

  // Pull the balance from the server (GET /me) — the one place it can be known, since the credit comes from
  // Stripe's webhook. `force` skips the store's throttle; `silent` suppresses the toast.
  const refresh = useCallback(
    async (silent = false) => {
      if (!isAuthenticated()) return;
      setRefreshing(true);
      try {
        await refreshWallet({ force: true });
        if (!silent) Toast.success(t("wallet.balanceUpdated"));
      } finally {
        setRefreshing(false);
      }
    },
    [refreshWallet, t],
  );
  // Kept in a ref so the polling effect can call the latest refresh without re-subscribing on every render.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const clearPending = useCallback(() => {
    removeStorage(STORAGE_KEY.pendingTopup);
  }, []);

  const beginTracking = useCallback((next: PendingTopup) => {
    setStorage(STORAGE_KEY.pendingTopup, next);
    setOrder(next);
    setCreditedUsd(null);
    setPhase("awaiting");
  }, []);

  // Pick up an order that is already in flight: the `?stripeOrderId=` the backend appended to our returnUrl
  // (web redirect), or a pending order left over from a previous session (desktop, or a closed browser).
  /* eslint-disable react-hooks/set-state-in-effect -- mount-time adoption of external state
     (URL query + localStorage), neither of which is readable during render in a prerendered page. */
  useEffect(() => {
    const fromUrl =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("stripeOrderId")
        : null;
    const stored = getStorage(STORAGE_KEY.pendingTopup) as PendingTopup | null;
    if (fromUrl) {
      const next: PendingTopup =
        stored?.outTradeNo === fromUrl
          ? stored
          : { outTradeNo: fromUrl, amountUsd: 0, createdAt: nowMs() };
      setStorage(STORAGE_KEY.pendingTopup, next);
      setOrder(next);
      setPhase("awaiting");
      return;
    }
    if (stored?.outTradeNo) {
      if (nowMs() - (stored.createdAt || 0) > PENDING_TTL_MS) removeStorage(STORAGE_KEY.pendingTopup);
      else {
        setOrder(stored);
        setPhase("awaiting");
      }
    }
    // Runs once on mount: we only want to adopt the order that exists when the page opens.
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Poll query-order until the order is terminal. The webhook — not this poll and not the redirect —
  // is what credits the wallet; we only observe the result.
  useEffect(() => {
    if (phase !== "awaiting" || !order) return;
    let cancelled = false;
    let misses = 0;
    const startedAt = nowMs();

    const run = async () => {
      while (!cancelled) {
        // Wait first: the order was created moments ago and cannot be paid yet.
        await sleep(POLL_INTERVAL_MS);
        if (cancelled) return;

        let status: PaymentOrderStatus | null = null;
        let amountUsd = order.amountUsd;
        try {
          const res = await queryStripeOrder(order.outTradeNo);
          if (res?.success && res.data) {
            status = res.data.status;
            if (typeof res.data.amountUsd === "number") amountUsd = res.data.amountUsd;
            misses = 0;
          } else {
            misses += 1; // 404: unknown order, or not ours
          }
        } catch {
          misses += 1; // offline / transient
        }
        if (cancelled) return;

        if (status === "completed") {
          clearPending();
          setCreditedUsd(amountUsd);
          setPhase("success");
          void refreshRef.current(true);
          return;
        }
        if (status === "failed" || status === "refunded") {
          clearPending();
          setPhase("failed");
          return;
        }
        if (misses >= MAX_POLL_MISSES || nowMs() - startedAt > POLL_TIMEOUT_MS) {
          // Not a failure: the order may still be paid and credited later by the webhook.
          setPhase("stalled");
          return;
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [phase, order, clearPending]);

  // Send the user to Stripe's hosted page. Never fetch() this URL — it is a cross-origin hosted page (§2 rule 1).
  const openCheckout = (url: string) => {
    if (isShellAvailable()) {
      // Electron: setWindowOpenHandler hands https URLs to the system browser.
      window.open(url, "_blank", "noopener,noreferrer");
      Toast.success(t("wallet.redirecting"));
    } else {
      window.location.assign(url); // web: full-page redirect, per the contract
    }
  };

  /** Where Stripe should send the user back to. Undefined on desktop — there is no http origin to return to. */
  const returnUrl = () => {
    if (isShellAvailable() || typeof window === "undefined") return undefined;
    return `${window.location.origin}${window.location.pathname}`;
  };

  const pay = async () => {
    if (effective < MIN_AMOUNT) {
      Toast.error(t("wallet.minAmount", { min: minLabel }));
      return;
    }
    if (effective > MAX_AMOUNT) {
      Toast.error(t("wallet.maxAmount", { max: maxLabel }));
      return;
    }
    if (!(await requireLogin())) return; // account-bound: prompt Google sign-in first
    setLoading(true);
    try {
      const res = await createStripeCheckout({
        amount: Number(chargeUsd.toFixed(2)),
        subject: t("wallet.orderSubject"),
        returnUrl: returnUrl(),
      });
      if (res?.success && res.data?.url) {
        beginTracking({
          outTradeNo: res.data.outTradeNo,
          amountUsd: res.data.amount ?? Number(chargeUsd.toFixed(2)),
          createdAt: nowMs(),
        });
        openCheckout(res.data.url);
      } else {
        Toast.error(res?.message || res?.error || t("wallet.payFailed"));
      }
    } catch (e) {
      Toast.error(typeof e === "string" ? e : t("wallet.payFailed"));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Reopen / retry the payment page for the order we are already following. Always asks the backend for a
   * fresh link (§3.4) rather than reusing the one we opened: it reuses the same `outTradeNo` instead of
   * piling up pending orders, works after the Stripe session has expired, and — since the checkout page is
   * opened in an external browser that the user may simply have closed — is the only way back to it.
   */
  const retry = async () => {
    if (!order) return;
    setLoading(true);
    try {
      const res = await repayStripeOrder(order.outTradeNo, returnUrl());
      if (res?.success && res.data?.url) {
        setPhase("awaiting");
        openCheckout(res.data.url);
      } else {
        Toast.error(res?.message || res?.error || t("wallet.retryFailed"));
      }
    } catch (e) {
      Toast.error(typeof e === "string" ? e : t("wallet.retryFailed"));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Dismiss the order and go back to the amount picker. Only stops us watching it: an order that was in
   * fact paid is still credited by the webhook, and the new balance shows up on the next refresh.
   */
  const reset = () => {
    clearPending();
    setOrder(null);
    setCreditedUsd(null);
    setPhase("idle");
    if (typeof window !== "undefined" && window.location.search.includes("stripeOrderId")) {
      router.replace("/agent/wallet");
    }
  };

  const showPicker = phase === "idle";

  return (
    <div className="mx-auto w-full max-w-lg px-6 py-10">
      {/* Header */}
      <div className="mb-8 flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="-ml-1.5 grid size-9 place-items-center rounded-full text-ink-subtle transition hover:bg-surface-muted hover:text-ink"
          title={t("wallet.back")}
        >
          <ArrowLeft className="size-[18px]" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("wallet.title")}</h1>
          <p className="mt-0.5 text-sm text-ink-subtle">{t("wallet.subtitle")}</p>
        </div>
      </div>

      {/* Balance hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/[0.08] to-primary/[0.02] px-5 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="pointer-events-none absolute -right-10 -top-12 size-40 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary">
              <Coins className="size-4" />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary/90">
              {isCnEdition ? t("menu.credits") : t("menu.balance")}
            </span>
          </div>
          <button
            onClick={() => void refresh(false)}
            disabled={refreshing}
            className="grid size-8 place-items-center rounded-full text-ink-subtle transition hover:bg-surface/70 hover:text-ink disabled:opacity-50"
            title={t("wallet.refresh")}
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
        <p className="relative mt-3 text-4xl font-semibold tracking-tight tabular-nums text-ink">
          {walletText}
        </p>
        {lowBalance && (
          <p className="relative mt-2 flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-500">
            <TriangleAlert className="size-3" /> {t("wallet.lowBalance")}
          </p>
        )}
      </div>

      {showPicker ? (
        <>
          {/* Amount presets */}
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            {t("wallet.selectAmount")}
          </p>
          <div className="mb-6 grid grid-cols-3 gap-2.5">
            {PRESETS.map((p) => {
              const selected = !usingCustom && amount === p;
              return (
                <button
                  key={p}
                  onClick={() => {
                    setAmount(p);
                    setCustom("");
                  }}
                  className={`group relative flex flex-col items-center justify-center gap-0.5 rounded-xl border px-2 py-4 transition-all ${
                    selected
                      ? "border-primary bg-primary/[0.07] shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                      : "border-line bg-surface hover:border-primary/40 hover:bg-surface-muted/40"
                  }`}
                >
                  {p === POPULAR_AMOUNT && (
                    <span className="absolute -top-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-primary px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white shadow-sm">
                      <Sparkles className="size-2.5" /> {t("wallet.popular")}
                    </span>
                  )}
                  <span className={`text-[15px] font-semibold tabular-nums ${selected ? "text-primary" : "text-ink"}`}>
                    {fmtDisplay(p)}
                  </span>
                  {isCnEdition && <span className="text-[11px] tabular-nums text-ink-muted">{fmtPrice(p)}</span>}
                  {selected && (
                    <span className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded-full bg-primary text-white">
                      <Check className="size-2.5" strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Custom amount */}
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            {t("wallet.customAmount")}
          </p>
          <div
            className={`mb-1.5 flex items-center gap-2 rounded-xl border bg-surface px-3.5 py-3 transition ${
              usingCustom && !valid ? "border-destructive/60" : "border-line focus-within:border-primary"
            }`}
          >
            {!isCnEdition && <span className="text-lg font-medium text-ink-muted">$</span>}
            <input
              type="number"
              min={MIN_AMOUNT}
              max={MAX_AMOUNT}
              step={1}
              inputMode="numeric"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={t("wallet.customPlaceholder", { min: minLabel, max: maxLabel })}
              className="min-w-0 flex-1 bg-transparent text-base tabular-nums text-ink outline-none placeholder:text-sm placeholder:font-normal placeholder:text-ink-muted"
            />
            {isCnEdition && <span className="shrink-0 text-sm text-ink-muted">{t("wallet.creditsUnit")}</span>}
          </div>
          <p className={`mb-8 text-[11px] ${usingCustom && !valid ? "text-destructive" : "text-ink-muted"}`}>
            {minLabel} – {maxLabel}
          </p>

          {/* Summary + pay */}
          <div className="rounded-2xl border border-line bg-surface-muted/40 p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-subtle">{t("wallet.youPay")}</span>
              <span className="text-2xl font-semibold tracking-tight tabular-nums text-ink">
                {valid ? fmtPrice(effective) : "—"}
              </span>
            </div>
            {isCnEdition && (
              <div className="mt-3 flex items-baseline justify-between border-t border-line/70 pt-3">
                <span className="text-sm text-ink-subtle">{t("wallet.youReceive")}</span>
                <span className="text-sm font-semibold tabular-nums text-ink">
                  {valid ? `${effective.toLocaleString()} ${t("wallet.creditsUnit")}` : "—"}
                </span>
              </div>
            )}
            <button
              onClick={() => void pay()}
              disabled={loading || !valid}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(133,104,0,0.25)] transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
              {loading ? t("wallet.processing") : t("wallet.payWithCard")}
            </button>
            <p className="mt-3.5 flex items-center justify-center gap-1.5 text-[11px] text-ink-muted">
              <Lock className="size-3" /> {t("wallet.secureNote")}
            </p>
          </div>
        </>
      ) : (
        /* Order status: what the polled order says, never what the navigation implies. */
        <div className="rounded-2xl border border-line bg-surface-muted/40 p-6 text-center">
          {phase === "awaiting" && (
            <>
              <span className="mx-auto grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
                <Loader2 className="size-5 animate-spin" />
              </span>
              <p className="mt-3.5 text-base font-semibold text-ink">{t("wallet.awaitingTitle")}</p>
              <p className="mt-1.5 text-sm text-ink-subtle">{t("wallet.awaitingHint")}</p>
            </>
          )}
          {phase === "success" && (
            <>
              <span className="mx-auto grid size-11 place-items-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                <CircleCheck className="size-5" />
              </span>
              <p className="mt-3.5 text-base font-semibold text-ink">{t("wallet.successTitle")}</p>
              <p className="mt-1.5 text-sm text-ink-subtle">
                {t("wallet.successBody", {
                  amount: isCnEdition
                    ? `${Math.floor((creditedUsd ?? 0) * CREDITS_PER_USD).toLocaleString()} ${t("wallet.creditsUnit")}`
                    : usd(creditedUsd ?? 0),
                })}
              </p>
            </>
          )}
          {phase === "failed" && (
            <>
              <span className="mx-auto grid size-11 place-items-center rounded-full bg-destructive/12 text-destructive">
                <CircleAlert className="size-5" />
              </span>
              <p className="mt-3.5 text-base font-semibold text-ink">{t("wallet.failedTitle")}</p>
              <p className="mt-1.5 text-sm text-ink-subtle">{t("wallet.failedBody")}</p>
            </>
          )}
          {phase === "stalled" && (
            <>
              <span className="mx-auto grid size-11 place-items-center rounded-full bg-amber-500/12 text-amber-600 dark:text-amber-500">
                <Clock className="size-5" />
              </span>
              <p className="mt-3.5 text-base font-semibold text-ink">{t("wallet.stalledTitle")}</p>
              <p className="mt-1.5 text-sm text-ink-subtle">{t("wallet.stalledBody")}</p>
            </>
          )}

          {order && (
            <p className="mt-3 font-mono text-[11px] text-ink-muted">
              {t("wallet.orderNo", { no: order.outTradeNo })}
            </p>
          )}

          <div className="mt-5 flex flex-col gap-2">
            {/* Checkout opens in an external browser the user can close at any time, so every non-final
                state offers a way back to the payment page (a fresh link for the same order). */}
            {phase !== "success" && (
              <button
                onClick={() => void retry()}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.99] disabled:opacity-40"
              >
                {loading ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                {phase === "awaiting" ? t("wallet.reopen") : t("wallet.retry")}
              </button>
            )}
            {phase === "stalled" && (
              <button
                onClick={() => setPhase("awaiting")}
                className="w-full rounded-xl border border-line px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-surface-muted"
              >
                {t("wallet.checkNow")}
              </button>
            )}
            <button
              onClick={reset}
              className="w-full rounded-xl border border-line px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-surface-muted"
            >
              {phase === "success" ? t("wallet.topUpAgain") : t("wallet.cancelOrder")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
