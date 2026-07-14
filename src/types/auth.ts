/**
 * User info
 */
export interface IUser {
  id: string;
  phone: string;
  username: string;
  name?: string;
  auth_token?: string;
  position: string;
  avatar: string;
  hasPassword: boolean;
  certStatus: string;
  certMaterial: Record<string, unknown>;
  certResult: Record<string, unknown>;
  shippingAddresses: unknown[];
  shippingAccounts: unknown[];
  stores: unknown[];
  walletBalance?: number;
  inviteCode: string;
}

/**
 * User login data
 */
export interface ILoginData {
  token: string;
  user: IUser;
}

/**
 * User login response
 */
export interface ILoginResponse {
  success: boolean;
  message: string;
  data: ILoginData;
}
