/**
 * cats.ts — Chia Asset Token (CAT v2 + CAT v1 legacy) discovery and balance
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from './utils';

export const CAT_MOD_HASH = '37bef360ee858133b69d595a906dc45d01af50379dad515eb9518abb7c1d2a7a';
// CAT v1 (original, sunset — some legacy tokens may still exist on-chain)
const CAT1_MOD_HASH = '72dec062874cd4d3aab892a0906688a1ae412b0109982e1797a170add88bdcdc';
function proxyBase(): string { return 'https://wiznerd.fun/proxy'; }

export interface CatCoin {
  coinId: string;
  parentCoinInfo: string;
  puzzleHash: string;
  amount: number;
  confirmedBlockIndex: number;
  assetId: string;
  innerPuzzleHash: string;     // P2 puzzle hash (= hint used to discover this coin)
  parentPuzzleReveal: string;  // hex of parent coin's outer puzzle (for lineage proof)
  isGenesis: boolean;          // true if parent is NOT a CAT coin (eve/issuance spend)
  isCat1: boolean;             // true if discovered via a CAT v1 parent puzzle
}

export interface CatBalance {
  assetId: string;
  name: string;
  ticker: string;
  logoUrl?: string;
  priceUsd: number;
  totalMojo: bigint;
  coins: CatCoin[];
  isCat1: boolean;  // true if all coins are CAT v1 legacy tokens (sends not supported)
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

export async function getCatCoinsByHint(nodeUrl: string, puzzleHashHexList: string[], includeSpent = false): Promise<{ puzzleHashHex: string; coins: any[] }[]> {
  const results = await Promise.allSettled(
    puzzleHashHexList.map(async (phHex) => {
      const hint = phHex.startsWith('0x') ? phHex : `0x${phHex}`;
      const data = await rpc<{ coin_records: any[] }>(nodeUrl, 'get_coin_records_by_hint', { hint, include_spent_coins: includeSpent });
      return { puzzleHashHex: phHex, coins: data.coin_records || [] };
    })
  );
  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map(r => r.value).filter(r => r.coins.length > 0);
}

const PUZZLE_CACHE_KEY = 'chia_puzzle_cache';

function loadPuzzleCache(): Record<string, { puzzleReveal: string; solution: string }> {
  try { return JSON.parse(localStorage.getItem(PUZZLE_CACHE_KEY) || '{}'); }
  catch { return {}; }
}

let puzzleCache = loadPuzzleCache();

const PUZZLE_CACHE_MAX = 500;

function savePuzzleCache(): void {
  try {
    const keys = Object.keys(puzzleCache);
    if (keys.length > PUZZLE_CACHE_MAX) {
      // Keep the most recently-added entries (Object.keys preserves insertion order)
      const toRemove = keys.slice(0, keys.length - PUZZLE_CACHE_MAX);
      for (const k of toRemove) delete puzzleCache[k];
    }
    localStorage.setItem(PUZZLE_CACHE_KEY, JSON.stringify(puzzleCache));
  } catch { /* storage full — skip silently; in-memory cache still works */ }
}

export async function getPuzzleAndSolution(nodeUrl: string, coinId: string, height: number): Promise<{ puzzleReveal: string; solution: string } | null> {
  const key = coinId.startsWith('0x') ? coinId.slice(2) : coinId;
  if (puzzleCache[key]) return puzzleCache[key];
  try {
    const data = await rpc<{ coin_solution: any }>(nodeUrl, 'get_puzzle_and_solution',
      { coin_id: `0x${key}`, height });
    const result = { puzzleReveal: data.coin_solution.puzzle_reveal, solution: data.coin_solution.solution };
    puzzleCache[key] = result;
    savePuzzleCache();
    return result;
  } catch { return null; }
}

// Returns { assetId, isCat1 } if the puzzle is a CAT (v1 or v2) outer puzzle, else null.
function extractCatInfo(puzzleRevealHex: string): { assetId: string; isCat1: boolean } | null {
  try {
    const puzzleHex = puzzleRevealHex.startsWith('0x') ? puzzleRevealHex.slice(2) : puzzleRevealHex;
    for (const [modHash, isCat1] of [[CAT_MOD_HASH, false], [CAT1_MOD_HASH, true]] as const) {
      const idx = puzzleHex.indexOf(modHash);
      if (idx === -1) continue;
      const m = puzzleHex.slice(idx + modHash.length).match(/a0([0-9a-f]{64})/i);
      if (m) return { assetId: m[1], isCat1 };
    }
    return null;
  } catch { return null; }
}

