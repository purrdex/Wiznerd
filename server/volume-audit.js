'use strict';
// Volume audit — compares our DB dexie-source volume vs Dexie API exactly.
// Any nonzero delta is flagged. AMM/onchain shown separately.
//
// Usage:
//   node server/volume-audit.js              # all active tokens
//   node server/volume-audit.js <asset_id>   # single token
//   node server/volume-audit.js --days 7     # 7-day window

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const DEXIE_API = 'https://api.dexie.space/v1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n) { return Number(n).toFixed(4); }

// Fetch all Dexie completed offers for a token since `since`,
// return { vol, count, offers: [{id, xch, at}] }
async function dexieOffers(assetId, since) {
  let vol = 0, count = 0, offers = [], page = 1;
  while (true) {
    let data;
    try {
      const res = await fetch(
        `${DEXIE_API}/offers?offered_or_requested=${assetId}&status=4&compact=true&page_size=500&page=${page}`,
        { signal: AbortSignal.timeout(20000) }
      );
      data = await res.json();
    } catch (e) { console.error('  Dexie fetch error:', e.message); break; }

    const list = data.offers || [];
    let hitOld = false;
    for (const o of list) {
      if (o.date_completed < since) { hitOld = true; break; }
      const off = o.offered?.[0], req = o.requested?.[0];
      if (!off || !req) continue;
      const offId = (off.id || '').toLowerCase();
      const reqId = (req.id || '').toLowerCase();
      const aLow  = assetId.toLowerCase();
      let xch = 0;
      if (offId === aLow && reqId === 'xch')      xch = Number(req.amount || 0);
      else if (offId === 'xch' && reqId === aLow) xch = Number(off.amount || 0);
      else continue;
      vol += xch; count++; offers.push({ id: o.id, xch, at: o.date_completed });
    }
    if (hitOld || list.length < 500) break;
    page++;
    await sleep(200);
  }
  return { vol, count, offers };
}

// Fetch our DB rows for a token, return breakdown by source
async function dbRows(assetId, since) {
  const { data, error } = await supabase
    .from('cat_transfers')
    .select('offer_id, volume_xch, source, transferred_at')
    .eq('asset_id', assetId)
    .gte('transferred_at', since)
    .not('price_xch', 'is', null);

  if (error) throw new Error(error.message);

  const bySrc = {};
  for (const r of data || []) {
    const v = Number(r.volume_xch || 0);
    if (!bySrc[r.source]) bySrc[r.source] = { vol: 0, count: 0, rows: [] };
    bySrc[r.source].vol   += v;
    bySrc[r.source].count += 1;
    bySrc[r.source].rows.push(r);
  }
  return bySrc;
}

// Find DB dexie rows whose offer_id is NOT in the Dexie API set
function extraRows(dbDexie, apiSet) {
  return (dbDexie?.rows || []).filter(r => !apiSet.has(r.offer_id));
}

// Find Dexie API offers missing from our DB
function missingOffers(apiOffers, dbSet) {
  return apiOffers.filter(o => !dbSet.has(o.id));
}

async function auditToken(assetId, shortName, since) {
  const label = (shortName || assetId.slice(0, 8)).slice(0, 12);

  const [api, db] = await Promise.all([
    dexieOffers(assetId, since),
    dbRows(assetId, since),
  ]);

  const dexieSrc  = db['dexie']   || { vol: 0, count: 0, rows: [] };
  const onchainVol = (db['onchain']  || { vol: 0 }).vol;
  const ammVol     = (db['amm']      || { vol: 0 }).vol;
  const tibeVol    = (db['tibetapi'] || { vol: 0 }).vol;

  const apiSet = new Set(api.offers.map(o => o.id));
  // Map offer_id → Dexie XCH amount for per-row comparison
  const apiMap = new Map(api.offers.map(o => [o.id, o.xch]));
  const dbSet  = new Set(dexieSrc.rows.map(r => r.offer_id));

  const extras  = extraRows(dexieSrc, apiSet);
  const missing = missingOffers(api.offers, dbSet);

  const delta = dexieSrc.vol - api.vol;
  const extraVol   = extras.reduce((s, r) => s + Number(r.volume_xch || 0), 0);
  const missingVol = missing.reduce((s, o) => s + o.xch, 0);

  // Classify corrupted rows: our stored value is <1% of what Dexie says.
  // This catches the compact÷1e12 bug (e.g. 500 XCH → 5e-10) without
  // falsely flagging legitimate micro-trades (<0.001 XCH on cheap tokens).
  const corrupt = dexieSrc.rows.filter(r => {
    if (!r.offer_id) return false;
    const apiXch = apiMap.get(r.offer_id);
    if (!apiXch || apiXch <= 0) return false;
    const v = Number(r.volume_xch);
    return v > 0 && v < apiXch * 0.01; // stored value is <1% of truth
  });
  const corruptVol = corrupt.reduce((s, r) => s + Number(r.volume_xch), 0);

  const perfect = missing.length === 0 && corrupt.length === 0 && extras.length === 0;

  console.log(`\n${label} (${assetId.slice(0, 8)})`);
  console.log(`  Dexie API : ${fmt(api.vol)} XCH  (${api.count} offers)`);
  console.log(`  DB dexie  : ${fmt(dexieSrc.vol)} XCH  (${dexieSrc.count} rows)`);

  if (onchainVol || ammVol || tibeVol) {
    const extras2 = [
      onchainVol && `onchain +${fmt(onchainVol)}`,
      ammVol     && `amm +${fmt(ammVol)}`,
      tibeVol    && `tibetapi +${fmt(tibeVol)}`,
    ].filter(Boolean).join('  ');
    console.log(`  Other     : ${extras2}`);
  }

  if (perfect) {
    console.log('  ✓ exact match');
    return { ok: true };
  }

  // Report problems
  if (corrupt.length) {
    const trueVol = corrupt.reduce((s, r) => s + (apiMap.get(r.offer_id) || 0), 0);
    console.log(`  ✗ CORRUPT : ${corrupt.length} rows stored at <1% of true value (compact÷1e12 bug)`);
    console.log(`              stored ${fmt(corruptVol)} XCH  →  true ${fmt(trueVol)} XCH`);
    for (const r of corrupt.slice(0, 3)) {
      const api = apiMap.get(r.offer_id) || 0;
      console.log(`              ${r.offer_id?.slice(0, 32)}  stored=${r.volume_xch}  true=${fmt(api)}`);
    }
    if (corrupt.length > 3) console.log(`              ...and ${corrupt.length - 3} more`);
  }

  if (missing.length) {
    console.log(`  ✗ MISSING : ${missing.length} Dexie offers not in DB (${fmt(missingVol)} XCH)`);
    for (const o of missing.slice(0, 3)) {
      console.log(`              ${o.id?.slice(0, 32)}  ${fmt(o.xch)} XCH  ${o.at.slice(0, 16)}`);
    }
    if (missing.length > 3) console.log(`              ...and ${missing.length - 3} more`);
  }

  if (extras.length) {
    console.log(`  ⚠ EXTRA   : ${extras.length} DB rows not in Dexie API (${fmt(extraVol)} XCH)`);
    for (const r of extras.slice(0, 3)) {
      console.log(`              ${r.offer_id?.slice(0, 32)}  vol=${r.volume_xch}`);
    }
    if (extras.length > 3) console.log(`              ...and ${extras.length - 3} more`);
  }

  if (!corrupt.length && !missing.length && !extras.length && Math.abs(delta) > 0.0001) {
    console.log(`  ✗ DELTA   : DB=${fmt(dexieSrc.vol)}  API=${fmt(api.vol)}  diff=${fmt(delta)}`);
  }

  const isDeltaOnly = !corrupt.length && !missing.length && !extras.length;
  return { ok: false, corrupt: corrupt.length, missing: missing.length, extras: extras.length, deltaOnly: isDeltaOnly ? 1 : 0 };
}

