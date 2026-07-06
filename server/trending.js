'use strict';
// Trending score background job — recalculates every 15 minutes.
//
// Score formula:
//   mint_vol_24h  = mint_24h × floor_price        (primary market proxy)
//   total_vol_24h = secondary_vol_24h + mint_vol_24h
//   total_sales_24h = secondary_sales_24h + mint_24h
//   acceleration  = total_vol_24h / (vol_7d/7 + 1) (>1 = surging, <1 = cooling)
//   score         = total_vol_24h × sqrt(1 + acceleration) × log(1 + total_sales_24h)
//
// mint_24h is derived from indexed_nfts.updated_at in the last 24h:
//   the live indexer sets updated_at when it processes a new/transferred NFT,
//   so this captures newly minted items as well as active transfers.

const RECALC_MS = 15 * 60 * 1000;

function computeScore(vol24h, vol7d, sales24h, sales7d, mint24h, floorMojo) {
  // mint_24h excluded: indexed_nfts.updated_at fires on every re-index, not just new mints,
  // producing wildly inflated counts. Use secondary-market data only until we have created_at.
  void mint24h;
  if (vol7d === 0 && sales7d === 0) return 0;
  const floor = Number(floorMojo) || 0;
  // When today is quiet, use 7-day daily average so low-activity collections still rank.
  const effSales = sales24h > 0 ? sales24h : sales7d / 7;
  const effVol24 = vol24h   > 0 ? vol24h   : (sales24h > 0 ? sales24h * floor : vol7d / 7);
  const effVol7d = vol7d    > 0 ? vol7d    : effVol24 * 7;
  const baseline     = (effVol7d / 7) + 1;
  const acceleration = effVol24 / baseline;
  // If still no volume (no floor price), fall back to sales-only ranking.
  const volFactor = effVol24 > 0 ? effVol24 * Math.sqrt(1 + acceleration) : 1;
  return volFactor * Math.log(1 + effSales);
}

