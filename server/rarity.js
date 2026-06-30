'use strict';
// Compute and store rarity ranks for all indexed collections that have trait data.
// Usage: node server/rarity.js [collection_id]
//   --all to process every collection in indexed_nfts that has traits

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

// Rarity score = sum of (total / count_with_this_trait_value) per trait.
// Higher score = rarer. Rank 1 = rarest in collection.
function computeRarity(nfts) {
  const total = nfts.length;
  if (!total) return [];

  // Count occurrences of each trait_type:value pair
  const freq = {}; // { 'Background:Red': 42, ... }
  for (const nft of nfts) {
    for (const [k, v] of Object.entries(nft.traits || {})) {
      const key = `${k}:${v}`;
      freq[key] = (freq[key] || 0) + 1;
    }
  }

  // Score each NFT
  const scored = nfts.map(nft => {
    let score = 0;
    const entries = Object.entries(nft.traits || {});
    if (!entries.length) return { nft_id: nft.nft_id, score: 0 };
    for (const [k, v] of entries) {
      const count = freq[`${k}:${v}`] || 1;
      score += total / count;
    }
    return { nft_id: nft.nft_id, score };
  });

  // Rank: sort descending by score, assign rank 1 = rarest
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => { s.rank = i + 1; });

  return scored;
}

async function processCollection(collectionId) {
  // Fetch all NFTs with traits for this collection
  const { data, error } = await supabase
    .from('indexed_nfts')
    .select('nft_id, traits')
    .eq('collection_id', collectionId)
    .not('traits', 'eq', '{}');

  if (error) { console.error(`  DB error: ${error.message}`); return 0; }
  if (!data?.length) { console.log(`  No indexed traits yet — run nft-backfill first.`); return 0; }

  const scored = computeRarity(data);

  // Batch update in chunks of 100
  const CHUNK = 100;
  for (let i = 0; i < scored.length; i += CHUNK) {
    const chunk = scored.slice(i, i + CHUNK);
    const updates = chunk.map(s => ({
      nft_id:       s.nft_id,
      collection_id: collectionId,
      rarity_score: s.score,
      rarity_rank:  s.rank,
    }));
    const { error: upErr } = await supabase
      .from('indexed_nfts')
      .upsert(updates, { onConflict: 'nft_id' });
    if (upErr) console.warn(`  chunk ${i} error: ${upErr.message}`);
  }

  return scored.length;
}

async function main() {
  const arg = process.argv[2];

  let collections;

  if (!arg || arg === '--all') {
    // Get all collections that have at least some trait data
    const { data } = await supabase
      .from('indexed_nfts')
      .select('collection_id')
      .not('traits', 'eq', '{}')
      .not('collection_id', 'is', null);

    const unique = [...new Set((data || []).map(r => r.collection_id))];
    console.log(`Found ${unique.length} collections with trait data.`);
    collections = unique;
  } else {
    collections = [arg];
  }

  for (const colId of collections) {
    process.stdout.write(`${colId.slice(0, 20)}… `);
    const count = await processCollection(colId);
    console.log(`${count} NFTs ranked`);
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