export function extractAssetIdFromPuzzleReveal(puzzleRevealHex: string): string | null {
  return extractCatInfo(puzzleRevealHex)?.assetId ?? null;
}

// ── SHA256 tree hash helpers (mirrors keys.ts but avoids importing @noble/curves) ──
// Used to compute CAT2 outer puzzle hash for genesis-coin brute-force discovery.
const _Q = hexToBytes('9dcf97a184f32623d11a73124ceb99a5709b083721e878a16d78f596718ba7b2');
const _A = hexToBytes('a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222');
const _C = hexToBytes('a8d5dd63fba471ebcb1f3e8f7c1e1879b7152a6e7298a91ce119a63400ade7c5');
const _NIL = hexToBytes('4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a');
const _ONE = hexToBytes('9dcf97a184f32623d11a73124ceb99a5709b083721e878a16d78f596718ba7b2');
const CAT_MOD_HASH_BYTES = hexToBytes(CAT_MOD_HASH);
// sha256tree(q . CAT_MOD) = shPair(sha256tree(q), sha256tree(CAT_MOD))
const _HASH_OF_QUOTED_CAT_MOD = (() => {
  const d = new Uint8Array(65); d[0] = 0x02; d.set(_Q, 1); d.set(CAT_MOD_HASH_BYTES, 33);
  return sha256(d);
})();

function _shAtom(b: Uint8Array): Uint8Array {
  const d = new Uint8Array(1 + b.length); d[0] = 0x01; d.set(b, 1); return sha256(d);
}
function _shPair(l: Uint8Array, r: Uint8Array): Uint8Array {
  const d = new Uint8Array(65); d[0] = 0x02; d.set(l, 1); d.set(r, 33); return sha256(d);
}
function _curriedArgs(args: Uint8Array[]): Uint8Array {
  if (args.length === 0) return _ONE;
  return _shPair(_C, _shPair(_shPair(_Q, args[0]), _shPair(_curriedArgs(args.slice(1)), _NIL)));
}

// Compute the expected outer puzzle hash for a CAT2 coin at innerPh with given assetId.
export function catOuterPuzzleHash(innerPh: Uint8Array, assetId: Uint8Array): Uint8Array {
  const argHashes = [_shAtom(CAT_MOD_HASH_BYTES), _shAtom(assetId), innerPh];
  return _shPair(_A, _shPair(_HASH_OF_QUOTED_CAT_MOD, _shPair(_curriedArgs(argHashes), _NIL)));
}

// ── Dexie full token-list cache (for genesis coin fallback) ──────────────────
const DEXIE_IDS_KEY = 'chia_dexie_asset_ids';
const DEXIE_IDS_TTL = 24 * 60 * 60 * 1000;

async function fetchAllDexieAssetIds(): Promise<string[]> {
  try {
    const raw = localStorage.getItem(DEXIE_IDS_KEY);
    if (raw) {
      const { ids, time } = JSON.parse(raw) as { ids: string[]; time: number };
      if (Date.now() - time < DEXIE_IDS_TTL && ids.length > 0) return ids;
    }
  } catch { /* ignore */ }
  try {
    const res = await fetch(`${proxyBase()}/dexie/tokens`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.assetIds) && data.assetIds.length > 0) {
        localStorage.setItem(DEXIE_IDS_KEY, JSON.stringify({ ids: data.assetIds, time: Date.now() }));
        return data.assetIds as string[];
      }
    }
  } catch { /* fall through */ }
  return [];
}

// puzzle_hash → assetId cache so we don't brute-force on every refresh
const PH_ASSET_KEY = 'chia_ph_asset_map';
const PH_ASSET_MAX = 2000;
let phAssetCache: Record<string, string> = {};
try { phAssetCache = JSON.parse(localStorage.getItem(PH_ASSET_KEY) || '{}'); } catch {}
function savePHAssetCache() {
  try {
    const keys = Object.keys(phAssetCache);
    if (keys.length > PH_ASSET_MAX) {
      const toRemove = keys.slice(0, keys.length - PH_ASSET_MAX);
      for (const k of toRemove) delete phAssetCache[k];
    }
    localStorage.setItem(PH_ASSET_KEY, JSON.stringify(phAssetCache));
  } catch {}
}

