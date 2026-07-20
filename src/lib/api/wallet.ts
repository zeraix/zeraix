import request from "./request";
import type { ApiResponse } from "@/types/index";
import type { IUser } from "@/types/auth";

/**
 * Wallet / top-up API — Stripe Checkout (card / Apple Pay / Google Pay).
 * Contract: `docs/stripe-frontend-integration.md`. All amounts are USD **dollars** (10 = $10.00), never cents.
 *
 * Flow:
 *   1. createStripeCheckout() → { url, outTradeNo }
 *   2. send the user to `url` (Electron: system browser; web: full-page redirect — never fetch() it, it's cross-origin)
 *   3. the user pays on Stripe's hosted page
 *   4. Stripe's server-to-server webhook credits the wallet — that is the ONLY source of truth.
 *      Coming back from the browser is NOT proof of payment, and the wallet is never credited client-side.
 *   5. poll queryStripeOrder(outTradeNo) until status is "completed" or "failed", then refresh the balance
 *      via useAuthStore.refreshWallet() (POST /auth/refresh-me) — the server is the only source of the number.
 *
 * A closed tab does not lose the payment: the webhook still completes the order, so the UI follows the
 * order status rather than the navigation.
 */

/** Minimum top-up, in USD. In development the backend force-charges $0.50 regardless of what we send. */
export const MIN_TOPUP_USD = 1;
/** Balance at or below which the wallet counts as low, in USD. */
export const LOW_BALANCE_USD = 1;

/** POST body for a personal top-up. `amount` is in dollars (10 = $10.00). */
export interface CreateCheckoutParams {
  /** Charge amount in USD dollars; must be >= MIN_TOPUP_USD. */
  amount: number;
  /** Order description, shown on the Stripe page and in the top-up history. */
  subject: string;
  /**
   * Where Stripe sends the user after paying; the backend appends `stripeOrderId=<outTradeNo>` to it.
   * Omitted in Electron (there is no http origin to return to — the renderer is served from app://), so the
   * backend falls back to STRIPE_SUCCESS_URL / `${FRONTEND_URL}/payment-result` and we poll from inside the app.
   */
  returnUrl?: string;
}

/** `data` of a successful create-checkout call. */
export interface CheckoutSession {
  /** PaymentOrder._id. */
  orderId: string;
  /** Merchant order number — the handle used to poll or re-pay this order. */
  outTradeNo: string;
  /** Stripe-hosted Checkout URL. Navigate the whole page there; do not fetch it. */
  url: string;
  /** Charge amount in USD, echoed back. */
  amount: number;
}

/** Order lifecycle. Terminal for our purposes: completed (paid) / failed. */
export type PaymentOrderStatus = "pending" | "processing" | "completed" | "failed" | "refunded";

/** `data` of query-order. */
export interface OrderStatus {
  orderId: string;
  outTradeNo: string;
  status: PaymentOrderStatus;
  /** Amount credited to the wallet, in USD. */
  amountUsd: number;
  completedAt?: string;
}

/**
 * Create a personal top-up order. `400` when `amount`/`subject` is missing or below the minimum,
 * `500` when Stripe is unreachable. Callers should gate this behind requireLogin() — top-up is account-bound.
 */
export async function createStripeCheckout(
  params: CreateCheckoutParams,
): Promise<ApiResponse<CheckoutSession>> {
  return request<ApiResponse<CheckoutSession>>("/stripe/create-checkout", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Poll an order's status. `404` when the order is unknown *or* belongs to another user.
 * A few seconds of `pending` right after payment is normal; while pending the endpoint also reconciles
 * against Stripe once, so it doubles as a safety net for a delayed webhook.
 */
export async function queryStripeOrder(outTradeNo: string): Promise<ApiResponse<OrderStatus>> {
  return request<ApiResponse<OrderStatus>>("/stripe/query-order", {
    method: "POST",
    body: JSON.stringify({ outTradeNo }),
  });
}

/**
 * Get a fresh payment link for an unpaid order, reusing the same `outTradeNo` instead of piling up
 * pending orders. Backs the "Retry payment" button after the user cancels on Stripe's page.
 * `400` when the order is already completed/refunded, `403` when it isn't the caller's, `404` when unknown.
 */
export async function repayStripeOrder(
  outTradeNo: string,
  returnUrl?: string,
): Promise<ApiResponse<Pick<CheckoutSession, "outTradeNo" | "url">>> {
  return request<ApiResponse<Pick<CheckoutSession, "outTradeNo" | "url">>>("/stripe/repay", {
    method: "POST",
    body: JSON.stringify({ outTradeNo, returnUrl }),
  });
}

/** Re-fetch the current user so the UI can pick up the new walletBalance once the webhook has credited it. */
export async function getMe(): Promise<ApiResponse<IUser>> {
  return request<ApiResponse<IUser>>("/me/usage-report", { method: "GET" });
}
