'use strict';
// Token indexer — per-block CAT event detection.
//
// Detects three categories of events:
//   1. TibetSwap swaps + LP add/remove  — via per-block singleton tracking
//   2. Open Dexie offers (orderbook)     — polled every OFFER_POLL_MS
//   3. New tokens / new LP pairs         — when tibet-sync finds them they appear
//      automatically; this indexer wires up pair_coin_id tracking for new ones
//
// Transfers and burns require CLVM decoding and are not handled here.
//
// Standalone: node server/token-indexer.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');

const PROXY         = process.env.PROXY_URL || 'http://localhost:3001';
const TIBET_API     = 'https://api.v2.tibetswap.io';
const DEXIE_API     = 'https://api.dexie.space/v1';
const POLL_MS       = 30_000;          // block check interval
const BLOCK_BATCH   = 5;              // blocks per poll cycle
const OFFER_POLL_MS = 5 * 60_000;    // Dexie open-offer sync interval
const BFS_BATCH    = 50;              // parent_ids per RPC call during bootstrap
const BFS_DELAY_MS = 50;              // ms between BFS rounds

// Timeframes matching DB constraint in 026_token_indexer.sql
const TIMEFRAMES = ['1min', '15min', '1h', '4h', '1d', '1w', '1m', '3mo'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function nodeRpc(endpoint, body = {}) {
  const res = await fetch(`${PROXY}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`node RPC ${endpoint}: HTTP ${res.status}`);
  return res.json();
}

async function tibetGet(path) {
  const res = await fetch(`${TIBET_API}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tibet ${path}: HTTP ${res.status}`);
  return res.json();
}

// Chia coin ID = SHA256(parent || puzzle || amount_u64be)
function coinId(coin) {
  const parent = Buffer.from(coin.parent_coin_info.replace('0x', ''), 'hex');
  const puzzle = Buffer.from(coin.puzzle_hash.replace('0x', ''), 'hex');
  const amount = Buffer.allocUnsafe(8);
  amount.writeBigUInt64BE(BigInt(coin.amount));
  return crypto.createHash('sha256')
    .update(Buffer.concat([parent, puzzle, amount]))
    .digest('hex');
}

function hexNorm(h) {
  return (h || '').replace('0x', '').toLowerCase();
}

// ── In-memory pair state ──────────────────────────────────────────────────────
// Keyed by pair_coin_id so processBlock can match additions in O(1).

const pairByCurrentCoin = new Map(); // hex_coin_id → pair row
const pairByLauncher    = new Map(); // launcher_id  → pair row

// ── Pair state loading ────────────────────────────────────────────────────────

async function loadPairs(supabase) {
  const { data, error } = await supabase
    .from('tibet_pairs')
    .select('launcher_id, asset_id, xch_reserve, token_reserve, pair_coin_id, pair_coin_height');
  if (error) throw new Error(`loadPairs: ${error.message}`);

  pairByCurrentCoin.clear();
  pairByLauncher.clear();

  let tracked = 0;
  for (const pair of data || []) {
    pairByLauncher.set(pair.launcher_id, pair);
    if (pair.pair_coin_id) {
      pairByCurrentCoin.set(pair.pair_coin_id, pair);
      tracked++;
    }
  }
  console.log(`[token-idx] loaded ${data?.length || 0} pairs, ${tracked} with coin tracking`);
  return data?.length || 0;
}

// Initialize pair coin IDs from Tibet API — uses the `last_coin_id_on_chain` field
// that the /pairs endpoint returns for every pair. Completes in seconds.
async function initFromTibetApi(supabase) {
  const untracked = [...pairByLauncher.values()].filter(p => !p.pair_coin_id);
  if (!untracked.length) return;

  console.log(`[token-idx] seeding ${untracked.length} pair coin IDs from Tibet API…`);

  // Build a map: launcher_id (normalized) → Tibet pair row
  const tibetMap = new Map();
  let skip = 0;
  while (true) {
    try {
      const page = await tibetGet(`/pairs?skip=${skip}&limit=100`);
      const batch = Array.isArray(page) ? page : (page.pairs || []);
      if (!batch.length) break;
      for (const p of batch) {
        const id = hexNorm(p.launcher_id || p.pair_id || '');
        if (id && p.last_coin_id_on_chain) tibetMap.set(id, p);
      }
      if (batch.length < 100) break;
      skip += 100;
      await sleep(200);
    } catch (e) {
      console.warn(`[token-idx] Tibet API page error: ${e.message}`);
      break;
    }
  }

  let seeded = 0;
  for (const pair of untracked) {
    const norm = hexNorm(pair.launcher_id);
    const tibetPair = tibetMap.get(norm);
    const coinIdHex = tibetPair ? hexNorm(tibetPair.last_coin_id_on_chain) : null;
    if (!coinIdHex) continue;

    pair.pair_coin_id = coinIdHex;
    pairByCurrentCoin.set(coinIdHex, pair);
    seeded++;

    supabase.from('tibet_pairs')
      .update({ pair_coin_id: coinIdHex })
      .eq('launcher_id', pair.launcher_id)
      .then(() => {}).catch(() => {});
  }

  const remaining = untracked.length - seeded;
  console.log(`[token-idx] seeded ${seeded}/${untracked.length} pair coin IDs from Tibet API${remaining ? `, ${remaining} not found (no trades yet)` : ''}`);
}

// ── BFS fallback (kept for pairs absent from Tibet API) ───────────────────────
// Walks all singleton chains simultaneously, one generation per round.
// Only needed for pairs with no last_coin_id_on_chain in Tibet API response.
async function bfsInitAllPairs(supabase) {
  const untracked = [...pairByLauncher.values()].filter(p => !p.pair_coin_id);
  if (!untracked.length) return;

  // frontier: launcher_id → current frontier coin_id (starts as launcher_id itself)
  // All coin IDs normalized to lowercase hex without 0x prefix.
  const frontier = new Map();
  for (const pair of untracked) {
    const norm = hexNorm(pair.launcher_id); // strip 0x, lowercase
    frontier.set(pair.launcher_id, norm);
  }

  // Log a sample to verify format
  const sample = frontier.values().next().value;
  console.log(`[token-idx] sample launcher_id (normalized): ${sample?.slice(0, 16)}… length=${sample?.length}`);

  let round = 0;
  let found = 0;
  const total = frontier.size;
  console.log(`[token-idx] BFS bootstrap: walking ${total} pair chains…`);

  // Heartbeat: print progress every 30s regardless of round count
  const heartbeat = setInterval(() => {
    if (frontier.size > 0) {
      console.log(`[token-idx] bootstrap heartbeat — round ${round}, ${found}/${total} found, ${frontier.size} remaining`);
    }
  }, 30_000);

  while (frontier.size > 0) {
    round++;

    // Split frontier into chunks and fetch all in parallel
    const entries = [...frontier.entries()];
    const byParent = new Map(); // parent_hex → coin_record

    const chunks = [];
    for (let i = 0; i < entries.length; i += BFS_BATCH) {
      chunks.push(entries.slice(i, i + BFS_BATCH));
    }

    const fetchChunk = async (chunk, chunkIdx) => {
      const parentIds = chunk.map(([, p]) => p);
      try {
        const resp = await nodeRpc('get_coin_records_by_parent_ids', {
          parent_ids: parentIds,
          include_spent_coins: true,
        });
        if (round === 1 && chunkIdx === 0) {
          const count = resp?.coin_records?.length ?? 'undefined';
          console.log(`[token-idx] BFS round 1 response: keys=[${Object.keys(resp || {})}] coin_records=${count}`);
        }
        if (!resp?.success && resp?.error) {
          console.warn(`[token-idx] BFS RPC error (round ${round}): ${resp.error}`);
          return;
        }
        for (const cr of (resp?.coin_records || [])) {
          if (BigInt(cr.coin.amount) !== 1n) continue;
          byParent.set(hexNorm(cr.coin.parent_coin_info), cr);
        }
      } catch (e) {
        console.warn(`[token-idx] BFS round ${round} chunk ${chunkIdx} exception: ${e.message}`);
      }
    };

    await Promise.all(chunks.map((chunk, idx) => fetchChunk(chunk, idx)));

    const nextFrontier = new Map();
    const dbUpdates = [];

    for (const [launcherId, currentParent] of frontier) {
      const cr = byParent.get(hexNorm(currentParent)); // normalize before lookup
      if (!cr) continue; // pair not yet created, or RPC miss — skip this round

      const cid = coinId(cr.coin);
      if (!cr.spent) {
        // Found the unspent tip — register it
        const pair = pairByLauncher.get(launcherId);
        pair.pair_coin_id     = cid;
        pair.pair_coin_height = cr.confirmed_block_index;
        pairByCurrentCoin.set(cid, pair);
        frontier.delete(launcherId);
        found++;
        dbUpdates.push({ launcher_id: launcherId, cid, height: cr.confirmed_block_index });
      } else {
        // Follow to next generation
        nextFrontier.set(launcherId, cid);
      }
    }

    // Persist found coin IDs to DB in batch
    for (const { launcher_id, cid, height } of dbUpdates) {
      supabase.from('tibet_pairs')
        .update({ pair_coin_id: cid, pair_coin_height: height })
        .eq('launcher_id', launcher_id)
        .then(() => {}).catch(() => {});
    }

    // Update frontier in place
    for (const [k, v] of nextFrontier) frontier.set(k, v);
    // Remove entries that were found
    for (const { launcher_id } of dbUpdates) frontier.delete(launcher_id);

    if (dbUpdates.length > 0 || frontier.size === 0) {
      console.log(`[token-idx] bootstrap: ${found}/${total} found after ${round} rounds, ${frontier.size} remaining`);
    } else if (round % 100 === 0) {
      console.log(`[token-idx] bootstrap round ${round}: ${found}/${total} found, ${frontier.size} remaining`);
    }

    if (frontier.size > 0) await sleep(BFS_DELAY_MS);
  }

  clearInterval(heartbeat);
  console.log(`[token-idx] bootstrap complete: ${found}/${total} pair coin IDs found in ${round} rounds`);
}

// ── Event classification ──────────────────────────────────────────────────────

function classifyEvent(oldXch, oldToken, newXch, newToken) {
  const dx = newXch   - oldXch;
  const dt = newToken - oldToken;

  if (dx === 0 && dt === 0) return null; // no change (noise / reparse)

  if (dx > 0 && dt < 0) return { type: 'trade',     side: 'buy',    xchDelta: dx, tokenDelta: -dt };
  if (dx < 0 && dt > 0) return { type: 'trade',     side: 'sell',   xchDelta: -dx, tokenDelta: dt };
  if (dx > 0 && dt > 0) return { type: 'lp_add',    side: null,     xchDelta: dx, tokenDelta: dt };
  if (dx < 0 && dt < 0) return { type: 'lp_remove', side: null,     xchDelta: -dx, tokenDelta: -dt };
  return null;
}

// ── Event recording ───────────────────────────────────────────────────────────

async function recordEvent(supabase, pair, ev, blockHeight, blockTime) {
  // volume_xch in XCH (from mojos), amount_tokens in human units
  const volumeXch    = ev.xchDelta   / 1e12;
  const amountTokens = ev.tokenDelta / 1000;  // most CATs: 1000 mojos per unit
  const priceXch     = (ev.type === 'trade' && amountTokens > 0)
    ? volumeXch / amountTokens
    : null;

  await supabase.from('cat_transfers').insert({
    asset_id:       pair.asset_id,
    price_xch:      priceXch,
    amount_tokens:  amountTokens,
    volume_xch:     volumeXch,
    block_height:   blockHeight,
    transferred_at: blockTime || new Date().toISOString(),
    source:         'onchain',
    event_type:     ev.type,
  });
}

// ── Process a pair coin advance ───────────────────────────────────────────────

async function onPairCoinAdvanced(supabase, pair, newCoinId, blockHeight, blockTime) {
  // Fetch updated reserves from Tibet API
  let newXch   = pair.xch_reserve;
  let newToken = pair.token_reserve;

  try {
    const fresh = await tibetGet(`/pair/${pair.launcher_id}`);
    newXch   = Number(fresh.xch_reserve   ?? pair.xch_reserve);
    newToken = Number(fresh.token_reserve ?? pair.token_reserve);
  } catch (e) {
    console.warn(`[token-idx] Tibet API for ${pair.launcher_id.slice(0, 8)}: ${e.message}`);
  }

  const ev = classifyEvent(
    Number(pair.xch_reserve), Number(pair.token_reserve),
    newXch, newToken,
  );

  if (ev) {
    try {
      await recordEvent(supabase, pair, ev, blockHeight, blockTime);
    } catch (e) {
      console.warn(`[token-idx] recordEvent ${pair.asset_id?.slice(0, 8)}: ${e.message}`);
    }
  }

  // Update in-memory state
  pairByCurrentCoin.delete(pair.pair_coin_id);
  pair.pair_coin_id     = newCoinId;
  pair.xch_reserve      = newXch;
  pair.token_reserve    = newToken;
  pair.pair_coin_height = blockHeight;
  pairByCurrentCoin.set(newCoinId, pair);

  // Persist to DB
  await supabase.from('tibet_pairs').update({
    pair_coin_id:      newCoinId,
    pair_coin_height:  blockHeight,
    xch_reserve:       newXch,
    token_reserve:     newToken,
    current_price_xch: (newXch && newToken)
      ? (newXch / 1e12) / (newToken / 1000) : null,
    updated_at: new Date().toISOString(),
  }).eq('launcher_id', pair.launcher_id);

  // Rebuild OHLCV candles for trades
  if (ev?.type === 'trade') {
    const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
    rebuildCandles(supabase, pair.asset_id, since).catch(() => {});
  }

  return ev;
}

// ── Block processing ──────────────────────────────────────────────────────────

async function getHeaderHash(height) {
  const { block_record } = await nodeRpc('get_block_record_by_height', { height });
  return block_record?.header_hash || null;
}

async function processBlock(supabase, height) {
  const headerHash = await getHeaderHash(height);
  if (!headerHash) return 0;

  const { additions, removals } = await nodeRpc('get_additions_and_removals', {
    header_hash: headerHash,
  });

  if (!additions?.length) return 0;

  // Block timestamp (best-effort; fall back to now)
  let blockTime;
  try {
    const { block_record } = await nodeRpc('get_block_record_by_height', { height });
    const ts = block_record?.timestamp;
    blockTime = ts ? new Date(Number(ts) * 1000).toISOString() : new Date().toISOString();
  } catch {
    blockTime = new Date().toISOString();
  }

  let events = 0;

  // Check each singleton addition: if its parent matches a tracked pair coin → event
  for (const { coin } of additions) {
    if (BigInt(coin.amount) !== 1n) continue;

    const parent = hexNorm(coin.parent_coin_info);
    const pair   = pairByCurrentCoin.get(parent);
    if (!pair) continue;

    const newId = coinId(coin);
    try {
      const ev = await onPairCoinAdvanced(supabase, pair, newId, height, blockTime);
      if (ev) {
        events++;
        console.log(`[token-idx] h=${height} ${pair.asset_id?.slice(0, 8)} ${ev.type}${ev.side ? ` ${ev.side}` : ''} Δxch=${(ev.xchDelta / 1e12).toFixed(4)}`);
      }
    } catch (e) {
      console.warn(`[token-idx] onPairCoinAdvanced error: ${e.message}`);
    }
  }

  return events;
}

// ── OHLCV helpers (mirrors cat-sync.js) ──────────────────────────────────────

function toBucket(date, timeframe) {
  const d = new Date(date);
  switch (timeframe) {
    case '1min':  { d.setUTCSeconds(0, 0); return d; }
    case '15min': { d.setUTCSeconds(0, 0); d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15); return d; }
    case '1h':    { d.setUTCMinutes(0, 0, 0); return d; }
    case '4h':    { d.setUTCMinutes(0, 0, 0); d.setUTCHours(Math.floor(d.getUTCHours() / 4) * 4); return d; }
    case '1d':    { d.setUTCHours(0, 0, 0, 0); return d; }
    case '1w':    {
      d.setUTCHours(0, 0, 0, 0);
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
      return d;
    }
    case '1m':    { d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d; }
    case '3mo':   { d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3); return d; }
    default: return d;
  }
}

function rejectOutliers(prices) {
  if (prices.length < 6) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr === 0) return prices;
  const lo = q1 - 5 * iqr, hi = q3 + 5 * iqr;
  return prices.filter(p => p >= lo && p <= hi);
}

async function rebuildCandles(supabase, assetId, since) {
  const pad = new Date(new Date(since).getTime() - 7 * 86_400_000).toISOString();
  const trades = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('cat_transfers')
      .select('price_xch, volume_xch, transferred_at')
      .eq('asset_id', assetId)
      .not('price_xch', 'is', null)
      .gte('transferred_at', pad)
      .order('transferred_at', { ascending: true })
      .range(from, from + 999);
    if (error || !data?.length) break;
    trades.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  if (!trades.length) return;

  for (const timeframe of TIMEFRAMES) {
    const bucketMap = new Map();
    for (const t of trades) {
      const key = toBucket(t.transferred_at, timeframe).toISOString();
      if (!bucketMap.has(key)) bucketMap.set(key, { prices: [], volume: 0, count: 0 });
      const e = bucketMap.get(key);
      e.prices.push(Number(t.price_xch));
      e.volume += Number(t.volume_xch || 0);
      e.count++;
    }

    const rows = [];
    for (const key of [...bucketMap.keys()].sort()) {
      const { prices: raw, volume, count } = bucketMap.get(key);
      const prices = rejectOutliers(raw);
      if (!prices.length) continue;
      rows.push({
        asset_id: assetId, timeframe, bucket_start: key,
        open:        prices[0],
        high:        Math.max(...prices),
        low:         Math.min(...prices),
        close:       prices[prices.length - 1],
        volume_xch:  volume,
        trade_count: count,
        updated_at:  new Date().toISOString(),
      });
    }

    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from('cat_ohlcv')
        .upsert(rows.slice(i, i + 500), { onConflict: 'asset_id,timeframe,bucket_start' });
    }
  }
}

// ── Dexie open-offer sync ─────────────────────────────────────────────────────
// Syncs the open orderbook (status=1) for every tracked token into cat_offers.

async function syncOffersForToken(supabase, assetId) {
  let page = 1, synced = 0;
  const seen = new Set();

  while (true) {
    let data;
    try {
      const url = `${DEXIE_API}/offers?offered_or_requested=${assetId}&status=1&compact=true&page_size=50&page=${page}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) break;
      data = await res.json();
    } catch { break; }

    const offers = data.offers || [];
    if (!offers.length) break;

    const rows = [];
    for (const offer of offers) {
      if (!offer.id) continue;
      if (seen.has(offer.id)) continue;
      seen.add(offer.id);

      const off = offer.offered?.[0];
      const req = offer.requested?.[0];
      if (!off || !req) continue;

      const offId = (off.id || '').toLowerCase();
      const reqId = (req.id || '').toLowerCase();
      const aLow  = assetId.toLowerCase();

      let type, priceXch, amountTokens, volumeXch;

      if (offId === 'xch' && reqId === aLow) {
        // Buy order: offering XCH, wanting CAT
        type         = 'buy';
        amountTokens = Number(req.amount ?? 0);
        volumeXch    = Number(off.amount ?? 0);
        priceXch     = amountTokens > 0 ? volumeXch / amountTokens : null;
      } else if (offId === aLow && reqId === 'xch') {
        // Sell order: offering CAT, wanting XCH
        type         = 'sell';
        amountTokens = Number(off.amount ?? 0);
        volumeXch    = Number(req.amount ?? 0);
        priceXch     = amountTokens > 0 ? volumeXch / amountTokens : null;
      } else {
        continue;
      }

      // Price from Dexie override if available
      if (offer.price != null) {
        const raw = Number(offer.price);
        priceXch = type === 'buy' ? (raw > 0 ? 1 / raw : null) : raw;
      }

      rows.push({
        offer_id:      offer.id,
        asset_id:      assetId,
        offer_type:    type,
        price_xch:     priceXch,
        amount_tokens: amountTokens,
        volume_xch:    volumeXch,
        status:        'open',
        dexie_status:  1,
        created_at:    offer.date_found || new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      });
    }

    if (rows.length) {
      const { error } = await supabase.from('cat_offers')
        .upsert(rows, { onConflict: 'offer_id' });
      if (!error) synced += rows.length;
    }

    const total = data.count || 0;
    if (page * 50 >= total || offers.length < 50) break;
    page++;
    await sleep(100);
  }

  // Mark offers that disappeared from the orderbook as cancelled
  const { data: existing } = await supabase.from('cat_offers')
    .select('offer_id').eq('asset_id', assetId).eq('status', 'open');
  if (existing?.length) {
    const stale = existing.filter(r => !seen.has(r.offer_id)).map(r => r.offer_id);
    if (stale.length) {
      await supabase.from('cat_offers')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .in('offer_id', stale);
    }
  }

  return synced;
}

