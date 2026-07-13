'use strict';
// Tibet LP pair sync — fetches all pairs from Tibet API, upserts into
// tibet_pairs and cat_tokens tables. Also records an lp_snapshot per pair.
//
// Usage:
//   node server/tibet-sync.js          # sync all pairs + snapshot
//   node server/tibet-sync.js --pairs  # pairs only (no snapshots)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const TIBET_API  = 'https://api.v2.tibetswap.io';
const DEXIE_API  = 'https://api.dexie.space';
const DEXIE_ICON = 'https://icons.dexie.space';
const PAGE_LIMIT = 100;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tibetGet(path) {
  const res = await fetch(`${TIBET_API}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tibet API ${path}: HTTP ${res.status}`);
  return res.json();
}

async function fetchAllPairs() {
  const pairs = [];
  let skip = 0;
  while (true) {
    const page = await tibetGet(`/pairs?skip=${skip}&limit=${PAGE_LIMIT}`);
    const batch = Array.isArray(page) ? page : (page.pairs || []);
    if (!batch.length) break;
    pairs.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    skip += PAGE_LIMIT;
    await sleep(300);
  }
  return pairs;
}

// Compute current XCH price per token from reserves.
// xch_reserve is in mojos (1e12 per XCH), token_reserve is in token mojos.
// Most CATs use 1000 mojos per token unit; XCH uses 1e12. We normalize to
// "XCH per 1000 token-mojos" which equals XCH per human-readable token for
// most CATs. Charts will note units.
function computePrice(xchReserve, tokenReserve) {
  if (!xchReserve || !tokenReserve) return null;
  // XCH per token-unit (1000 mojos = 1 token for most CATs)
  const xch = Number(xchReserve) / 1e12;
  const tokens = Number(tokenReserve) / 1000;
  if (!tokens) return null;
  return xch / tokens;
}

async function fetchDexieTokenMap() {
  try {
    const res = await fetch(`${DEXIE_API}/v1/tokens`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = data.tokens || data || [];
    const map = {};
    for (const t of list) {
      const id = (t.id || t.asset_id || '').toLowerCase();
      if (id) map[id] = t;
    }
    return map;
  } catch (e) {
    console.warn('[tibet-sync] Dexie token list failed:', e.message);
    return {};
  }
}

async function enrichTokens(supabase) {
  console.log('[tibet-sync] enriching cat_tokens from Dexie…');
  const dexieMap = await fetchDexieTokenMap();
  const total = Object.keys(dexieMap).length;
  if (!total) { console.log('[tibet-sync] no Dexie tokens to enrich from'); return; }

  const { data: tokens } = await supabase.from('cat_tokens').select('asset_id, name');
  if (!tokens?.length) return;

  let updated = 0;
  for (const token of tokens) {
    const d = dexieMap[token.asset_id.toLowerCase()];
    if (!d) continue;
    const name      = d.name || d.asset_name || null;
    const shortName = d.code || d.symbol || d.ticker || null;
    const imageUrl  = `${DEXIE_ICON}/${token.asset_id}.webp`;
    if (!name && !shortName) continue;
    const { error } = await supabase.from('cat_tokens').update({
      name:       name      || token.name,
      short_name: shortName || null,
      image_url:  imageUrl,
      updated_at: new Date().toISOString(),
    }).eq('asset_id', token.asset_id);
    if (!error) updated++;
  }
  console.log(`[tibet-sync] ✓ enriched ${updated}/${tokens.length} tokens from Dexie`);
}

async function main() {
  const args = process.argv.slice(2);
  const pairsOnly = args.includes('--pairs');

  console.log('[tibet-sync] fetching pairs from Tibet API…');
  let pairs;
  try {
    pairs = await fetchAllPairs();
  } catch (e) {
    console.error('[tibet-sync] fetch error:', e.message);
    process.exit(1);
  }
  console.log(`[tibet-sync] got ${pairs.length} pairs`);

  let upsertedTokens = 0;
  let upsertedPairs  = 0;
  let snapshots      = 0;
  const now = new Date().toISOString();

  for (const pair of pairs) {
    const launcherId   = pair.launcher_id   || pair.pair_id;
    const assetId      = pair.asset_id;
    const name         = pair.name          || pair.token_name || null;
    const shortName    = pair.short_name    || pair.ticker     || null;
    const imageUrl     = pair.image_url     || pair.logo_url   || null;
    const xchReserve   = Number(pair.xch_reserve   || 0);
    const tokenReserve = Number(pair.token_reserve || 0);
    const liquidity    = Number(pair.liquidity      || 0);
    const feeRate      = pair.fee           != null ? Number(pair.fee) : 0.007;
    const pairCoinId   = pair.last_coin_id_on_chain || null;

    if (!launcherId || !assetId) continue;

    const currentPrice = computePrice(xchReserve, tokenReserve);

    // Upsert cat_tokens (ignore if already exists with richer data)
    const { error: tokErr } = await supabase.from('cat_tokens').upsert({
      asset_id:      assetId,
      name:          name,
      short_name:    shortName,
      image_url:     imageUrl,
      tibet_pair_id: launcherId,
      updated_at:    now,
    }, { onConflict: 'asset_id' });
    if (tokErr) console.error(`  token upsert ${assetId.slice(0,8)}: ${tokErr.message}`);
    else upsertedTokens++;

    // Upsert tibet_pairs
    const pairRow = {
      launcher_id:       launcherId,
      asset_id:          assetId,
      xch_reserve:       xchReserve,
      token_reserve:     tokenReserve,
      liquidity:         liquidity,
      fee_rate:          feeRate,
      current_price_xch: currentPrice,
      updated_at:        now,
    };
    if (pairCoinId) pairRow.pair_coin_id = pairCoinId;
    const { error: pairErr } = await supabase.from('tibet_pairs').upsert(pairRow, { onConflict: 'launcher_id' });
    if (pairErr) console.error(`  pair upsert ${launcherId.slice(0,8)}: ${pairErr.message}`);
    else upsertedPairs++;

    // Record LP snapshot (skip if --pairs only)
    if (!pairsOnly && xchReserve > 0) {
      const { error: snapErr } = await supabase.from('lp_snapshots').upsert({
        launcher_id:   launcherId,
        xch_reserve:   xchReserve,
        token_reserve: tokenReserve,
        price_xch:     currentPrice,
        snapped_at:    now,
      }, { onConflict: 'launcher_id,snapped_at' });
      if (!snapErr) snapshots++;
    }

    process.stdout.write(`\r  ${upsertedPairs}/${pairs.length} pairs synced…`);
  }

  process.stdout.write('\n');
  console.log(`[tibet-sync] ✓ ${upsertedTokens} tokens, ${upsertedPairs} pairs, ${snapshots} snapshots`);

  if (!pairsOnly) await enrichTokens(supabase);
}

main().catch(e => { console.error('[tibet-sync] fatal:', e); process.exit(1); });
