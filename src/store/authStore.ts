import { create } from "zustand";
import { getAuthToken } from "@/lib/actions/auth.actions";
import { getStorage } from "@zzcpt/zztool";
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
};

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

  logOut: () => {
    set({
      isLoggedIn: false,
      isVip: false,
      userInfo: undefined,
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
   * Check authentication status
   * Read token from localStorage, if exists, consider the user logged in and synchronize user information to the Store
   */
  checkAuthStatus: async () => {
    try {
      const token = getAuthToken();

      if (!token) {
        set({ isLoggedIn: false, userInfo: undefined });
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
      set({ isLoggedIn: false, userInfo: undefined });
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