async function syncAllOffers(supabase) {
  const { data: tokens } = await supabase.from('cat_tokens').select('asset_id');
  if (!tokens?.length) return;

  let total = 0;
  for (const { asset_id } of tokens) {
    try { total += await syncOffersForToken(supabase, asset_id); } catch { /* skip */ }
    await sleep(200);
  }
  if (total > 0) console.log(`[token-idx] offers: synced ${total} open offers across ${tokens.length} tokens`);
}

// ── Dexie completed-offer backfill ────────────────────────────────────────────
// Inserts completed Dexie offers from the past 7 days into cat_transfers so
// sparklines have data even before on-chain events are detected. Runs once at
// startup; the UNIQUE(offer_id) constraint prevents duplicates on re-runs.

const BACKFILL_DAYS = 7;

async function backfillCompletedOffersForToken(supabase, assetId) {
  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
  let page = 1, inserted = 0;

  while (true) {
    let data;
    try {
      const url = `${DEXIE_API}/offers?offered_or_requested=${assetId}&status=4&page_size=50&page=${page}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) break;
      data = await res.json();
    } catch { break; }

    const offers = data.offers || [];
    if (!offers.length) break;

    const rows = [];
    let hitOld = false;
    for (const offer of offers) {
      const completedAt = offer.date_completed || offer.date_found;
      if (!completedAt || completedAt < since) { hitOld = true; break; }
      if (!offer.id) continue;

      const off = offer.offered?.[0];
      const req = offer.requested?.[0];
      if (!off || !req) continue;

      const offId = (off.id || '').toLowerCase();
      const reqId = (req.id || '').toLowerCase();
      const aLow  = assetId.toLowerCase();

      let priceXch, amountTokens, volumeXch;

      if (offId === 'xch' && reqId === aLow) {
        amountTokens = Number(req.amount ?? 0);
        volumeXch    = Number(off.amount ?? 0);
        priceXch     = amountTokens > 0 ? volumeXch / amountTokens : null;
        if (offer.price != null) {
          const raw = Number(offer.price);
          priceXch = raw > 0 ? 1 / raw : null;
        }
      } else if (offId === aLow && reqId === 'xch') {
        amountTokens = Number(off.amount ?? 0);
        volumeXch    = Number(req.amount ?? 0);
        priceXch     = amountTokens > 0 ? volumeXch / amountTokens : null;
        if (offer.price != null) priceXch = Number(offer.price);
      } else {
        continue; // not an XCH↔CAT pair
      }

      if (!priceXch || priceXch <= 0) continue;

      rows.push({
        offer_id:      offer.id,
        asset_id:      assetId,
        price_xch:     priceXch,
        amount_tokens: amountTokens / 1000,
        volume_xch:    volumeXch    / 1e12,
        transferred_at: completedAt,
        source:        'dexie',
        event_type:    'trade',
      });
    }

    if (rows.length) {
      const { error } = await supabase.from('cat_transfers')
        .upsert(rows, { onConflict: 'offer_id', ignoreDuplicates: true });
      if (!error) inserted += rows.length;
    }

    if (hitOld || offers.length < 50) break;
    page++;
  }

  return inserted;
}

async function backfillCompletedOffers(supabase) {
  const { data: tokens } = await supabase.from('cat_tokens').select('asset_id');
  if (!tokens?.length) return;

  let total = 0;
  for (const { asset_id } of tokens) {
    try {
      total += await backfillCompletedOffersForToken(supabase, asset_id);
    } catch { /* skip */ }
    await sleep(300);
  }
  if (total > 0) console.log(`[token-idx] backfill: ${total} completed offers → cat_transfers`);
}

// ── Main poll loop ────────────────────────────────────────────────────────────

let _supabase;
let lastHeight = 0;

async function loadLastHeight() {
  const { data } = await _supabase.from('token_indexer_state').select('last_height').eq('id', 1).single();
  return Number(data?.last_height || 0);
}

async function saveLastHeight(height) {
  await _supabase.from('token_indexer_state').upsert(
    { id: 1, last_height: height, updated_at: new Date().toISOString() },
    { onConflict: 'id' }
  );
}

async function poll() {
  try {
    const { blockchain_state } = await nodeRpc('get_blockchain_state', {});
    const peak = blockchain_state?.peak?.height;
    if (!peak) return;

    const from  = lastHeight || peak - 1;
    const upto  = Math.min(peak, from + BLOCK_BATCH);
    if (upto <= from) return;

    let totalEvents = 0;
    for (let h = from + 1; h <= upto; h++) {
      try {
        const n = await processBlock(_supabase, h);
        totalEvents += n;
      } catch (e) {
        console.warn(`[token-idx] block ${h}: ${e.message}`);
      }
    }

    lastHeight = upto;
    await saveLastHeight(upto);

    if (totalEvents > 0) console.log(`[token-idx] blocks ${from + 1}–${upto}: ${totalEvents} event(s)`);
  } catch (e) {
    console.warn(`[token-idx] poll error: ${e.message}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function start(supabase) {
  _supabase = supabase;
  console.log('[token-idx] starting');

  await loadPairs(supabase);
  lastHeight = await loadLastHeight();

  // Seed pair coin IDs: Tibet API first (seconds), BFS fallback for any misses
  initFromTibetApi(supabase).then(() =>
    bfsInitAllPairs(supabase)
  ).catch(e => console.warn('[token-idx] init error:', e.message));

  // Start block poll loop
  poll();
  const blockTimer = setInterval(poll, POLL_MS);

  // Start Dexie offer sync
  syncAllOffers(supabase).catch(e => console.warn('[token-idx] offers init error:', e.message));

  // Backfill last 7 days of completed Dexie offers → cat_transfers (for sparklines)
  backfillCompletedOffers(supabase).catch(e => console.warn('[token-idx] backfill error:', e.message));
  const offerTimer = setInterval(() => {
    syncAllOffers(supabase).catch(e => console.warn('[token-idx] offers error:', e.message));
  }, OFFER_POLL_MS);

  return { blockTimer, offerTimer };
}

module.exports = { start, loadPairs, processBlock, syncAllOffers, backfillCompletedOffers };

// ── Standalone ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const { createClient } = require('@supabase/supabase-js');
  const ws = require('ws');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { realtime: { transport: ws } }
  );

  start(supabase).catch(e => { console.error(e); process.exit(1); });

  process.on('SIGINT', () => { console.log('\n[token-idx] shutting down'); process.exit(0); });
}
