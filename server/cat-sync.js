'use strict';
// CAT trade sync — background job that runs every 30 minutes.
// Fetches recent completed offers from Dexie for all tokens in cat_tokens,
// inserts new rows into cat_transfers, then rebuilds OHLCV candles for any
// token that received new trades.
//
// Standalone: node server/cat-sync.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const SYNC_MS    = 30 * 60 * 1000;    // 30 minutes
const LOOKBACK_MS = 2 * 86_400_000;   // 2-day window for Dexie queries
const DEXIE_API   = 'https://api.dexie.space/v1';
const PAGE_SIZE   = 200;
const TIMEFRAMES  = ['1min', '15min', '1h', '4h', '1d', '1w', '1m', '3mo'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Dexie offer → cat_transfer row ───────────────────────────────────────────

function parseOffer(offer, assetId) {
  const off = offer.offered?.[0];
  const req = offer.requested?.[0];
  if (!off || !req) return null;

  const offId    = (off.id || '').toLowerCase();
  const reqId    = (req.id || '').toLowerCase();
  const assetLow = assetId.toLowerCase();

  let xchAmount = null, tokenAmount = null, priceXch = null;

  if (offId === assetLow && reqId === 'xch') {
    tokenAmount = off.amount != null ? Number(off.amount) : null;
    xchAmount   = req.amount != null ? Number(req.amount) : null;
    priceXch    = offer.price != null ? Number(offer.price) : null;
  } else if (offId === 'xch' && reqId === assetLow) {
    tokenAmount = req.amount != null ? Number(req.amount) : null;
    xchAmount   = off.amount != null ? Number(off.amount) : null;
    const raw   = offer.price != null ? Number(offer.price) : null;
    priceXch    = raw != null && raw > 0 ? 1 / raw : null;
  } else {
    return null; // CAT-CAT or unrelated
  }

  if (priceXch == null && tokenAmount && xchAmount) {
    priceXch = tokenAmount > 0 ? xchAmount / tokenAmount : null;
  }

  return {
    asset_id:       assetId,
    offer_id:       offer.id || null,
    price_xch:      priceXch,
    amount_tokens:  tokenAmount,
    volume_xch:     xchAmount,
    block_height:   offer.spent_block_index || null,
    transferred_at: offer.date_completed || new Date().toISOString(),
    source:         'dexie',
  };
}

// ── OHLCV helpers (mirrors cat-ohlcv.js) ─────────────────────────────────────

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
  const q1  = sorted[Math.floor(sorted.length * 0.25)];
  const q3  = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr === 0) return prices;
  const lo = q1 - 5 * iqr, hi = q3 + 5 * iqr;
  return prices.filter(p => p >= lo && p <= hi);
}

async function rebuildCandles(supabase, assetId, since) {
  // Load trades from a bit before `since` so partially-completed candles merge correctly
  const pad = new Date(new Date(since).getTime() - 7 * 86_400_000).toISOString();

  const allTrades = [];
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
    allTrades.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  if (!allTrades.length) return 0;

  let totalCandles = 0;
  for (const timeframe of TIMEFRAMES) {
    const bucketMap = new Map();
    for (const trade of allTrades) {
      const bucket = toBucket(trade.transferred_at, timeframe);
      const key    = bucket.toISOString();
      if (!bucketMap.has(key)) bucketMap.set(key, { bucket, prices: [], volume: 0, count: 0 });
      const e = bucketMap.get(key);
      e.prices.push(Number(trade.price_xch));
      e.volume += Number(trade.volume_xch || 0);
      e.count++;
    }

    const rows = [];
    for (const key of [...bucketMap.keys()].sort()) {
      const { bucket, prices: raw, volume, count } = bucketMap.get(key);
      const prices = rejectOutliers(raw);
      if (!prices.length) continue;
      rows.push({
        asset_id:     assetId,
        timeframe,
        bucket_start: bucket.toISOString(),
        open:         prices[0],
        high:         Math.max(...prices),
        low:          Math.min(...prices),
        close:        prices[prices.length - 1],
        volume_xch:   volume,
        trade_count:  count,
        updated_at:   new Date().toISOString(),
      });
    }

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('cat_ohlcv')
        .upsert(rows.slice(i, i + 500), { onConflict: 'asset_id,timeframe,bucket_start' });
      if (!error) totalCandles += Math.min(500, rows.length - i);
    }
  }
  return totalCandles;
}