// For genesis/eve coins whose parent is NOT a CAT, infer assetId by testing the
// coin's own outer puzzle hash against every known Dexie asset ID.
async function findAssetIdByPuzzleHash(coinPuzzleHash: string, innerPh: string): Promise<string | null> {
  const outerPh = coinPuzzleHash.startsWith('0x') ? coinPuzzleHash.slice(2) : coinPuzzleHash;
  if (phAssetCache[outerPh]) return phAssetCache[outerPh];
  const innerPhBytes = hexToBytes(innerPh);
  const assetIds = await fetchAllDexieAssetIds();
  for (const assetId of assetIds) {
    if (bytesToHex(catOuterPuzzleHash(innerPhBytes, hexToBytes(assetId))) === outerPh) {
      phAssetCache[outerPh] = assetId;
      savePHAssetCache();
      return assetId;
    }
  }
  return null;
}

// Look up assetId from an outer CAT puzzle hash using the persisted phAssetCache.
// Returns null if unknown (coin was fully spent and not in the discovery cache).
export function resolveOuterPuzzleHash(outerPh: string): string | null {
  const ph = outerPh.replace('0x', '').toLowerCase();
  return phAssetCache[ph] ?? null;
}

// ── Custom / pinned token asset IDs (user-specified, scanned by outer puzzle hash) ──
export const CUSTOM_TOKENS_KEY = 'chia_custom_tokens';
export function loadCustomAssetIds(): string[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_TOKENS_KEY) || '[]'); } catch { return []; }
}
export function saveCustomAssetIds(ids: string[]): void {
  try { localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(ids)); } catch {}
}

async function getCatCoinsByOuterPh(nodeUrl: string, outerPh: string): Promise<any[]> {
  try {
    const ph = outerPh.startsWith('0x') ? outerPh : `0x${outerPh}`;
    const data = await rpc<{ coin_records: any[] }>(nodeUrl, 'get_coin_records_by_puzzle_hash',
      { puzzle_hash: ph, include_spent_coins: false });
    return data.coin_records || [];
  } catch { return []; }
}

// Minimal-length big-endian encoding matching chia_rs Coin::name() — strips leading
// zeros but preserves a leading 0x00 if the first remaining byte has its high bit set.
function coinAmountToBytes(amount: number): Uint8Array {
  if (amount === 0) return new Uint8Array(0);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(Math.round(amount)));
  const bytes = new Uint8Array(buf);
  let start = 0;
  while (start < 7 && bytes[start] === 0 && (bytes[start + 1] & 0x80) === 0) start++;
  const result = bytes.slice(start);
  if (result.length > 0 && (result[0] & 0x80)) {
    const padded = new Uint8Array(result.length + 1);
    padded.set(result, 1);
    return padded;
  }
  return result;
}

export async function calculateCoinId(parentCoinInfo: string, puzzleHash: string, amount: number): Promise<string> {
  const parent = hexToBytes(parentCoinInfo.startsWith('0x') ? parentCoinInfo.slice(2) : parentCoinInfo);
  const puzzle = hexToBytes(puzzleHash.startsWith('0x') ? puzzleHash.slice(2) : puzzleHash);
  const amountBytes = coinAmountToBytes(amount);
  const combined = new Uint8Array(parent.length + puzzle.length + amountBytes.length);
  combined.set(parent); combined.set(puzzle, parent.length); combined.set(amountBytes, parent.length + puzzle.length);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', combined)));
}

const META_CACHE_KEY = 'chia_cat_meta_cache';

function loadMetadataCache(): Record<string, TokenMetadata> {
  try { return JSON.parse(sessionStorage.getItem(META_CACHE_KEY) || '{}'); }
  catch { return {}; }
}

let metadataCache: Record<string, TokenMetadata> = loadMetadataCache();

function saveMetadataCache(): void {
  try { sessionStorage.setItem(META_CACHE_KEY, JSON.stringify(metadataCache)); }
  catch { /* storage full — continue without persisting */ }
}

