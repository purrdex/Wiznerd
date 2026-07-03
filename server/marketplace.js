'use strict';

const PROXY = process.env.PROXY_URL || 'http://localhost:3001';

// In-memory traits cache (30 min TTL — trait distributions don't change often)
const traitsCache = new Map();
const TRAITS_TTL = 30 * 60 * 1000;

async function getNextAddress() {
  const res = await fetch(`${PROXY}/wallet/get_next_address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_id: 1, new_address: true }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`wallet daemon ${res.status}`);
  const j = await res.json();
  if (!j.address) throw new Error('wallet daemon returned no address');
  return j.address;
}

// ── External collection cache (indexed_collections table, 2 min TTL) ─────────
let externalCache = null;
let externalCacheTime = 0;
const EXTERNAL_TTL = 2 * 60 * 1000;

module.exports = function registerMarketplaceRoutes(app, supabase) {

  // ── Browse ────────────────────────────────────────────────────────────────────

  app.get('/api/marketplace/listings', async (req, res) => {
    const { filter, search } = req.query;
    let query = supabase
      .from('projects')
      .select('id,name,symbol,total_supply,marketplace_status,mint_price_mojo,launch_at,creator_address,collection_image_url,collection_image_path,description')
      .neq('marketplace_status', 'draft')
      .order('created_at', { ascending: false });

    if (filter === 'live')          query = query.eq('marketplace_status', 'live');
    else if (filter === 'upcoming') query = query.eq('marketplace_status', 'scheduled');
    else if (filter === 'soldout')  query = query.eq('marketplace_status', 'sold_out');
    if (search) query = query.ilike('name', `%${search}%`);

    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const enriched = await Promise.all((data || []).map(async p => {
      const [{ data: orders }, { data: first }] = await Promise.all([
        supabase.from('orders').select('minted_count')
          .eq('project_id', p.id).in('status', ['confirmed', 'minting']),
        supabase.from('generated_tokens').select('token_index')
          .eq('project_id', p.id).order('token_index').limit(1).single(),
      ]);
      const minted_count = (orders || []).reduce((s, o) => s + (o.minted_count || 0), 0);

      let thumbnail_url = '';
      if (p.collection_image_url) {
        thumbnail_url = p.collection_image_url.startsWith('ipfs://')
          ? `https://gateway.pinata.cloud/ipfs/${p.collection_image_url.replace('ipfs://', '')}`
          : p.collection_image_url;
      } else if (p.collection_image_path) {
        thumbnail_url = `${supabaseUrl}/storage/v1/object/public/output/${p.collection_image_path}`;
      }

      return { ...p, minted_count, first_token_index: first?.token_index ?? 0, thumbnail_url, source: 'wiznerd' };
    }));

    res.json(enriched);
  });

  // ── External collections (indexed_collections table, 2 min cache) ────────────

  app.get('/api/marketplace/external', async (req, res) => {
    const { search } = req.query;

    // Serve from in-memory cache if fresh (avoids hammering DB on browse page loads)
    if (!search && externalCache && Date.now() - externalCacheTime < EXTERNAL_TTL) {
      return res.json(externalCache);
    }

    try {
      let query = supabase
        .from('indexed_collections')
        .select('collection_id,name,description,thumbnail_url,total_supply,minted_count,floor_price_mojo,source,external_url,verified,trending_score,volume_24h_mojo,volume_7d_mojo,sales_24h,sales_7d,mint_24h,listed_count')
        .order('minted_count', { ascending: false })
        .limit(200);

      if (search) query = query.ilike('name', `%${search}%`);

      const { data, error } = await query;
      if (error) throw new Error(error.message);

      const items = (data || []).map(col => ({
        id:                 col.collection_id,
        name:               col.name,
        total_supply:       col.total_supply     || 0,
        marketplace_status: 'live',
        mint_price_mojo:    col.floor_price_mojo || 0,
        launch_at:          null,
        minted_count:       col.minted_count     || 0,
        indexed_count:      col.minted_count     || 0,
        thumbnail_url:      col.thumbnail_url    || '',
        description:        col.description      || '',
        source:             'external',
        verified:           col.verified         || false,
        external_url:       col.external_url     || `https://mintgarden.io/collections/${col.collection_id}`,
        trending_score:     col.trending_score   || 0,
        volume_24h_mojo:    col.volume_24h_mojo  || 0,
        volume_7d_mojo:     col.volume_7d_mojo   || 0,
        sales_24h:          col.sales_24h        || 0,
        sales_7d:           col.sales_7d         || 0,
        mint_24h:           col.mint_24h         || 0,
        listed_count:       col.listed_count     || 0,
      }));

      if (!search) {
        externalCache = items;
        externalCacheTime = Date.now();
      }
      res.json(items);
    } catch (e) {
      console.warn('[marketplace] external query failed:', e.message);
      res.json(externalCache || []);
    }
  });

  // ── Single collection ─────────────────────────────────────────────────────────

  app.get('/api/marketplace/:id', async (req, res) => {
    // Try Wiznerd projects first
    const { data: project } = await supabase
      .from('projects').select('*').eq('id', req.params.id).single();

    if (project) {
      const { data: orders } = await supabase
        .from('orders').select('minted_count')
        .eq('project_id', req.params.id).in('status', ['confirmed', 'minting']);
      const minted_count = (orders || []).reduce((s, o) => s + (o.minted_count || 0), 0);
      return res.json({ ...project, minted_count, source: 'wiznerd' });
    }

    // Fall back to indexed_collections (external / on-chain)
    const { data: col } = await supabase
      .from('indexed_collections').select('*').eq('collection_id', req.params.id).single();
    if (!col) return res.status(404).json({ error: 'Collection not found' });

    res.json({
      id:                 col.collection_id,
      name:               col.name,
      symbol:             null,
      description:        col.description || null,
      collection_image_url: col.thumbnail_url || null,
      total_supply:       col.total_supply  || 0,
      minted_count:       col.minted_count  || 0,
      mint_price_mojo:    col.floor_price_mojo || 0,
      launch_at:          null,
      marketplace_status: 'live',
      reveal_type:        'revealed',
      allowlist:          [],
      mints_paused:       false,
      creator_address:    col.creator_did   || null,
      royalty_percent:    0,
      ipfs_cid:           null,
      payment_address:    null,
      source:             col.source || 'external',
    });
  });

  app.get('/api/marketplace/:id/gallery', async (req, res) => {
    const id             = req.params.id;
    const cursor         = req.query.cursor || null;
    let selectedTraits = {};
    try { selectedTraits = req.query.traits ? JSON.parse(req.query.traits) : {}; } catch { /* ignore */ }
    const hasTraits      = Object.keys(selectedTraits).length > 0;

    // ── Check if Wiznerd project ──────────────────────────────────────────────
    const { data: proj } = await supabase
      .from('projects').select('id').eq('id', id).maybeSingle();

    if (proj) {
      const supabaseUrl = process.env.SUPABASE_URL || '';
      let query = supabase
        .from('generated_tokens')
        .select('token_index,metadata_uri,traits,image_cid,image_path,buyer_address')
        .eq('project_id', id)
        .not('buyer_address', 'is', null)
        .neq('buyer_address', '__reserved__')
        .order('token_index', { ascending: true })
        .limit(500);

      Object.entries(selectedTraits).forEach(([k, v]) => {
        query = query.filter(`traits->>${k}`, 'eq', v);
      });

      const { data } = await query;
      return res.json({
        items: (data || []).map(t => ({
          ...t,
          image_url: t.image_path
            ? `${supabaseUrl}/storage/v1/object/public/output/${t.image_path}`
            : t.metadata_uri || '',
        })),
        next: null,
      });
    }

    // ── External: Supabase indexed_nfts (DB) — used for browse + trait filter ──
    // When the collection has been backfilled with nft-backfill.js, traits are
    // stored on-chain in indexed_nfts. We always try DB first; fall back to
    // MintGarden only for browse (no traits) when DB is empty.
    {
      const offset = (cursor && cursor !== '__more__') ? parseInt(cursor, 10) : 0;
      const sort = req.query.sort || 'default';
      let query = supabase
        .from('indexed_nfts')
        .select('nft_id,token_index,name,image_url,traits,metadata_uri,owner_puzzle_hash,rarity_rank')
        .eq('collection_id', id)
        .not('image_url', 'is', null);

      if (sort === 'rarity') {
        query = query.order('rarity_rank', { ascending: true, nullsFirst: false });
      } else {
        query = query.order('token_index', { ascending: true, nullsFirst: false }).order('nft_id', { ascending: true });
      }
      query = query.range(offset, offset + 47);

      // Supabase JSONB trait filter — works once nft-backfill has run
      Object.entries(selectedTraits).forEach(([k, v]) => {
        query = query.filter(`traits->>${k}`, 'eq', v);
      });

      const { data: dbItems } = await query;

      if (dbItems?.length) {
        return res.json({
          items: dbItems.map(n => ({
            nft_id:       n.nft_id,
            token_index:  n.token_index,
            name:         n.name,
            image_url:    n.image_url,
            traits:       n.traits || {},
            metadata_uri: n.metadata_uri || '',
            owner_puzzle_hash: n.owner_puzzle_hash || null,
            rarity_rank:  n.rarity_rank || null,
            buyer_address: null,
          })),
          next: dbItems.length === 48 ? String(offset + 48) : null,
        });
      }

      // DB empty and trait filter active → nothing to show yet
      if (hasTraits) {
        return res.json({ items: [], next: null });
      }
    }

    // ── MintGarden fallback: browse only (no trait filter) ────────────────────
    try {
      const mgUrl = new URL(`https://api.mintgarden.io/collections/${encodeURIComponent(id)}/nfts`);
      mgUrl.searchParams.set('size', '48');
      if (cursor && cursor !== '__more__') mgUrl.searchParams.set('page', cursor);

      const mgRes = await fetch(mgUrl.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!mgRes.ok) return res.json({ items: [], next: null });
      const json = await mgRes.json();
      const nfts = json.items || [];

      const rows = nfts
        .filter(n => n.thumbnail_uri)
        .map(n => {
          const match = n.name?.match(/#(\d+)$/);
          return {
            nft_id:        n.encoded_id,
            collection_id: id,
            token_index:   match ? parseInt(match[1]) - 1 : null,
            name:          n.name || null,
            image_url:     n.thumbnail_uri,
            metadata_uri:  (n.metadata_uris || [])[0] || null,
            minter_did:    n.creator_encoded_id || null,
            traits:        {},
            updated_at:    new Date().toISOString(),
          };
        });

      if (rows.length && !hasTraits) {
        supabase.from('indexed_nfts')
          .upsert(rows, { onConflict: 'nft_id' })
          .then(({ error }) => { if (error) console.warn('[gallery] cache error:', error.message); });
      }

      return res.json({
        items: rows.map(n => ({
          nft_id:       n.nft_id,
          token_index:  n.token_index,
          name:         n.name,
          image_url:    n.image_url,
          traits:       {},
          metadata_uri: '',
          owner_puzzle_hash: null,
          buyer_address: null,
        })),
        next: json.next || null,
      });
    } catch (e) {
      console.warn('[gallery] MintGarden fetch failed:', e.message);
      return res.json({ items: [], next: null });
    }
  });

  // ── Collection traits ─────────────────────────────────────────────────────────

  app.get('/api/marketplace/:id/traits', async (req, res) => {
    const id = req.params.id;

    const hit = traitsCache.get(id);
    if (hit && Date.now() - hit.time < TRAITS_TTL) return res.json(hit.data);

    // Wiznerd: aggregate from generated_tokens
    const { data: tokens } = await supabase
      .from('generated_tokens')
      .select('traits')
      .eq('project_id', id)
      .not('traits', 'is', null)
      .limit(10000);

    if (tokens?.length) {
      const agg = {};
      tokens.forEach(t => {
        Object.entries(t.traits || {}).forEach(([k, v]) => {
          if (!agg[k]) agg[k] = {};
          const val = String(v);
          agg[k][val] = (agg[k][val] || 0) + 1;
        });
      });
      traitsCache.set(id, { data: agg, time: Date.now() });
      return res.json(agg);
    }

    // External: aggregate from indexed_nfts (populated by nft-backfill.js)
    const { data: indexed } = await supabase
      .from('indexed_nfts')
      .select('traits')
      .eq('collection_id', id)
      .not('traits', 'is', null)
      .limit(20000);

    if (indexed?.length) {
      const agg = {};
      indexed.forEach(t => {
        Object.entries(t.traits || {}).forEach(([k, v]) => {
          if (!agg[k]) agg[k] = {};
          const val = String(v);
          agg[k][val] = (agg[k][val] || 0) + 1;
        });
      });
      traitsCache.set(id, { data: agg, time: Date.now() });
      return res.json(agg);
    }

    // Last resort: fetch attributes_frequency_counts from MintGarden
    try {
      const mgRes = await fetch(
        `https://api.mintgarden.io/collections/${encodeURIComponent(id)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
      );
      if (!mgRes.ok) return res.json({});
      const json = await mgRes.json();
      const data = json.attributes_frequency_counts || {};
      traitsCache.set(id, { data, time: Date.now() });
      return res.json(data);
    } catch (e) {
      return res.json({});
    }
  });

  // ── NFT detail (owner + history + rarity) ────────────────────────────────────

  const { bech32m } = require('bech32');
  function puzzleHashToAddress(puzzleHash) {
    try {
      const hex = (puzzleHash || '').replace('0x', '');
      if (hex.length !== 64) return null;
      const words = bech32m.toWords(Buffer.from(hex, 'hex'));
      return bech32m.encode('xch', words);
    } catch { return null; }
  }

  // Decode nft1..., 0x hex, or raw hex → plain hex launcher_id
  function decodeNftId(nftId) {
    if (!nftId) return null;
    if (nftId.startsWith('0x')) return nftId.slice(2).toLowerCase();
    if (nftId.startsWith('nft1')) {
      try {
        const d = bech32m.decode(nftId, 90);
        return Buffer.from(bech32m.fromWords(d.words)).toString('hex');
      } catch { return null; }
    }
    if (/^[0-9a-f]{64}$/i.test(nftId)) return nftId.toLowerCase();
    return null;
  }

  async function walletRpc(endpoint, body = {}) {
    const r = await fetch(`${PROXY}/wallet/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`wallet/${endpoint} HTTP ${r.status}`);
    return r.json();
  }

  app.get('/api/nft/:nftId', async (req, res) => {
    const { nftId } = req.params;

    const { data: nft, error } = await supabase
      .from('indexed_nfts')
      .select('*')
      .eq('nft_id', nftId)
      .maybeSingle();

    if (error || !nft) return res.status(404).json({ error: 'NFT not found' });

    const ownerAddress = puzzleHashToAddress(nft.owner_puzzle_hash);

    // Open offers from our own board
    const { data: offers } = await supabase
      .from('nft_offers')
      .select('id,offer_type,price_mojo,maker_puzzle_hash,created_at,expires_at')
      .eq('nft_id', nftId)
      .eq('status', 'open')
      .order('price_mojo', { ascending: true });

    // Transfer history from our own DB
    const { data: transfers } = await supabase
      .from('nft_transfers')
      .select('from_puzzle_hash,to_puzzle_hash,price_mojo,block_height,transferred_at')
      .eq('nft_id', nftId)
      .order('block_height', { ascending: false })
      .limit(20);

    // Supplement with MintGarden events if our DB has no history
    let history = (transfers || []).map(t => ({
      from:   puzzleHashToAddress(t.from_puzzle_hash),
      to:     puzzleHashToAddress(t.to_puzzle_hash),
      price_mojo: t.price_mojo,
      block_height: t.block_height,
      timestamp: t.transferred_at,
      source: 'onchain',
    }));

    if (!history.length && nft.nft_id) {
      try {
        const mgRes = await fetch(`https://api.mintgarden.io/nfts/${encodeURIComponent(nft.nft_id)}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (mgRes.ok) {
          const mg = await mgRes.json();
          // MintGarden event type 0 = mint, 1 = transfer/sale
          history = (mg.events || []).map(e => ({
            from:        e.previous_address?.encoded_id || null,
            to:          e.address?.encoded_id || null,
            price_mojo:  e.xch_price ? Math.round(e.xch_price * 1e12) : null,
            block_height: e.block_height,
            timestamp:   e.timestamp,
            type:        e.type === 0 ? 'mint' : 'transfer',
            source: 'mintgarden',
          }));
        }
      } catch { /* ignore */ }
    }

    res.json({
      ...nft,
      owner_address: ownerAddress,
      open_offers:   offers || [],
      history,
    });
  });

  // ── NFT offers — validate / submit / cancel ──────────────────────────────────

  // ── CAT wallet discovery ──────────────────────────────────────────────────────

  // Returns user's CAT wallets with asset_id and balance for the token picker
  app.get('/api/wallet/cats', async (req, res) => {
    try {
      const r = await fetch(`${PROXY}/wallet/get_wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include_data: true }),
        signal: AbortSignal.timeout(10000),
      });
      const d = await r.json();
      const cats = (d.wallets || [])
        .filter(w => w.type === 6)
        .map(w => ({
          wallet_id: w.id,
          name:      w.name || '',
          asset_id:  (w.data || '').slice(0, 64), // Chia stores tail hash as first 64 hex chars
        }))
        .filter(w => w.asset_id.length === 64);
      res.json({ cats });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Helper: call wallet daemon and parse an offer string into human-readable terms
  async function parseOfferString(offer_string) {
    const [vRes, sRes] = await Promise.allSettled([
      fetch(`${PROXY}/wallet/check_offer_validity`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: offer_string }),
        signal: AbortSignal.timeout(15000),
      }).then(r => r.json()),
      fetch(`${PROXY}/wallet/get_offer_summary`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: offer_string }),
        signal: AbortSignal.timeout(15000),
      }).then(r => r.json()),
    ]);

    const validity = vRes.status === 'fulfilled' ? vRes.value : {};
    const summaryRaw = sRes.status === 'fulfilled' ? sRes.value : {};
    const summary = summaryRaw.summary || summaryRaw.offer_summary || validity.offer_summary || {};

    if (!validity.valid) return { valid: false };

    const offered = summary.offered || {};
    const requested = summary.requested || {};

    // NFT coins have amount === 1; XCH amounts are large mojos values
    const nftOffered   = Object.entries(offered).find(([, v]) => Number(v) === 1);
    const nftRequested = Object.entries(requested).find(([, v]) => Number(v) === 1);
    const xchOffered   = Object.entries(offered).find(([, v]) => Number(v) > 1);
    const xchRequested = Object.entries(requested).find(([, v]) => Number(v) > 1);

    let offer_type, price_mojo, detected_nft_id;
    if (nftOffered && xchRequested) {
      offer_type = 'ask';
      price_mojo = Number(xchRequested[1]);
      detected_nft_id = nftOffered[0];
    } else if (xchOffered && nftRequested) {
      offer_type = 'bid';
      price_mojo = Number(xchOffered[1]);
      detected_nft_id = nftRequested[0];
    } else {
      return { valid: true, parse_error: 'Expected an NFT/XCH trade pair' };
    }

    return { valid: true, offer_type, price_mojo, detected_nft_id };
  }

  // ── In-wallet offer creation (price input → create_offer_for_ids → auto-list) ─

  app.post('/api/nft/:nftId/create-offer', async (req, res) => {
    const { nftId } = req.params;
    const { offer_type, price_mojo, token_id = 'xch' } = req.body;
    if (!offer_type || !price_mojo) return res.status(400).json({ error: 'offer_type and price_mojo required' });

    const LISTING_FEE_MOJO = Number(process.env.LISTING_FEE_MOJO || 1_000_000_000);
    const PLATFORM_ADDRESS = process.env.PLATFORM_WALLET_ADDRESS || null;
    const isXch = token_id === 'xch';

    // Collect listing fee before creating offer (asks only; bids are free)
    if (offer_type === 'ask' && PLATFORM_ADDRESS && LISTING_FEE_MOJO > 0) {
      try {
        const feeRes = await walletRpc('send_transaction', {
          wallet_id: 1, amount: LISTING_FEE_MOJO, address: PLATFORM_ADDRESS,
          fee: 0, memos: ['wiznerd-listing-fee'],
        });
        if (!feeRes.success) throw new Error(feeRes.error || 'listing fee tx failed');
      } catch (e) {
        return res.status(402).json({ error: `Listing fee required: ${e.message}` });
      }
    }

    const priceAmount = Math.round(Number(price_mojo));
    if (!priceAmount || priceAmount <= 0) return res.status(400).json({ error: 'Invalid price' });

    const launcherHex = decodeNftId(nftId);
    if (!launcherHex) return res.status(400).json({ error: 'Invalid NFT ID' });

    // Resolve token wallet ID (XCH = 1 always; CAT = find by asset_id)
    let tokenWalletId = 1;
    if (!isXch) {
      try {
        const { wallets } = await walletRpc('get_wallets', { include_data: true });
        const cat = (wallets || []).find(w =>
          w.type === 6 && (w.data || '').slice(0, 64).toLowerCase() === token_id.toLowerCase()
        );
        if (!cat) return res.status(404).json({ error: `CAT wallet for ${token_id} not found in your wallet` });
        tokenWalletId = cat.id;
      } catch (e) {
        return res.status(502).json({ error: `Wallet search failed: ${e.message}` });
      }
    }

    let offerIds;

    if (offer_type === 'ask') {
      // Find which NFT wallet holds this NFT
      let nftWalletId = null;
      try {
        const { wallets } = await walletRpc('get_wallets', { include_data: false });
        const nftWallets = (wallets || []).filter(w => w.type === 10);
        for (const w of nftWallets) {
          const { nft_list } = await walletRpc('nft_get_nfts', { wallet_id: w.id });
          const found = (nft_list || []).find(n =>
            (n.launcher_id || '').replace('0x', '').toLowerCase() === launcherHex
          );
          if (found) { nftWalletId = w.id; break; }
        }
      } catch (e) {
        return res.status(502).json({ error: `Wallet search failed: ${e.message}` });
      }
      if (!nftWalletId) {
        return res.status(404).json({ error: 'NFT not found in your wallet. You must own this NFT to list it.' });
      }
      // Offering NFT (-1), requesting token from counterparty
      offerIds = { [String(nftWalletId)]: -1, [String(tokenWalletId)]: priceAmount };
    } else {
      // Bid: offering token (-), requesting NFT by launcher_id (+)
      offerIds = { [String(tokenWalletId)]: -priceAmount, [`0x${launcherHex}`]: 1 };
    }

    let offerString;
    try {
      const d = await walletRpc('create_offer_for_ids', { offer: offerIds, fee: 0, validate_only: false });
      if (!d.success) return res.status(400).json({ error: d.error || 'create_offer_for_ids failed' });
      offerString = d.offer;
    } catch (e) {
      return res.status(502).json({ error: `Wallet daemon: ${e.message}` });
    }

    const { data, error } = await supabase.from('nft_offers').insert({
      nft_id:       nftId,
      offer_string: offerString,
      offer_type:   offer_type === 'ask' ? 'ask' : 'bid',
      price_mojo:   priceAmount,
      price_token:  isXch ? 'xch' : token_id,
      status:       'open',
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // Validate only — no save (client calls this first so user can preview)
  app.post('/api/nft/offers/validate', async (req, res) => {
    const { offer_string } = req.body;
    if (!offer_string?.trim()) return res.status(400).json({ error: 'offer_string required' });
    try {
      res.json(await parseOfferString(offer_string.trim()));
    } catch (e) {
      res.status(502).json({ error: `Wallet daemon: ${e.message}` });
    }
  });

  app.post('/api/nft/:nftId/offers', async (req, res) => {
    const { nftId } = req.params;
    const { offer_string, offer_type, price_mojo: clientPrice, expires_at } = req.body;
    if (!offer_string || !offer_type) return res.status(400).json({ error: 'offer_string and offer_type required' });

    let parsed;
    try {
      parsed = await parseOfferString(offer_string.trim());
    } catch (e) {
      return res.status(502).json({ error: `Wallet daemon: ${e.message}` });
    }
    if (!parsed.valid) return res.status(400).json({ error: 'Offer is invalid or has already been taken' });

    const price_mojo = parsed.price_mojo ?? Number(clientPrice) ?? 0;

    const { data, error } = await supabase.from('nft_offers').insert({
      nft_id:       nftId,
      offer_string: offer_string.trim(),
      offer_type:   offer_type === 'ask' ? 'ask' : 'bid',
      price_mojo,
      status:       'open',
      expires_at:   expires_at || null,
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.post('/api/nft/offers/:offerId/take', async (req, res) => {
    const { offerId } = req.params;

    const { data: offer } = await supabase
      .from('nft_offers').select('*').eq('id', offerId).single();
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    if (offer.status !== 'open') return res.status(400).json({ error: `Offer is ${offer.status}` });

    try {
      const r = await fetch(`${PROXY}/wallet/take_offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: offer.offer_string, fee: 0 }),
        signal: AbortSignal.timeout(30000),
      });
      const result = await r.json();
      if (!result.success) return res.status(400).json({ error: result.error || 'take_offer failed' });

      await supabase.from('nft_offers')
        .update({ status: 'taken', updated_at: new Date().toISOString() })
        .eq('id', offerId);

      // Record the sale in nft_transfers with known price
      if (offer.nft_id && offer.price_mojo) {
        const { data: nft } = await supabase
          .from('indexed_nfts')
          .select('owner_puzzle_hash, collection_id')
          .eq('nft_id', offer.nft_id)
          .maybeSingle();
        await supabase.from('nft_transfers').insert({
          nft_id:           offer.nft_id,
          collection_id:    nft?.collection_id || offer.collection_id || null,
          from_puzzle_hash: nft?.owner_puzzle_hash || null,
          to_puzzle_hash:   null, // buyer puzzle hash not available at this point
          price_mojo:       offer.price_mojo,
          block_height:     null,
          transferred_at:   new Date().toISOString(),
        });
      }

      res.json({ success: true, trade_id: result.trade_record?.trade_id });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.delete('/api/nft/offers/:offerId', async (req, res) => {
    const { offerId } = req.params;
    await supabase.from('nft_offers')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', offerId);
    res.json({ success: true });
  });

  // ── Profile — owned NFTs from indexed_nfts ───────────────────────────────────

  app.get('/api/marketplace/profile', async (req, res) => {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });

    let puzzleHex;
    try {
      const d = bech32m.decode(String(address), 90);
      puzzleHex = Buffer.from(bech32m.fromWords(d.words)).toString('hex');
    } catch {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const { data: nfts, error } = await supabase
      .from('indexed_nfts')
      .select('nft_id,name,token_index,image_url,traits,collection_id,rarity_rank,rarity_score')
      .or(`owner_puzzle_hash.eq.${puzzleHex},owner_puzzle_hash.eq.0x${puzzleHex}`)
      .order('collection_id', { ascending: true })
      .order('token_index', { ascending: true, nullsFirst: false });

    if (error) return res.status(500).json({ error: error.message });

    const collectionIds = [...new Set((nfts || []).map(n => n.collection_id).filter(Boolean))];

    const { data: colRows } = await supabase
      .from('indexed_collections')
      .select('collection_id,name,thumbnail_uri')
      .in('collection_id', collectionIds.length ? collectionIds : ['__none__']);

    const colMap = Object.fromEntries((colRows || []).map(c => [c.collection_id, c]));

    const collectionCounts = {};
    (nfts || []).forEach(n => {
      if (n.collection_id) collectionCounts[n.collection_id] = (collectionCounts[n.collection_id] || 0) + 1;
    });

    const collections = collectionIds
      .map(id => ({
        id,
        name: colMap[id]?.name || id.slice(0, 12) + '…',
        thumbnail_uri: colMap[id]?.thumbnail_uri || null,
        count: collectionCounts[id] || 0,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ nfts: nfts || [], collections });
  });

  // ── Publish (step 8 of wizard) ────────────────────────────────────────────────

  app.post('/api/marketplace/publish', async (req, res) => {
    const { project_id, mint_price_xch, launch_immediately, launch_at, allowlist, reveal_type } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    const PLATFORM_FEE_PCT     = Number(process.env.PLATFORM_FEE_PERCENT || 2.5) / 100;
    const PLATFORM_ADDRESS     = process.env.PLATFORM_WALLET_ADDRESS || null;

    const creator_price_mojo   = Math.round((Number(mint_price_xch) || 0) * 1e12);
    const platform_fee_mojo    = PLATFORM_ADDRESS ? Math.round(creator_price_mojo * PLATFORM_FEE_PCT) : 0;
    // Buyer pays creator_price + fee; payment goes to platform address (or creator if no platform address)
    const total_price_mojo     = creator_price_mojo + platform_fee_mojo;
    const marketplace_status   = launch_immediately !== false ? 'live' : 'scheduled';

    const { data: proj } = await supabase
      .from('projects').select('creator_address').eq('id', project_id).single();
    const creator_address = proj?.creator_address;
    if (!creator_address) return res.status(400).json({ error: 'Project has no creator_address — set it before publishing' });

    // If we have a platform address, payment comes to us and we track creator payout owed
    const payment_address = PLATFORM_ADDRESS || creator_address;

    const { data, error } = await supabase
      .from('projects')
      .update({
        mint_price_mojo:    total_price_mojo,
        creator_price_mojo: creator_price_mojo,
        platform_fee_mojo:  platform_fee_mojo,
        payment_address,
        launch_at: launch_immediately !== false ? null : (launch_at || null),
        allowlist: allowlist || [],
        reveal_type: reveal_type || 'instant',
        marketplace_status,
        current_step: 8,
        updated_at: new Date().toISOString(),
      })
      .eq('id', project_id)
      .select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ ...data, platform_fee_mojo, creator_price_mojo, platform_fee_pct: PLATFORM_FEE_PCT * 100 });
  });

  // ── Orders ────────────────────────────────────────────────────────────────────

  app.post('/api/marketplace/:id/orders', async (req, res) => {
    const { buyer_address } = req.body;
    const projectId = req.params.id;

    const { data: project, error: projErr } = await supabase
      .from('projects').select('*').eq('id', projectId).single();
    if (projErr || !project) return res.status(404).json({ error: 'Collection not found' });
    if (project.marketplace_status !== 'live') return res.status(400).json({ error: 'Collection is not live yet' });
    if (project.mints_paused) return res.status(400).json({ error: 'Minting is paused' });
    if (project.launch_at && new Date(project.launch_at) > new Date()) {
      return res.status(400).json({ error: 'Collection has not launched yet' });
    }

    const { count: minted } = await supabase
      .from('orders').select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .in('status', ['confirmed', 'minting', 'payment_detected']);
    if ((minted || 0) >= project.total_supply) {
      return res.status(400).json({ error: 'Collection is sold out' });
    }

    let payment_address;
    try {
      payment_address = await getNextAddress();
    } catch (e) {
      return res.status(500).json({ error: `Cannot generate payment address: ${e.message}` });
    }

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        project_id: projectId,
        payment_address,
        payment_amount_mojo: project.mint_price_mojo,
        buyer_address: buyer_address || null,
        quantity: 1,
        minted_count: 0,
        status: 'pending_payment',
      })
      .select().single();

    if (orderErr) return res.status(400).json({ error: orderErr.message });
    res.json({
      order_id: order.id,
      payment_address: order.payment_address,
      amount_mojo: order.payment_amount_mojo,
      amount_xch: (Number(order.payment_amount_mojo) / 1e12).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''),
    });
  });

  app.get('/api/marketplace/:id/orders/:orderId', async (req, res) => {
    const { data, error } = await supabase
      .from('orders')
      .select('id,status,confirmed_at,token_id,tx_id,quantity,minted_count,token_ids,generated_tokens(token_index,metadata_uri,traits)')
      .eq('id', req.params.orderId)
      .single();
    if (error) return res.status(404).json({ error: error.message });
    res.json(data);
  });

  // ── CHIP-0007 metadata (served so Chia wallet can display NFT name/image) ────

  app.get('/api/nft/:projectId/:tokenIndex/metadata.json', async (req, res) => {
    const { projectId, tokenIndex } = req.params;
    const { data: token } = await supabase
      .from('generated_tokens')
      .select('*')
      .eq('project_id', projectId)
      .eq('token_index', Number(tokenIndex))
      .single();
    const { data: project } = await supabase
      .from('projects').select('name,symbol,creator_address').eq('id', projectId).single();
    if (!token || !project) return res.status(404).json({ error: 'Not found' });

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const imageUrl = token.image_path
      ? `${supabaseUrl}/storage/v1/object/public/output/${token.image_path}`
      : '';

    res.json({
      format: 'CHIP-0007',
      name: `${project.name} #${Number(tokenIndex) + 1}`,
      description: `${project.name} — token ${Number(tokenIndex) + 1}`,
      sensitive_content: false,
      series_number: Number(tokenIndex) + 1,
      series_total: null,
      attributes: Object.entries(token.traits || {}).map(([k, v]) => ({ trait_type: k, value: v })),
      collection: {
        name: project.name,
        id: projectId,
        attributes: [{ type: 'description', value: project.name }],
      },
      data: { image: imageUrl },
    });
  });

  // ── Management ────────────────────────────────────────────────────────────────

  app.get('/api/marketplace/:id/orders', async (req, res) => {
    const { data } = await supabase
      .from('orders')
      .select('id,status,buyer_address,payment_address,payment_amount_mojo,tx_id,created_at,confirmed_at,token_id')
      .eq('project_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(200);
    res.json(data || []);
  });

  app.get('/api/marketplace/:id/stats', async (req, res) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [{ data: confirmed }, { count: mintsToday }, { data: project }] = await Promise.all([
      supabase.from('orders').select('payment_amount_mojo').eq('project_id', req.params.id).eq('status', 'confirmed'),
      supabase.from('orders').select('*', { count: 'exact', head: true })
        .eq('project_id', req.params.id).eq('status', 'confirmed')
        .gte('confirmed_at', today.toISOString()),
      supabase.from('projects').select('total_supply,marketplace_status,mints_paused').eq('id', req.params.id).single(),
    ]);
    const totalMinted = confirmed?.length || 0;
    const totalRevenueMojo = (confirmed || []).reduce((s, o) => s + Number(o.payment_amount_mojo), 0);
    res.json({
      mints_today: mintsToday || 0,
      total_minted: totalMinted,
      total_revenue_mojo: totalRevenueMojo,
      remaining: (project?.total_supply || 0) - totalMinted,
      mints_paused: project?.mints_paused || false,
      marketplace_status: project?.marketplace_status || 'draft',
    });
  });

  app.post('/api/marketplace/:id/pause', async (req, res) => {
    await supabase.from('projects').update({ mints_paused: true }).eq('id', req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/marketplace/:id/resume', async (req, res) => {
    await supabase.from('projects').update({ mints_paused: false }).eq('id', req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/marketplace/:id/reveal', async (req, res) => {
    await supabase.from('projects').update({ reveal_type: 'revealed' }).eq('id', req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/marketplace/:id/gift', async (req, res) => {
    const { recipient_address } = req.body;
    if (!recipient_address) return res.status(400).json({ error: 'recipient_address required' });

    const { data: project } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
    if (!project) return res.status(404).json({ error: 'Collection not found' });

    const { data: order, error } = await supabase
      .from('orders')
      .insert({
        project_id: req.params.id,
        payment_address: `gift_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        payment_amount_mojo: 0,
        buyer_address: recipient_address,
        status: 'payment_detected',
      })
      .select().single();

    if (error) return res.status(400).json({ error: error.message });

    const { mint } = require('./mint');
    mint(order.id, supabase).catch(e => console.warn('[gift] mint error:', e.message));
    res.json({ order_id: order.id });
  });

  app.get('/api/marketplace/:id/export', async (req, res) => {
    const { data } = await supabase
      .from('orders')
      .select('id,status,buyer_address,payment_address,payment_amount_mojo,tx_id,created_at,confirmed_at,generated_tokens(token_index)')
      .eq('project_id', req.params.id)
      .order('created_at');

    const rows = [
      'Order ID,Status,Buyer Address,Token Index,Payment Address,Amount XCH,Created At,Confirmed At,TX ID',
      ...(data || []).map(o => [
        o.id, o.status,
        o.buyer_address || '',
        o.generated_tokens?.token_index ?? '',
        o.payment_address,
        (Number(o.payment_amount_mojo) / 1e12).toFixed(6),
        o.created_at || '', o.confirmed_at || '', o.tx_id || '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="orders-${req.params.id}.csv"`);
    res.send(rows);
  });

  // ── Collection stats ──────────────────────────────────────────────────────────

  // Paginated volume aggregation — handles collections with >1000 transfers
  async function fetchVolume(collectionId, since) {
    let volumeMojo = 0, xchSales = 0, allTrades = 0, from = 0;
    while (true) {
      let q = supabase.from('nft_transfers').select('price_mojo')
        .eq('collection_id', collectionId);
      if (since) q = q.gte('transferred_at', since);
      const { data } = await q.range(from, from + 999);
      if (!data?.length) break;
      for (const r of data) {
        allTrades++;
        if (r.price_mojo != null) {
          volumeMojo += Number(r.price_mojo);
          xchSales++;
        }
      }
      if (data.length < 1000) break;
      from += 1000;
    }
    return { volumeMojo, xchSales, allTrades };
  }

  app.get('/api/marketplace/collections/:id/stats', async (req, res) => {
    const id = req.params.id;

    const now = new Date();
    const ago24h = new Date(now - 86400_000).toISOString();
    const ago7d  = new Date(now - 7 * 86400_000).toISOString();

    const [
      { count: indexed_count },
      { data: holderRows },
      { data: floorRow },
      { data: listedRow },
      vol24h,
      vol7d,
      volAll,
    ] = await Promise.all([
      supabase.from('indexed_nfts').select('nft_id', { count: 'exact', head: true }).eq('collection_id', id).not('owner_puzzle_hash', 'is', null).neq('owner_puzzle_hash', '0000000000000000000000000000000000000000000000000000000000000000'),
      supabase.from('indexed_nfts').select('owner_puzzle_hash').eq('collection_id', id).not('owner_puzzle_hash', 'is', null).neq('owner_puzzle_hash', '0000000000000000000000000000000000000000000000000000000000000000'),
      supabase.from('nft_offers').select('price_mojo').eq('collection_id', id).eq('status', 'open').eq('offer_type', 'ask').eq('price_token', 'xch').order('price_mojo', { ascending: true }).limit(1),
      supabase.from('nft_offers').select('*', { count: 'exact', head: true }).eq('collection_id', id).eq('status', 'open').eq('offer_type', 'ask'),
      fetchVolume(id, ago24h),
      fetchVolume(id, ago7d),
      fetchVolume(id),
    ]);

    const uniqueHolders = new Set((holderRows || []).map(r => r.owner_puzzle_hash)).size;
    const floor = floorRow?.[0]?.price_mojo ?? null;
    const listed = listedRow?.count ?? 0;

    res.json({
      collection_id:    id,
      indexed_count:    indexed_count || 0,
      unique_holders:   uniqueHolders,
      floor_mojo:       floor,
      listed_count:     listed,
      volume_24h_mojo:  vol24h.volumeMojo,
      volume_7d_mojo:   vol7d.volumeMojo,
      volume_all_mojo:  volAll.volumeMojo,
      sales_24h:        vol24h.allTrades,
      sales_7d:         vol7d.allTrades,
      sales_all:        volAll.allTrades,
    });
  });

  // ── Offer board — all open asks across all collections ────────────────────────

  app.get('/api/marketplace/offers/board', async (req, res) => {
    const sort   = req.query.sort || 'price';   // price | rarity | recent
    const page   = Math.max(0, parseInt(req.query.page) || 0);
    const limit  = 48;
    const offset = page * limit;

    let offersQuery = supabase
      .from('nft_offers')
      .select('id,nft_id,collection_id,price_mojo,offer_type,created_at,expires_at')
      .eq('status', 'open')
      .eq('offer_type', 'ask')
      .range(offset, offset + limit - 1);

    if (sort === 'price')  offersQuery = offersQuery.order('price_mojo', { ascending: true });
    if (sort === 'recent') offersQuery = offersQuery.order('created_at', { ascending: false });

    const { data: offers, error } = await offersQuery;
    if (error) return res.status(500).json({ error: error.message });
    if (!offers?.length) return res.json({ offers: [], total: 0 });

    const nftIds = [...new Set(offers.map(o => o.nft_id))];
    const colIds = [...new Set(offers.map(o => o.collection_id).filter(Boolean))];

    const [{ data: nftRows }, { data: colRows }] = await Promise.all([
      supabase.from('indexed_nfts').select('nft_id,name,token_index,image_url,rarity_rank,traits').in('nft_id', nftIds),
      supabase.from('indexed_collections').select('collection_id,name,thumbnail_uri').in('collection_id', colIds.length ? colIds : ['__none__']),
    ]);

    const nftMap = Object.fromEntries((nftRows || []).map(n => [n.nft_id, n]));
    const colMap = Object.fromEntries((colRows || []).map(c => [c.collection_id, c]));

    let enriched = offers.map(o => ({
      offer_id:       o.id,
      nft_id:         o.nft_id,
      price_mojo:     o.price_mojo,
      created_at:     o.created_at,
      expires_at:     o.expires_at,
      name:           nftMap[o.nft_id]?.name || null,
      token_index:    nftMap[o.nft_id]?.token_index ?? null,
      image_url:      nftMap[o.nft_id]?.image_url || null,
      rarity_rank:    nftMap[o.nft_id]?.rarity_rank || null,
      collection_id:  o.collection_id,
      collection_name: colMap[o.collection_id]?.name || o.collection_id?.slice(0, 12) + '…' || '',
      thumbnail_uri:  colMap[o.collection_id]?.thumbnail_uri || null,
    }));

    if (sort === 'rarity') enriched = enriched.sort((a, b) => (a.rarity_rank || 9999) - (b.rarity_rank || 9999));

    const { count: total } = await supabase
      .from('nft_offers').select('*', { count: 'exact', head: true })
      .eq('status', 'open').eq('offer_type', 'ask');

    res.json({ offers: enriched, total: total || 0 });
  });
};
