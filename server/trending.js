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

const RECALC_MS = 60 * 60 * 1000; // hourly — 15 min was too frequent and caused Supabase statement timeouts

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

  // ── 1–3: DB-side aggregation (replaces four paginated JS loops) ──────────────
  const [statsResult, mintResult, listedResult, colResult] = await Promise.all([
    supabase.rpc('get_collection_stats',        { since_7d: ago7d, since_24h: ago24 }),
    supabase.rpc('get_collection_mint_counts',  { since_24h: ago24 }),
    supabase.rpc('get_collection_listed_counts'),
    supabase.from('indexed_collections').select('collection_id, floor_price_mojo'),
  ]);

  if (statsResult.error)  console.error('[trending] stats rpc error:',  statsResult.error.message);
  if (mintResult.error)   console.error('[trending] mint rpc error:',   mintResult.error.message);
  if (listedResult.error) console.error('[trending] listed rpc error:', listedResult.error.message);
  if (colResult.error)    console.error('[trending] col fetch error:',  colResult.error.message);

  const xferStats   = new Map();
  const mintCounts  = new Map();
  const listedCounts = new Map();

  for (const r of statsResult.data || []) {
    xferStats.set(r.collection_id, {
      vol24h:   Number(r.vol_24h  || 0),
      vol7d:    Number(r.vol_7d   || 0),
      sales24h: Number(r.sales_24h || 0),
      sales7d:  Number(r.sales_7d  || 0),
    });
  }
  for (const r of mintResult.data   || []) mintCounts.set(r.collection_id,   Number(r.mint_count   || 0));
  for (const r of listedResult.data || []) listedCounts.set(r.collection_id, Number(r.listed_count || 0));

  // ── 4. Collections ───────────────────────────────────────────────────────────
  const collections = colResult.data || [];

  // ── 5. Compute scores ────────────────────────────────────────────────────────
  // Only update collections that have activity in our DB — this prevents zeroing
  // out volume/sales stats that were populated from external sources (MintGarden etc.)
  // for collections our nft_transfers table doesn't yet cover.
  const activeCollectionIds = new Set([...xferStats.keys(), ...mintCounts.keys()]);

  const updates = collections
    .filter(col => activeCollectionIds.has(col.collection_id) || listedCounts.has(col.collection_id))
    .map(col => {
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

// ── Expire stale offers and collection bids ───────────────────────────────────

const EXPIRE_MS = 5 * 60 * 1000; // every 5 minutes

async function expireOffers(supabase) {
  const now = new Date().toISOString();
  const [{ error: e1 }, { error: e2 }] = await Promise.all([
    supabase.from('nft_offers')
      .update({ status: 'expired' })
      .eq('status', 'open')
      .lt('expires_at', now),
    supabase.from('collection_bids')
      .update({ status: 'expired' })
      .eq('status', 'open')
      .lt('expires_at', now),
  ]);
  if (e1) console.warn('[expire] nft_offers error:', e1.message);
  if (e2) console.warn('[expire] collection_bids error:', e2.message);
}

function start(supabase) {
  console.log('[trending] starting score job (15 min interval)');
  recalculate(supabase).catch(e => console.error('[trending] initial run error:', e.message));

  // Take an initial floor snapshot, then every hour
  snapshotFloors(supabase).catch(e => console.warn('[floors] initial snapshot error:', e.message));
  setInterval(() => {
    snapshotFloors(supabase).catch(e => console.warn('[floors] snapshot error:', e.message));
  }, SNAPSHOT_MS);

  // Expire stale offers every 5 minutes
  expireOffers(supabase).catch(e => console.warn('[expire] initial run error:', e.message));
  setInterval(() => {
    expireOffers(supabase).catch(e => console.warn('[expire] error:', e.message));
  }, EXPIRE_MS);

  return setInterval(() => {
    recalculate(supabase).catch(e => console.error('[trending] recalc error:', e.message));
  }, RECALC_MS);
}

module.exports = { start, recalculate, snapshotFloors, expireOffers };

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const { createClient } = require('@supabase/supabase-js');
  const ws = require('ws');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
  recalculate(supabase)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
