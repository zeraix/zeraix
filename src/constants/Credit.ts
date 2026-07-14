/**
 * Credit-exchange constants
 *
 * Pricing system: 1 yuan = 1000 credits (i.e. 0.001 yuan/credit)
 * The wallet balance is stored in the backend `walletBalance` field, in units of "yuan"
 */

/** Number of credits per yuan */
export const CREDITS_PER_YUAN = 1000;

/** Minimum number of credits for a custom purchase */
export const MIN_CUSTOM_CREDITS = 100;

/** Unit price (yuan/credit) */
export const CREDIT_UNIT_PRICE = 1 / CREDITS_PER_YUAN;

/**
 * Convert a wallet balance (yuan) to credits.
 * @param balanceInYuan wallet balance, in yuan
 * @returns the corresponding credit count (rounded down to avoid over-displaying)
 */
export function balanceToCredits(balanceInYuan: number | undefined | null): number {
  if (balanceInYuan == null || balanceInYuan === 0) return 0;
  return Math.floor(balanceInYuan * CREDITS_PER_YUAN);
}
