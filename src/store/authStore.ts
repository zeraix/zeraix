import { create } from "zustand";
import { getAuthToken, isAuthenticated, setAuthCookie } from "@/lib/actions/auth.actions";
import { getStorage, setStorage } from "@zzcpt/zztool";
import { refreshCurrentUser } from "@/lib/api/auth";
import { IUser } from "@/types/auth";
import STORAGE_KEY from "@/constants/Storage";

/**
 * User authentication state type definition
 */
type UserState = {
  /** Whether the user is logged in */
  isLoggedIn: boolean;
  /** Whether the user needs to create an account */
  shouldCreateAccount: boolean;
  /** Whether the user has completed the onboarding process */
  hasCompletedOnboarding: boolean;
  /** Whether the user is a VIP */
  isVip: boolean;
  /** User basic information (non-sensitive) */
  userInfo: IUser | Partial<IUser>;
  /** Whether the user has completed hydration (to prevent SSR/client-side state inconsistency) */
  _hasHydrated: boolean;

  // Actions
  /** Login successful */
  logIn: (userInfo?: UserState["userInfo"]) => void;
  /** Logout */
  logOut: () => void;
  /** Complete onboarding process */
  completeOnboarding: () => void;
  /** Reset onboarding status */
  resetOnboarding: () => void;
  /** Set as VIP */
  logInAsVip: () => void;
  /** Update user information */
  setUserInfo: (userInfo: UserState["userInfo"]) => void;
  /** Set hydration completion status */
  setHasHydrated: (value: boolean) => void;
  /** Check login status (read token from localStorage for validation) */
  checkAuthStatus: () => Promise<boolean>;
  /** Re-fetch the user (POST /auth/refresh-me) so `walletBalance` reflects what the server just charged. */
  refreshWallet: (opts?: { force?: boolean }) => Promise<void>;
};

/**
 * Wallet-refresh throttle. Official direct-connection models bill per step, and the agent loop refreshes
 * after every one of them — a burst of tool rounds must not turn into a burst of /me calls. `force` (used by
 * the manual refresh button and after a completed top-up) bypasses this.
 */
const WALLET_REFRESH_MIN_INTERVAL_MS = 3000;
let walletRefreshAt = 0;
let walletRefreshInFlight: Promise<void> | null = null;

/**
 * Auth state management store (pure static export compatible version).
 *
 * Security Note:
 * - The token is stored in `localStorage` under `yingjian.userInfo.auth_token`.
 * - The client only stores non-sensitive user state information.
 */
export const useAuthStore = create<UserState>((set) => ({
  // Initial state
  isLoggedIn: false,
  shouldCreateAccount: false,
  hasCompletedOnboarding: false,
  isVip: false,
  userInfo: {} as IUser,
  _hasHydrated: false,

  // Actions
  logIn: (userInfo) => {
    set({
      isLoggedIn: true,
      userInfo: userInfo || undefined,
    });
  },

  // Safe to call more than once (an explicit sign-out also clears storage, which re-announces it).
  // `userInfo` is reset to {} rather than undefined so consumers keep reading a plain object, as on first load.
  logOut: () => {
    set({
      isLoggedIn: false,
      isVip: false,
      userInfo: {} as IUser,
    });
  },

  logInAsVip: () => {
    set({
      isVip: true,
      isLoggedIn: true,
    });
  },

  setUserInfo: (userInfo) => {
    set({ userInfo });
  },

  completeOnboarding: () => {
    set({ hasCompletedOnboarding: true });
  },

  resetOnboarding: () => {
    set({ hasCompletedOnboarding: false });
  },

  setHasHydrated: (value) => {
    set({ _hasHydrated: value });
  },

  /**
   * Pull the authoritative wallet balance from the server and mirror it into the store + localStorage.
   *
   * The balance is only ever server-side truth: official direct-connection calls are billed per step by the
   * backend, and top-ups are credited by Stripe's webhook — the client never computes it. Callable from
   * outside React via `useAuthStore.getState().refreshWallet()`.
   *
   * Best-effort by design: a failed /me leaves the previous number on screen rather than blanking it, and
   * never interrupts whatever the caller was doing. Guests are skipped (nothing to fetch).
   */
  refreshWallet: async ({ force = false } = {}) => {
    if (!isAuthenticated()) return;
    if (walletRefreshInFlight) return walletRefreshInFlight;
    if (!force && Date.now() - walletRefreshAt < WALLET_REFRESH_MIN_INTERVAL_MS) return;

    walletRefreshInFlight = (async () => {
      try {
        const res = await refreshCurrentUser();
        // /auth/refresh-me nests the account under `data.user` and hands back a renewed `data.token`;
        // only the user object belongs in `userInfo` — spreading `data` itself would bury token/member/
        // institution in there and leave walletBalance untouched.
        const user = res?.data?.user;
        if (!res?.success || !user) return;
        const stored = (getStorage(STORAGE_KEY.userInfo) as Record<string, unknown>) || {};
        setStorage(STORAGE_KEY.userInfo, { ...stored, ...user });
        // Sliding session: persist the renewed token the same way every other caller does.
        if (res.data?.token) setAuthCookie(res.data.token);
        set((s) => ({ userInfo: { ...s.userInfo, ...user } }));
      } catch {
        /* best-effort: keep showing the last known balance */
      } finally {
        walletRefreshAt = Date.now();
        walletRefreshInFlight = null;
      }
    })();
    return walletRefreshInFlight;
  },

  /**
   * Check authentication status
   * Read token from localStorage, if exists, consider the user logged in and synchronize user information to the Store
   */
  checkAuthStatus: async () => {
    try {
      const token = getAuthToken();

      if (!token) {
        set({ isLoggedIn: false, userInfo: {} as IUser });
        return false;
      }

      // Token exists: Read user info from localStorage and synchronize it to the Store
      if (typeof window !== "undefined") {
        const data = getStorage(STORAGE_KEY.userInfo);
        if (data) {
          set({
            isLoggedIn: true,
            userInfo: {
              ...data,
              auth_token: token,
              name: data.username || data.name,
              avatar: data.avatar,
            },
          });
          return true;
        }
      }

      set({ isLoggedIn: true });
      return true;
    } catch (error) {
      console.error("Check authentication status failed:", error);
      set({ isLoggedIn: false, userInfo: {} as IUser });
      return false;
    }
  },
}));

/**
 * Initialize hydration status
 * Called when the application starts, to prevent SSR/client-side state inconsistency
 */
export const initAuthStore = () => {
  useAuthStore.getState().setHasHydrated(true);
};