'use strict';
// Dexie historical volume backfill — fetches completed NFT offers from Dexie's
// API per collection and inserts them into nft_transfers for trending.
//
// Uses Dexie's offered_or_requested filter which accepts bech32m collection IDs
// and returns only offers for that specific collection.
//
// Usage:
//   node server/dexie-backfill.js <collection_id>            # single collection
//   node server/dexie-backfill.js --all                      # all indexed collections
//   node server/dexie-backfill.js <collection_id> --fresh    # wipe first

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { bech32m }      = require('bech32');
const ws               = require('ws');

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const DEXIE_API = 'https://api.dexie.space/v1';
const PAGE_SIZE = 500;
const PAGE_DELAY = 300; // ms between pages per collection

// ── Bech32m helpers ───────────────────────────────────────────────────────────

function hexToNftId(hex) {
  try {
    const words = bech32m.toWords(Buffer.from(hex, 'hex'));
    return bech32m.encode('nft', words, 90);
  } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Dexie API ─────────────────────────────────────────────────────────────────

async function fetchPage(collectionId, page) {
  // Dexie uses 1-indexed pages; page=0 and page=1 both return the first batch
  const url = `${DEXIE_API}/offers?offered_or_requested=${collectionId}&status=4&compact=true&page_size=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Dexie HTTP ${res.status}`);
  return res.json();
}

// ── Process one collection ────────────────────────────────────────────────────

