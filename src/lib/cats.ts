/**
 * cats.ts — Chia Asset Token (CAT v2) discovery and balance
 */

import { bytesToHex, hexToBytes } from './utils';

export const CAT_MOD_HASH = '37bef360ee858133b69d595a906dc45d01af50379dad515eb9518abb7c1d2a7a';
const PROXY_BASE = 'http://localhost:3001';

export interface CatCoin {
  coinId: string;
  parentCoinInfo: string;
  puzzleHash: string;
  amount: number;
  confirmedBlockIndex: number;
  assetId: string;
}

export interface CatBalance {
  assetId: string;
  name: string;
  ticker: string;
  logoUrl?: string;
  priceUsd: number;
  totalMojo: bigint;
  coins: CatCoin[];
}

export interface TokenMetadata {
  name: string;
  ticker: string;
  logoUrl?: string;
}

async function rpc<T>(nodeUrl: string, endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  const url = `${nodeUrl.replace(/\/$/, '')}/${endpoint}`;
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RPC ${endpoint} failed: ${response.status}`);
  const data = await response.json();
  if (!data.success) throw new Error(`RPC error: ${JSON.stringify(data.error || data)}`);
  return data as T;
}

export async function getCatCoinsByHint(nodeUrl: string, puzzleHashHexList: string[]): Promise<{ puzzleHashHex: string; coins: any[] }[]> {
  const results = await Promise.allSettled(
    puzzleHashHexList.map(async (phHex) => {
      const hint = phHex.startsWith('0x') ? phHex : `0x${phHex}`;
      const data = await rpc<{ coin_records: any[] }>(nodeUrl, 'get_coin_records_by_hint', { hint, include_spent_coins: false });
      return { puzzleHashHex: phHex, coins: data.coin_records || [] };
    })
  );
  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map(r => r.value).filter(r => r.coins.length > 0);
}

export async function getPuzzleAndSolution(nodeUrl: string, coinId: string, height: number): Promise<{ puzzleReveal: string; solution: string } | null> {
  try {
    const data = await rpc<{ coin_solution: any }>(nodeUrl, 'get_puzzle_and_solution',
      { coin_id: coinId.startsWith('0x') ? coinId : `0x${coinId}`, height });
    return { puzzleReveal: data.coin_solution.puzzle_reveal, solution: data.coin_solution.solution };
  } catch { return null; }
}

export function extractAssetIdFromPuzzleReveal(puzzleRevealHex: string): string | null {
  try {
    const puzzleHex = puzzleRevealHex.startsWith('0x') ? puzzleRevealHex.slice(2) : puzzleRevealHex;
    const idx = puzzleHex.indexOf(CAT_MOD_HASH);
    if (idx === -1) return null;
    const atomMatch = puzzleHex.slice(idx + CAT_MOD_HASH.length).match(/a0([0-9a-f]{64})/i);
    return atomMatch ? atomMatch[1] : null;
  } catch { return null; }
}

export async function calculateCoinId(parentCoinInfo: string, puzzleHash: string, amount: number): Promise<string> {
  const parent = hexToBytes(parentCoinInfo.startsWith('0x') ? parentCoinInfo.slice(2) : parentCoinInfo);
  const puzzle = hexToBytes(puzzleHash.startsWith('0x') ? puzzleHash.slice(2) : puzzleHash);
  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setUint32(4, amount);
  const combined = new Uint8Array(parent.length + puzzle.length + 8);
  combined.set(parent); combined.set(puzzle, parent.length); combined.set(amountBytes, parent.length + puzzle.length);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', combined)));
}

let metadataCache: Record<string, TokenMetadata> = {};

export async function getTokenMetadata(assetId: string): Promise<TokenMetadata> {
  if (metadataCache[assetId]) return metadataCache[assetId];
  try {
    const response = await fetch(`${PROXY_BASE}/taildatabase/${assetId}`, { signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const data = await response.json();
      if (data?.name) {
        const meta: TokenMetadata = {
          name: data.name,
          ticker: data.code || data.symbol || assetId.slice(0, 6).toUpperCase(),
          logoUrl: data.logo_url || data.icon_url || `${PROXY_BASE}/logo/${assetId}`,
        };
        metadataCache[assetId] = meta;
        return meta;
      }
    }
  } catch { /* fall through */ }
  const fallback: TokenMetadata = {
    name: `CAT ${assetId.slice(0, 8).toUpperCase()}`,
    ticker: assetId.slice(0, 4).toUpperCase(),
    logoUrl: `${PROXY_BASE}/logo/${assetId}`,
  };
  metadataCache[assetId] = fallback;
  return fallback;
}

// ─── CAT price — per token via Spacescan ────────────────────────────────────
const priceCache: Record<string, { price: number; time: number }> = {};

export async function getCatPriceUsd(assetId: string, xchPriceUsd: number): Promise<number> {
  const cached = priceCache[assetId];
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.price;
  try {
    const res = await fetch(`${PROXY_BASE}/price/cat/${assetId}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      // Dexie returns price_xch (XCH per token), convert to USD
      let priceUsd = 0;
      if (data.price_usd > 0) {
        priceUsd = data.price_usd;
      } else if (data.price_xch > 0 && xchPriceUsd > 0) {
        priceUsd = data.price_xch * xchPriceUsd;
      }
      priceCache[assetId] = { price: priceUsd, time: Date.now() };
      return priceUsd;
    }
  } catch { /* fall through */ }
  return 0;
}

