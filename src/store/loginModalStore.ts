import { create } from "zustand";
import { isAuthenticated } from "@/lib/actions/auth.actions";

/**
 * Global login-modal state.
 *
 * Login is no longer a forced gate: guests can use the whole /agent surface.
 * The modal is only shown on demand for account-bound actions (top-up, adding
 * official models, generating official API keys). Those call `requireLogin()`
 * and proceed only if it resolves `true`.
 *
 * The store is usable outside React via `useLoginModalStore.getState()`, so
 * non-component code can open the modal or read auth state.
 */
type LoginModalState = {
  /** Whether the login modal is currently open. */
  open: boolean;
  /** Pending resolver for the in-flight requireLogin() promise (null when idle). */
  _resolve: ((success: boolean) => void) | null;

  /**
   * Ensure the user is logged in before running a gated action.
   * - Already authenticated → resolves `true` immediately (no modal).
   * - Otherwise → opens the modal and resolves once the user signs in (`true`)
   *   or dismisses it (`false`).
   */
  requireLogin: () => Promise<boolean>;
  /** Settle the current requireLogin() call and close the modal. */
  resolveLogin: (success: boolean) => void;
  /** Dismiss the modal (equivalent to resolveLogin(false)). */
  close: () => void;
};

export const useLoginModalStore = create<LoginModalState>((set, get) => ({
  open: false,
  _resolve: null,

  requireLogin: () => {
    if (isAuthenticated()) return Promise.resolve(true);
    // Settle any previously pending call as dismissed before opening a new one.
    get()._resolve?.(false);
    return new Promise<boolean>((resolve) => {
      set({ open: true, _resolve: resolve });
    });
  },

  resolveLogin: (success) => {
    const { _resolve } = get();
    set({ open: false, _resolve: null });
    _resolve?.(success);
  },

  close: () => get().resolveLogin(false),
}));

/**
 * Open the login modal from non-React code and await the outcome.
 * Thin wrapper over the store so callers don't need the hook.
 */
export function requireLogin(): Promise<boolean> {
  return useLoginModalStore.getState().requireLogin();
}