async function main() {
  const args    = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days    = daysIdx !== -1 ? Number(args[daysIdx + 1]) : 1;
  const skipSet = new Set(daysIdx !== -1 ? [daysIdx, daysIdx + 1] : []);
  const singleId = args.find((a, i) => !a.startsWith('--') && !skipSet.has(i)) || null;

  const since = new Date(Date.now() - days * 86400000).toISOString();
  console.log(`Volume audit — ${days}d window (since ${since.slice(0, 16)} UTC)\n`);
  console.log('Compares DB dexie-source rows against Dexie API exactly.');
  console.log('CORRUPT = volume stored as near-zero (compact÷1e12 bug from old indexer)');
  console.log('MISSING = Dexie has the offer, our DB does not');
  console.log('EXTRA   = our DB has the row, Dexie API does not (on-chain P2P not via Dexie)');

  let tokens;
  if (singleId) {
    const { data } = await supabase.from('cat_tokens').select('asset_id, short_name').eq('asset_id', singleId).maybeSingle();
    tokens = [{ asset_id: singleId, short_name: data?.short_name || singleId.slice(0, 8) }];
  } else {
    const { data } = await supabase
      .from('cat_tokens')
      .select('asset_id, short_name')
      .gt('volume_24h_xch', 0)
      .order('volume_24h_xch', { ascending: false })
      .limit(100);
    tokens = data || [];
  }

  console.log(`\nChecking ${tokens.length} tokens...\n`);

  let okCount = 0, problemCount = 0;
  const typeCounts = { corrupt: 0, missing: 0, extras: 0, deltaOnly: 0 };

  for (const { asset_id, short_name } of tokens) {
    const result = await auditToken(asset_id, short_name, since);
    if (result.ok) {
      okCount++;
    } else {
      problemCount++;
      if (result.corrupt)   typeCounts.corrupt++;
      if (result.missing)   typeCounts.missing++;
      if (result.extras)    typeCounts.extras++;
      if (result.deltaOnly) typeCounts.deltaOnly++;
    }
    await sleep(400);
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✓ exact: ${okCount}   ✗ problems: ${problemCount}   total: ${tokens.length}`);

  if (problemCount) {
    console.log('\nProblem type breakdown (tokens affected):');
    if (typeCounts.corrupt)   console.log(`  CORRUPT   : ${typeCounts.corrupt} tokens — run: git pull + pm2 restart + node server/cat-backfill.js --fresh`);
    if (typeCounts.missing)   console.log(`  MISSING   : ${typeCounts.missing} tokens — run: node server/cat-backfill.js (upserts new/missing rows)`);
    if (typeCounts.extras)    console.log(`  EXTRA     : ${typeCounts.extras} tokens — DB has rows Dexie doesn't (stale offer_id or on-chain P2P)`);
    if (typeCounts.deltaOnly) console.log(`  DELTA ONLY: ${typeCounts.deltaOnly} tokens — vol totals differ despite matching offer_ids (rounding/FP or skipped 0-token offers)`);
    if (typeCounts.extras && !typeCounts.corrupt && !typeCounts.missing) {
      console.log('\n  EXTRA-only: fix by deleting corrupt near-zero rows in Supabase SQL editor:');
      console.log('    DELETE FROM cat_transfers WHERE source=\'dexie\' AND volume_xch > 0 AND volume_xch < 0.001;');
      console.log('  Then re-run: node server/cat-backfill.js');
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