// ─── XCH price ──────────────────────────────────────────────────────────────
export async function fetchXchPrice(): Promise<number> {
  try {
    const res = await fetch(`${PROXY_BASE}/price/xch`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.price === 'number' && data.price > 0) return data.price;
    }
  } catch { /* fall through */ }
  return 0;
}

// ─── Main: get all CAT balances ──────────────────────────────────────────────
export async function getCatBalances(nodeUrl: string, puzzleHashHexList: string[], xchPriceUsd = 0): Promise<CatBalance[]> {
  const hintResults = await getCatCoinsByHint(nodeUrl, puzzleHashHexList);
  if (hintResults.length === 0) return [];

  const catCoins: CatCoin[] = [];
  await Promise.allSettled(
    hintResults.flatMap(({ coins }) =>
      coins.map(async (coinRecord: any) => {
        const coin = coinRecord.coin;
        const parentId = coin.parent_coin_info.startsWith('0x') ? coin.parent_coin_info.slice(2) : coin.parent_coin_info;
        const parentSpend = await getPuzzleAndSolution(nodeUrl, parentId, coinRecord.confirmed_block_index);
        if (!parentSpend) return;
        const assetId = extractAssetIdFromPuzzleReveal(parentSpend.puzzleReveal);
        if (!assetId) return;
        const coinId = await calculateCoinId(coin.parent_coin_info, coin.puzzle_hash, coin.amount);
        catCoins.push({ coinId, parentCoinInfo: coin.parent_coin_info, puzzleHash: coin.puzzle_hash,
          amount: coin.amount, confirmedBlockIndex: coinRecord.confirmed_block_index, assetId });
      })
    )
  );

  if (catCoins.length === 0) return [];

  const byAsset: Record<string, CatCoin[]> = {};
  for (const coin of catCoins) {
    if (!byAsset[coin.assetId]) byAsset[coin.assetId] = [];
    byAsset[coin.assetId].push(coin);
  }

  const balances = await Promise.all(
    Object.entries(byAsset).map(async ([assetId, coins]) => {
      const [meta, priceUsd] = await Promise.all([
        getTokenMetadata(assetId),
        getCatPriceUsd(assetId, xchPriceUsd),
      ]);
      const totalMojo = coins.reduce((sum, c) => sum + BigInt(c.amount), BigInt(0));
      return { assetId, name: meta.name, ticker: meta.ticker, logoUrl: meta.logoUrl, priceUsd, totalMojo, coins };
    })
  );

  return balances.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
}

export function formatCatAmount(mojo: bigint, decimals = 3): string {
  const amount = Number(mojo) / 1000;
  return amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

export function formatCatUsdValue(mojo: bigint, usdPrice: number): string {
  const amount = Number(mojo) / 1000;
  const usdValue = amount * usdPrice;
  if (usdValue === 0) return '';
  if (usdValue < 0.01) return `$${usdValue.toFixed(6)}`;
  if (usdValue < 1) return `$${usdValue.toFixed(4)}`;
  return `$${usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}