async function backfillCollection(collectionId, collName) {
  let page = 0;
  let totalInserted = 0;
  const seen = new Set();

  // Fetch first page (page=1) to get count — Dexie is 1-indexed
  let first;
  try {
    first = await fetchPage(collectionId, 1);
  } catch (e) {
    console.log(`  [${collName}] Dexie error: ${e.message}`);
    return 0;
  }

  const total = first.count || 0;
  // Dexie is 1-indexed: page=1 is the first page (page=0 == page=1).
  // Pages go from 1 to ceil(total/PAGE_SIZE) inclusive.
  const pages = Math.ceil(total / PAGE_SIZE);

  if (!total) {
    console.log(`  [${collName}] 0 offers on Dexie`);
    return 0;
  }

  async function processPage(d) {
    const trades = [];
    for (const offer of d.offers || []) {
      const off = offer.offered?.[0];
      const req = offer.requested?.[0];

      // NFT ask: NFT offered, XCH requested (has XCH price)
      if (off?.is_nft && req?.id === 'xch') {
        if (!off.id || off.id.length !== 64) continue;
        const nftId = hexToNftId(off.id);
        if (!nftId) continue;
        const priceMojo = offer.price != null ? Math.round(offer.price * 1e12) : null;
        if (!priceMojo || priceMojo <= 0) continue;
        trades.push({
          nft_id: nftId, collection_id: collectionId,
          price_mojo: priceMojo, block_height: offer.spent_block_index || null,
          transferred_at: offer.date_completed || new Date().toISOString(),
          source: 'dexie',
        });
        continue;
      }

      // NFT-NFT swap: both sides are NFTs, no XCH price — count as trade, null price
      if (off?.is_nft && req?.is_nft) {
        if (!off.id || off.id.length !== 64) continue;
        const nftId = hexToNftId(off.id);
        if (!nftId) continue;
        trades.push({
          nft_id: nftId, collection_id: collectionId,
          price_mojo: null, block_height: offer.spent_block_index || null,
          transferred_at: offer.date_completed || new Date().toISOString(),
          source: 'dexie',
        });
        continue;
      }

      // XCH bid accepted: XCH offered, NFT requested
      if (req?.is_nft && off?.id === 'xch') {
        if (!req.id || req.id.length !== 64) continue;
        const nftId = hexToNftId(req.id);
        if (!nftId) continue;
        const priceMojo = offer.price != null ? Math.round(offer.price * 1e12) : null;
        if (!priceMojo || priceMojo <= 0) continue;
        trades.push({
          nft_id: nftId, collection_id: collectionId,
          price_mojo: priceMojo, block_height: offer.spent_block_index || null,
          transferred_at: offer.date_completed || new Date().toISOString(),
          source: 'dexie',
        });
        continue;
      }

      // CAT-denominated sale: NFT offered, CAT token requested (price is in CAT, not XCH)
      if (off?.is_nft && req && !req.is_nft && req.id !== 'xch') {
        if (!off.id || off.id.length !== 64) continue;
        const nftId = hexToNftId(off.id);
        if (!nftId) continue;
        trades.push({
          nft_id: nftId, collection_id: collectionId,
          price_mojo: null, // CAT price, not convertible to XCH without current rates
          block_height: offer.spent_block_index || null,
          transferred_at: offer.date_completed || new Date().toISOString(),
          source: 'dexie',
        });
      }
    }

    // Deduplicate by nft_id + block_height
    const fresh = trades.filter(t => {
      const key = `${t.nft_id}:${t.block_height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return;

    // Insert in batches
    for (let i = 0; i < fresh.length; i += 500) {
      const batch = fresh.slice(i, i + 500);
      const { error } = await supabase.from('nft_transfers').insert(batch);
      if (error) {
        // Fall back to upsert if unique constraint exists (migration 013)
        const { error: e2 } = await supabase.from('nft_transfers')
          .upsert(batch, { onConflict: 'nft_id,block_height', ignoreDuplicates: true });
        if (e2) console.error('\n  Insert error:', e2.message);
        else totalInserted += batch.length;
      } else {
        totalInserted += batch.length;
      }
    }
  }

  await processPage(first);

  // Dexie is 1-indexed; page=1 was already fetched above, continue from page=2
  for (page = 2; page <= pages; page++) {
    await sleep(PAGE_DELAY);
    let d;
    try {
      d = await fetchPage(collectionId, page);
    } catch (e) {
      console.error(`  Page ${page} error: ${e.message} — skipping`);
      continue;
    }
    await processPage(d);
    process.stdout.write(`\r  [${collName}] ${page}/${pages} pages · ${totalInserted} trades inserted   `);
  }

  if (pages > 1) process.stdout.write('\n');
  return totalInserted;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args  = process.argv.slice(2);
  const all   = args.includes('--all');
  const fresh = args.includes('--fresh');
  const colId = args.find(a => !a.startsWith('--')) || null;

  if (!all && !colId) {
    console.error('Usage: node server/dexie-backfill.js <collection_id> | --all [--fresh]');
    process.exit(1);
  }

  if (fresh) {
    const q = colId
      ? supabase.from('nft_transfers').delete().eq('source', 'dexie').eq('collection_id', colId)
      : supabase.from('nft_transfers').delete().eq('source', 'dexie');
    const { error } = await q;
    if (error) console.error('Fresh wipe error:', error.message);
    else console.log('--fresh: wiped existing dexie transfers');
  }

  let collections;

  if (colId) {
    const { data } = await supabase
      .from('indexed_collections').select('collection_id, name').eq('collection_id', colId).maybeSingle();
    collections = [{ collection_id: colId, name: data?.name || colId }];
  } else {
    // Paginate — Supabase default cap is 1000 rows
    collections = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('indexed_collections').select('collection_id, name')
        .order('minted_count', { ascending: false })
        .range(from, from + 999);
      if (error) { console.error('Supabase error:', error.message); process.exit(1); }
      if (!data?.length) break;
      collections.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
  }

  console.log(`\nDexie backfill — ${collections.length} collection(s)\n`);

  let grandTotal = 0;
  for (let i = 0; i < collections.length; i++) {
    const { collection_id, name } = collections[i];
    const shortName = (name || collection_id).slice(0, 30);
    process.stdout.write(`  [${i + 1}/${collections.length}] ${shortName} ...`);

    const inserted = await backfillCollection(collection_id, shortName);
    grandTotal += inserted;

    if (inserted > 0) {
      console.log(`  ✓ ${inserted} trades`);
    } else {
      process.stdout.write(' 0\n');
    }

    // Pause between collections to be kind to Dexie API
    if (i < collections.length - 1) await sleep(500);
  }

  console.log(`\nAll done. ${grandTotal} total trades inserted.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
