'use strict';
// Volume audit — compares our DB 24h volume vs Dexie API for every token in cat_tokens.
// Flags tokens where our volume is <50% or >200% of what Dexie reports.
//
// Usage:
//   node server/volume-audit.js              # all tokens
//   node server/volume-audit.js <asset_id>   # single token
//   node server/volume-audit.js --days 7     # 7-day window instead of 24h

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const DEXIE_API = 'https://api.dexie.space/v1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function dexieVolume(assetId, since) {
  let vol = 0, page = 1, done = false;
  while (!done) {
    let data;
    try {
      const res = await fetch(`${DEXIE_API}/offers?offered_or_requested=${assetId}&status=4&compact=true&page_size=500&page=${page}`, {
        signal: AbortSignal.timeout(20000),
      });
      data = await res.json();
    } catch { break; }

    const offers = data.offers || [];
    if (!offers.length) break;

    for (const o of offers) {
      if (o.date_completed < since) { done = true; break; }
      const off = o.offered?.[0], req = o.requested?.[0];
      if (!off || !req) continue;
      const offId = (off.id || '').toLowerCase();
      const reqId = (req.id || '').toLowerCase();
      const aLow  = assetId.toLowerCase();
      if (offId === aLow && reqId === 'xch')      vol += Number(req.amount || 0);
      else if (offId === 'xch' && reqId === aLow) vol += Number(off.amount || 0);
    }

    if (done || offers.length < 500) break;
    page++;
    await sleep(200);
  }
  return vol;
}

async function dbVolume(assetId, since) {
  const { data } = await supabase
    .from('cat_transfers')
    .select('volume_xch, source')
    .eq('asset_id', assetId)
    .gte('transferred_at', since)
    .not('price_xch', 'is', null);

  const bySrc = {};
  let total = 0;
  for (const r of data || []) {
    const v = Number(r.volume_xch || 0);
    bySrc[r.source] = (bySrc[r.source] || 0) + v;
    total += v;
  }
  return { total, bySrc };
}

async function main() {
  const args    = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days    = daysIdx !== -1 ? Number(args[daysIdx + 1]) : 1;
  const skipSet = new Set(daysIdx !== -1 ? [daysIdx, daysIdx + 1] : []);
  const singleId = args.find((a, i) => !a.startsWith('--') && !skipSet.has(i)) || null;

  const since = new Date(Date.now() - days * 86400000).toISOString();
  console.log(`\nVolume audit — ${days}d window (since ${since.slice(0, 16)})\n`);

  let tokens;
  if (singleId) {
    const { data } = await supabase.from('cat_tokens').select('asset_id, short_name').eq('asset_id', singleId).maybeSingle();
    tokens = [{ asset_id: singleId, short_name: data?.short_name || singleId.slice(0, 8) }];
  } else {
    // Only audit tokens with >0 volume so we don't hammer Dexie for dead tokens
    const { data } = await supabase
      .from('cat_tokens')
      .select('asset_id, short_name')
      .gt('volume_24h_xch', 0)
      .order('volume_24h_xch', { ascending: false })
      .limit(100);
    tokens = data || [];
  }

  console.log(`Checking ${tokens.length} tokens...\n`);
  console.log(
    'Token'.padEnd(14) +
    'DB total'.padStart(12) +
    'Dexie API'.padStart(12) +
    'Ratio'.padStart(8) +
    '  Status'
  );
  console.log('─'.repeat(60));

  let okCount = 0, warnCount = 0, missingCount = 0;

  for (const { asset_id, short_name } of tokens) {
    const label = (short_name || asset_id.slice(0, 8)).slice(0, 12);
    const [dex, db] = await Promise.all([
      dexieVolume(asset_id, since),
      dbVolume(asset_id, since),
    ]);

    const ratio  = dex > 0 ? db.total / dex : (db.total > 0 ? Infinity : 1);
    const pct    = dex > 0 ? `${(ratio * 100).toFixed(0)}%` : 'N/A';
    let status;

    if (dex === 0 && db.total === 0) {
      status = '  ✓ no activity';
    } else if (dex === 0 && db.total > 0) {
      status = '  ℹ DB only (on-chain/AMM)';
    } else if (db.total === 0 && dex > 0) {
      status = '  ✗ MISSING — DB has 0, Dexie has ' + dex.toFixed(2);
      missingCount++;
    } else if (ratio < 0.5) {
      status = '  ✗ UNDER by ' + ((1 - ratio) * 100).toFixed(0) + '%';
      warnCount++;
    } else if (ratio > 2.5) {
      status = '  ⚠ OVER by ' + ((ratio - 1) * 100).toFixed(0) + '%';
      warnCount++;
    } else {
      status = '  ✓ ok';
      okCount++;
    }

    const srcSummary = Object.entries(db.bySrc)
      .map(([s, v]) => `${s}=${v.toFixed(1)}`)
      .join(' ');

    console.log(
      label.padEnd(14) +
      db.total.toFixed(2).padStart(12) +
      dex.toFixed(2).padStart(12) +
      pct.padStart(8) +
      status
    );
    if (srcSummary) console.log('              ' + srcSummary);

    await sleep(350);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`✓ ok: ${okCount}  ✗ warn/missing: ${warnCount + missingCount}  total: ${tokens.length}`);
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
