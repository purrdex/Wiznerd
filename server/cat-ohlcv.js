'use strict';
// OHLCV candle builder for CAT tokens.
// Reads cat_transfers, aggregates into 1h/4h/1d/1w/1m buckets,
// upserts into cat_ohlcv.
//
// Usage:
//   node server/cat-ohlcv.js                  # rebuild all tokens, all timeframes
//   node server/cat-ohlcv.js <asset_id>       # single token
//   node server/cat-ohlcv.js --since 2026-01-01  # only rebuild recent candles

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

const TIMEFRAMES = ['1h', '4h', '1d', '1w', '1m'];

// ── Bucket helpers ────────────────────────────────────────────────────────────

function toBucket(date, timeframe) {
  const d = new Date(date);
  switch (timeframe) {
    case '1h': {
      d.setUTCMinutes(0, 0, 0);
      return d;
    }
    case '4h': {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(Math.floor(d.getUTCHours() / 4) * 4);
      return d;
    }
    case '1d': {
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case '1w': {
      // Monday-aligned weeks
      d.setUTCHours(0, 0, 0, 0);
      const day = d.getUTCDay(); // 0=Sun
      const diff = (day === 0) ? -6 : 1 - day;
      d.setUTCDate(d.getUTCDate() + diff);
      return d;
    }
    case '1m': {
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
  }
}

// ── Outlier rejection using IQR ───────────────────────────────────────────────
// Removes prices more than 5 IQRs from Q1/Q3. Handles sparse data gracefully.

function rejectOutliers(trades) {
  if (trades.length < 6) return trades; // too few points to filter meaningfully
  const sorted = [...trades].map(t => t.price).sort((a, b) => a - b);
  const q1  = sorted[Math.floor(sorted.length * 0.25)];
  const q3  = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr === 0) return trades; // all same price — nothing to filter
  const lo = q1 - 5 * iqr;
  const hi = q3 + 5 * iqr;
  return trades.filter(t => t.price >= lo && t.price <= hi);
}

// ── Build candles for one token + timeframe ───────────────────────────────────

async function buildCandles(assetId, timeframe, sinceDate) {
  // Fetch all qualifying trades, newest first for close price detection
  let query = supabase
    .from('cat_transfers')
    .select('price_xch, volume_xch, transferred_at')
    .eq('asset_id', assetId)
    .not('price_xch', 'is', null)
    .order('transferred_at', { ascending: true });

  if (sinceDate) {
    // Rebuild candles from a few buckets before sinceDate for clean edges
    const pad = new Date(sinceDate);
    pad.setUTCDate(pad.getUTCDate() - 7);
    query = query.gte('transferred_at', pad.toISOString());
  }

  const { data: trades, error } = await query;
  if (error) throw error;
  if (!trades?.length) return 0;

  // Reject statistical outliers before building candles
  const allPoints = trades.map(t => ({ ...t, price: Number(t.price_xch) }));
  const filtered  = rejectOutliers(allPoints);

  // Group by bucket
  const bucketMap = new Map();
  for (const trade of filtered) {
    const bucket = toBucket(trade.transferred_at, timeframe);
    const key = bucket.toISOString();
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { bucket, prices: [], volume: 0, count: 0 });
    }
    const entry = bucketMap.get(key);
    entry.prices.push(trade.price);
    entry.volume += Number(trade.volume_xch || 0);
    entry.count++;
  }

  // Build OHLCV rows
  const rows = [];
  const sortedKeys = [...bucketMap.keys()].sort();
  for (const key of sortedKeys) {
    const { bucket, prices, volume, count } = bucketMap.get(key);
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

  // Upsert in batches
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error: e } = await supabase.from('cat_ohlcv')
      .upsert(batch, { onConflict: 'asset_id,timeframe,bucket_start' });
    if (e) console.error(`  ohlcv upsert error (${timeframe}): ${e.message}`);
    else inserted += batch.length;
  }

  return inserted;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args      = process.argv.slice(2);
  const sinceIdx  = args.indexOf('--since');
  const sinceDate = sinceIdx !== -1 ? args[sinceIdx + 1] : null;
  const skipNext  = new Set(sinceIdx !== -1 ? [sinceIdx + 1] : []);
  const singleId  = args.find((a, i) => !a.startsWith('--') && !skipNext.has(i)) || null;

  let tokens;
  if (singleId) {
    tokens = [singleId];
  } else {
    const { data, error } = await supabase
      .from('cat_tokens').select('asset_id').order('asset_id');
    if (error) { console.error('Supabase error:', error.message); process.exit(1); }
    tokens = (data || []).map(t => t.asset_id);
  }

  console.log(`\nOHLCV builder — ${tokens.length} token(s) × ${TIMEFRAMES.length} timeframes\n`);

  let totalCandles = 0;
  for (let i = 0; i < tokens.length; i++) {
    const assetId = tokens[i];
    for (const tf of TIMEFRAMES) {
      const count = await buildCandles(assetId, tf, sinceDate);
      totalCandles += count;
    }
    process.stdout.write(`\r  ${i + 1}/${tokens.length} tokens processed…`);
  }

  process.stdout.write('\n');
  console.log(`\n✓ ${totalCandles} candles built/updated.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