// ── Sync one token ────────────────────────────────────────────────────────────

async function syncToken(supabase, assetId, since) {
  let inserted = 0;
  const seen   = new Set();

  let firstPage;
  try {
    const url = `${DEXIE_API}/offers?offered_or_requested=${assetId}&status=4&compact=true&page_size=${PAGE_SIZE}&page=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return 0;
    firstPage = await res.json();
  } catch { return 0; }

  const totalPages = Math.ceil((firstPage.count || 0) / PAGE_SIZE);

  async function processPage(pageData) {
    const rows = [];
    let hitCutoff = false;
    for (const offer of pageData.offers || []) {
      // Dexie returns newest-first; stop once we pass the lookback window
      if (offer.date_completed && offer.date_completed < since) { hitCutoff = true; break; }
      const row = parseOffer(offer, assetId);
      if (!row || !row.price_xch) continue;
      const key = row.offer_id || `${assetId}:${row.block_height}:${row.transferred_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }

    if (rows.length) {
      // Batch insert; fall back to row-by-row on unique constraint violation
      const { error } = await supabase.from('cat_transfers').insert(rows);
      if (!error) {
        inserted += rows.length;
      } else if (error.code === '23505' || error.message?.includes('unique') || error.message?.includes('duplicate')) {
        for (const row of rows) {
          const { error: e2 } = await supabase.from('cat_transfers').insert(row);
          if (!e2) inserted++;
        }
      } else {
        console.warn(`[cat-sync] insert error (${assetId.slice(0, 8)}): ${error.message}`);
      }
    }

    return hitCutoff;
  }

  const done = await processPage(firstPage);
  if (!done) {
    for (let p = 2; p <= totalPages; p++) {
      await sleep(250);
      try {
        const url = `${DEXIE_API}/offers?offered_or_requested=${assetId}&status=4&compact=true&page_size=${PAGE_SIZE}&page=${p}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) break;
        const pageData = await res.json();
        const stop = await processPage(pageData);
        if (stop) break;
      } catch { break; }
    }
  }

  return inserted;
}

// ── Main sync loop ────────────────────────────────────────────────────────────

async function syncAll(supabase) {
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();

  const { data: tokens, error } = await supabase
    .from('cat_tokens').select('asset_id, short_name').order('asset_id');
  if (error || !tokens?.length) return;

  const updatedTokens = [];

  for (const { asset_id, short_name } of tokens) {
    try {
      const n = await syncToken(supabase, asset_id, since);
      if (n > 0) {
        updatedTokens.push(asset_id);
        console.log(`[cat-sync] ${(short_name || asset_id).slice(0, 12).padEnd(12)} +${n} trades`);
      }
    } catch (e) {
      console.warn(`[cat-sync] ${asset_id.slice(0, 8)}: ${e.message}`);
    }
    await sleep(150);
  }

  // Rebuild OHLCV candles for tokens that got new trades
  for (const assetId of updatedTokens) {
    try {
      const n = await rebuildCandles(supabase, assetId, since);
      if (n > 0) console.log(`[cat-sync] rebuilt ${n} candles for ${assetId.slice(0, 12)}`);
    } catch (e) {
      console.warn(`[cat-sync] candle rebuild ${assetId.slice(0, 8)}: ${e.message}`);
    }
  }

  if (updatedTokens.length) {
    console.log(`[cat-sync] done — ${updatedTokens.length} token(s) updated`);
  }
}

// ── Entry points ──────────────────────────────────────────────────────────────

function start(supabase) {
  console.log('[cat-sync] starting (30 min interval)');
  syncAll(supabase).catch(e => console.error('[cat-sync] initial run error:', e.message));
  return setInterval(() => {
    syncAll(supabase).catch(e => console.error('[cat-sync] error:', e.message));
  }, SYNC_MS);
}

module.exports = { start, syncAll };

if (require.main === module) {
  const { createClient } = require('@supabase/supabase-js');
  const ws = require('ws');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { realtime: { transport: ws } }
  );
  syncAll(supabase)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