export async function getTokenMetadata(assetId: string): Promise<TokenMetadata> {
  if (metadataCache[assetId]) return metadataCache[assetId];
  try {
    const response = await fetch(`${proxyBase()}/taildatabase/${assetId}`, { signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const data = await response.json();
      if (data?.name) {
        const meta: TokenMetadata = {
          name: data.name,
          ticker: data.code || data.symbol || assetId.slice(0, 6).toUpperCase(),
          logoUrl: data.logo_url || data.icon_url || `${proxyBase()}/logo/${assetId}`,
        };
        metadataCache[assetId] = meta;
        saveMetadataCache();
        return meta;
      }
    }
  } catch { /* fall through */ }
  const fallback: TokenMetadata = {
    name: `CAT ${assetId.slice(0, 8).toUpperCase()}`,
    ticker: assetId.slice(0, 4).toUpperCase(),
    logoUrl: `${proxyBase()}/logo/${assetId}`,
  };
  metadataCache[assetId] = fallback;
  saveMetadataCache();
  return fallback;
}

// ─── CAT price — per token via Spacescan ────────────────────────────────────
const priceCache: Record<string, { price: number; time: number }> = {};

export async function getCatPriceUsd(assetId: string, xchPriceUsd: number): Promise<number> {
  const cached = priceCache[assetId];
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.price;
  try {
    const res = await fetch(`${proxyBase()}/price/cat/${assetId}`, { signal: AbortSignal.timeout(8000) });
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
    const res = await fetch(`${proxyBase()}/price/xch`, { signal: AbortSignal.timeout(6000) });
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
    hintResults.flatMap(({ puzzleHashHex, coins }) =>
      coins.map(async (coinRecord: any) => {
        const coin = coinRecord.coin;
        const parentId = coin.parent_coin_info.startsWith('0x') ? coin.parent_coin_info.slice(2) : coin.parent_coin_info;
        const parentSpend = await getPuzzleAndSolution(nodeUrl, parentId, coinRecord.confirmed_block_index);

        let assetId: string | null = null;
        let isCat1 = false;
        let isGenesis = false;

        if (parentSpend) {
          const info = extractCatInfo(parentSpend.puzzleReveal);
          if (info) {
            assetId = info.assetId;
            isCat1 = info.isCat1;
          } else {
            // Parent is not a CAT (genesis/eve coin) — brute-force via outer puzzle hash
            assetId = await findAssetIdByPuzzleHash(coin.puzzle_hash, puzzleHashHex);
            isGenesis = true;
          }
        } else {
          // getPuzzleAndSolution failed — try genesis brute-force as last resort
          assetId = await findAssetIdByPuzzleHash(coin.puzzle_hash, puzzleHashHex);
          isGenesis = true;
        }

        if (!assetId) return;

        const coinId = await calculateCoinId(coin.parent_coin_info, coin.puzzle_hash, coin.amount);
        catCoins.push({
          coinId, parentCoinInfo: coin.parent_coin_info, puzzleHash: coin.puzzle_hash,
          amount: coin.amount, confirmedBlockIndex: coinRecord.confirmed_block_index, assetId,
          innerPuzzleHash: puzzleHashHex,
          parentPuzzleReveal: parentSpend?.puzzleReveal ?? '',
          isGenesis, isCat1,
        });
      })
    )
  );

  // ── Custom token scan: look up user-pinned asset IDs by outer puzzle hash ──
  // Works for any CAT2 coin regardless of hints or parent type.
  const customAssetIds = loadCustomAssetIds();
  if (customAssetIds.length > 0) {
    const existingIds = new Set(catCoins.map(c => c.coinId));
    await Promise.allSettled(
      customAssetIds.flatMap(assetId =>
        puzzleHashHexList.map(async innerPh => {
          const outerPh = bytesToHex(catOuterPuzzleHash(hexToBytes(innerPh), hexToBytes(assetId)));
          const coinRecords = await getCatCoinsByOuterPh(nodeUrl, outerPh);
          for (const coinRecord of coinRecords) {
            const coin = coinRecord.coin;
            const coinId = await calculateCoinId(coin.parent_coin_info, coin.puzzle_hash, coin.amount);
            if (existingIds.has(coinId)) continue;
            existingIds.add(coinId);
            // Try to get parent puzzle for proper lineage proof (helps sends)
            const parentId = coin.parent_coin_info.startsWith('0x')
              ? coin.parent_coin_info.slice(2) : coin.parent_coin_info;
            const parentSpend = await getPuzzleAndSolution(nodeUrl, parentId, coinRecord.confirmed_block_index);
            const info = parentSpend ? extractCatInfo(parentSpend.puzzleReveal) : null;
            catCoins.push({
              coinId, parentCoinInfo: coin.parent_coin_info, puzzleHash: coin.puzzle_hash,
              amount: coin.amount, confirmedBlockIndex: coinRecord.confirmed_block_index,
              assetId, innerPuzzleHash: innerPh,
              parentPuzzleReveal: parentSpend?.puzzleReveal ?? '',
              isGenesis: !info, isCat1: info?.isCat1 ?? false,
            });
          }
        })
      )
    );
  }

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
      const isCat1 = coins.every(c => c.isCat1);
      return { assetId, name: meta.name, ticker: meta.ticker, logoUrl: meta.logoUrl, priceUsd, totalMojo, coins, isCat1 };
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