async function recalculate(supabase) {
  const now   = new Date();
  const ago24 = new Date(now - 86_400_000).toISOString();
  const ago7d = new Date(now - 7 * 86_400_000).toISOString();

  // ── 1. Aggregate 7-day transfers across all collections ─────────────────────
  const xferStats = new Map(); // collection_id → { vol24h, vol7d, sales24h, sales7d }

  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('nft_transfers')
      .select('collection_id, price_mojo, transferred_at')
      .gte('transferred_at', ago7d)
      .not('collection_id', 'is', null)
      .range(from, from + 999);
    if (error) { console.error('[trending] xfer fetch error:', error.message); break; }
    if (!data?.length) break;

    for (const r of data) {
      const id = r.collection_id;
      if (!xferStats.has(id)) xferStats.set(id, { vol24h: 0, vol7d: 0, sales24h: 0, sales7d: 0 });
      const s = xferStats.get(id);
      const is24h = r.transferred_at >= ago24;
      s.sales7d++;
      if (is24h) s.sales24h++;
      if (r.price_mojo != null) {
        s.vol7d += Number(r.price_mojo);
        if (is24h) s.vol24h += Number(r.price_mojo);
      }
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  // ── 2. Count active asks per collection (listed_count) ──────────────────────
  const listedCounts = new Map(); // collection_id → count

  from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('nft_offers')
      .select('nft_id')
      .eq('status', 'active')
      .eq('offer_type', 'ask')
      .range(from, from + 999);
    if (error) { console.error('[trending] offers fetch error:', error.message); break; }
    if (!data?.length) break;
    const nftIds = data.map(r => r.nft_id).filter(Boolean);
    if (nftIds.length) {
      const { data: nftRows } = await supabase
        .from('indexed_nfts').select('nft_id,collection_id').in('nft_id', nftIds);
      for (const n of nftRows || []) {
        if (n.collection_id) listedCounts.set(n.collection_id, (listedCounts.get(n.collection_id) || 0) + 1);
      }
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  // ── 3. Count recently active NFTs per collection (mint + transfer activity) ─
  const mintCounts = new Map(); // collection_id → count

  from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('indexed_nfts')
      .select('collection_id')
      .gte('updated_at', ago24)
      .not('collection_id', 'is', null)
      .range(from, from + 999);
    if (error) { console.error('[trending] nft fetch error:', error.message); break; }
    if (!data?.length) break;
    for (const r of data) mintCounts.set(r.collection_id, (mintCounts.get(r.collection_id) || 0) + 1);
    if (data.length < 1000) break;
    from += 1000;
  }

  // ── 4. Load all collections ──────────────────────────────────────────────────
  let collections = [];
  from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('indexed_collections')
      .select('collection_id, floor_price_mojo')
      .range(from, from + 999);
    if (error) { console.error('[trending] col fetch error:', error.message); break; }
    if (!data?.length) break;
    collections.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // ── 5. Compute scores ────────────────────────────────────────────────────────
  const updates = collections.map(col => {
    const id   = col.collection_id;
    const s    = xferStats.get(id) || { vol24h: 0, vol7d: 0, sales24h: 0, sales7d: 0 };
    const mint = mintCounts.get(id) || 0;
    return {
      collection_id:   id,
      trending_score:  computeScore(s.vol24h, s.vol7d, s.sales24h, s.sales7d, mint, col.floor_price_mojo),
      volume_24h_mojo: s.vol24h,
      volume_7d_mojo:  s.vol7d,
      sales_24h:       s.sales24h,
      sales_7d:        s.sales7d,
      mint_24h:        mint,
      listed_count:    listedCounts.get(id) || 0,
    };
  });

  // ── 6. Batch upsert ──────────────────────────────────────────────────────────
  let written = 0;
  for (let i = 0; i < updates.length; i += 200) {
    const batch = updates.slice(i, i + 200);
    const { error } = await supabase
      .from('indexed_collections')
      .upsert(batch, { onConflict: 'collection_id' });
    if (error) console.error('[trending] upsert error:', error.message);
    else written += batch.length;
  }

  const active = updates.filter(u => u.trending_score > 0).length;
  console.log(`[trending] updated ${written} collections · ${active} with score > 0`);
}

// ── Hourly floor price snapshot ───────────────────────────────────────────────

const SNAPSHOT_MS = 60 * 60 * 1000; // 1 hour

async function snapshotFloors(supabase) {
  const { data: cols } = await supabase
    .from('indexed_collections')
    .select('collection_id,floor_price_mojo')
    .not('floor_price_mojo', 'is', null)
    .gt('floor_price_mojo', 0);

  if (!cols?.length) return;

  const rows = cols.map(c => ({
    collection_id:   c.collection_id,
    floor_price_mojo: c.floor_price_mojo,
    snapshot_at:     new Date().toISOString(),
  }));

  // Insert in batches of 200
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('floor_snapshots').insert(rows.slice(i, i + 200));
    if (error) console.warn('[floors] snapshot error:', error.message);
  }
  console.log(`[floors] snapshotted ${rows.length} floor prices`);
}

function start(supabase) {
  console.log('[trending] starting score job (15 min interval)');
  recalculate(supabase).catch(e => console.error('[trending] initial run error:', e.message));

  // Take an initial floor snapshot, then every hour
  snapshotFloors(supabase).catch(e => console.warn('[floors] initial snapshot error:', e.message));
  setInterval(() => {
    snapshotFloors(supabase).catch(e => console.warn('[floors] snapshot error:', e.message));
  }, SNAPSHOT_MS);

  return setInterval(() => {
    recalculate(supabase).catch(e => console.error('[trending] recalc error:', e.message));
  }, RECALC_MS);
}

module.exports = { start, recalculate, snapshotFloors };

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const { createClient } = require('@supabase/supabase-js');
  const ws = require('ws');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
  recalculate(supabase)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
