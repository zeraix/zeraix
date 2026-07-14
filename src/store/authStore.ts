import { create } from "zustand";
import { getAuthToken } from "@/lib/actions/auth.actions";
import { getStorage } from "@zzcpt/zztool";
import { IUser } from "@/types/auth";
import STORAGE_KEY from "@/constants/Storage";

/**
 * 用户认证状态类型定义
 */
type UserState = {
  /** 是否已登录 */
  isLoggedIn: boolean;
  /** 是否需要创建账户 */
  shouldCreateAccount: boolean;
  /** 是否已完成引导流程 */
  hasCompletedOnboarding: boolean;
  /** 是否是 VIP 用户 */
  isVip: boolean;
  /** 用户基本信息（非敏感） */
  userInfo: IUser | Partial<IUser>;
  /** 是否已完成 hydration（防止 SSR/客户端状态不一致） */
  _hasHydrated: boolean;

  // Actions
  /** 登录成功 */
  logIn: (userInfo?: UserState["userInfo"]) => void;
  /** 登出 */
  logOut: () => void;
  /** 完成引导流程 */
  completeOnboarding: () => void;
  /** 重置引导状态 */
  resetOnboarding: () => void;
  /** 设置为 VIP */
  logInAsVip: () => void;
  /** 更新用户信息 */
  setUserInfo: (userInfo: UserState["userInfo"]) => void;
  /** 设置 hydration 完成状态 */
  setHasHydrated: (value: boolean) => void;
  /** 检查登录状态（从 localStorage 读取 token 验证） */
  checkAuthStatus: () => Promise<boolean>;
};

/**
 * 认证状态管理 Store（纯静态导出兼容版本）
 *
 * 安全说明：
 * - Token 存储在 localStorage 的 yingjian.userInfo.auth_token 中
 * - 客户端仅存储非敏感的用户状态信息
 */
export const useAuthStore = create<UserState>((set) => ({
  // 初始状态
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
   * 检查认证状态
   * 从 localStorage 读取 token，存在则认为已登录并同步用户信息到 Store
   */
  checkAuthStatus: async () => {
    try {
      const token = getAuthToken();

      if (!token) {
        set({ isLoggedIn: false, userInfo: undefined });
        return false;
      }

      // token 存在：从 localStorage 读取用户信息同步到 Store
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
      console.error("检查认证状态失败:", error);
      set({ isLoggedIn: false, userInfo: undefined });
      return false;
    }
  },
}));

/**
 * 初始化 hydration 状态
 * 在应用启动时调用，防止 SSR/客户端状态不一致
 */
export const initAuthStore = () => {
  useAuthStore.getState().setHasHydrated(true);
};