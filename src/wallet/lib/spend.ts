/**
 * spend.ts — XCH send types (actual sends go through walletRpc in App.tsx)
 */

export interface SpendBundleResult {
  success: boolean;
  txId?: string;
  error?: string;
}
