'use strict';
// One-time backfill: paginate MintGarden collections API → indexed_collections table.
// Run with: node server/backfill.js
// Re-runnable — uses upsert so safe to run again to pick up new collections.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

const PAGE_SIZE = 48;
const DELAY_MS  = 600; // be polite to MintGarden

// MintGarden uses cursor-based pagination: ?size=N (first page), ?size=N&page={cursor} (subsequent)
// Response: { items: [...], next: "cursor_string" | null }

function normalize(col) {
  const id = col.id || '';
  return {
    collection_id:    id,
    name:             col.name || 'Unknown',
    description:      col.description || null,
    thumbnail_url:    col.thumbnail_uri || null,
    total_supply:     0,
    minted_count:     col.nft_count || 0,
    floor_price_mojo: col.floor_price || 0,
    creator_did:      col.creator?.encoded_id || null,
    source:           'mintgarden',
    external_url:     `https://mintgarden.io/collections/${id}`,
    verified:         false,
    updated_at:       new Date().toISOString(),
  };
}

async function fetchPage(cursor) {
  // interval=all shows every collection ever, not just the weekly hot list
  const url = cursor
    ? `https://api.mintgarden.io/collections?interval=all&size=${PAGE_SIZE}&page=${encodeURIComponent(cursor)}`
    : `https://api.mintgarden.io/collections?interval=all&size=${PAGE_SIZE}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Wiznerd-Indexer/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`MintGarden HTTP ${res.status}`);
  return res.json(); // { items, next, previous, size }
}

// Add a single collection by ID (fetches it from MintGarden collection endpoint)
async function addCollectionById(collectionId) {
  const res = await fetch(`https://api.mintgarden.io/collections/${encodeURIComponent(collectionId)}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`MintGarden HTTP ${res.status} for ${collectionId}`);
  const col = await res.json();
  const row = normalize(col);
  if (!row.collection_id) throw new Error('No collection_id in response');
  const { error } = await supabase.from('indexed_collections').upsert([row], { onConflict: 'collection_id' });
  if (error) throw new Error(`Supabase: ${error.message}`);
  console.log(`Added: ${row.name} (${row.minted_count} NFTs)`);
}

async function run() {
  // If a collection ID is passed, just add that one collection
  const singleId = process.argv[2];
  if (singleId) {
    console.log(`Adding collection ${singleId}...`);
    await addCollectionById(singleId);
    return;
  }

  let cursor = null;
  let total = 0;
  let page = 0;

  console.log('Starting MintGarden collections backfill...');

  while (true) {
    let json;
    try {
      json = await fetchPage(cursor);
    } catch (e) {
      console.error(`Page ${page} failed: ${e.message}`);
      break;
    }

    const items = json.items || [];
    if (!items.length) break;

    const rows = items.map(normalize).filter(r => r.collection_id);
    const { error } = await supabase
      .from('indexed_collections')
      .upsert(rows, { onConflict: 'collection_id' });

    if (error) {
      console.error(`Supabase upsert error on page ${page}: ${error.message}`);
      break;
    }

    total += rows.length;
    console.log(`  page ${page}: ${rows.length} collections (running total: ${total})`);

    cursor = json.next || null;
    if (!cursor) break;
    page++;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone. ${total} collections upserted into indexed_collections.`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
