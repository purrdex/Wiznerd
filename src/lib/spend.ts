/**
 * spend.ts — Send XCH via Chia wallet RPC
 *
 * Routes through the wallet daemon (port 9256) which handles
 * coin selection, key derivation, and BLS signing correctly.
 */

const PROXY_BASE = 'http://localhost:3001';

export interface SpendBundleResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export interface SendParams {
  toAddress: string;
  amountMojo: bigint;
  feeMojo: bigint;
  nodeUrl: string; // kept for API compatibility
}

export function selectCoins(_coins: any[], _target: bigint): any[] {
  return _coins; // no-op, wallet RPC handles coin selection
}

export async function sendXch(params: SendParams): Promise<SpendBundleResult> {
  const { toAddress, amountMojo, feeMojo } = params;

  try {
    const response = await fetch(`${PROXY_BASE}/wallet/send_transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_id: 1,
        address: toAddress,
        amount: Number(amountMojo),
        fee: Number(feeMojo),
        wait_for_confirmation: false,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await response.json();

    if (data.success) {
      const txId = data.transaction_id || data.transaction?.name || 'submitted';
      return { success: true, txId };
    } else {
      return { success: false, error: data.error || 'Transaction failed' };
    }
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}