'use strict';

const PROXY = process.env.PROXY_URL || 'http://localhost:3001';

// In-memory traits cache (30 min when filterable, 2 min when not — backfill may still be running)
const traitsCache = new Map();
const TRAITS_TTL = 30 * 60 * 1000;
const TRAITS_TTL_PARTIAL = 2 * 60 * 1000;

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
const EXTERNAL_TTL = 10 * 60 * 1000;

function iqrFilter(prices) {
  if (prices.length < 6) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const q1  = sorted[Math.floor(sorted.length * 0.25)];
  const q3  = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr === 0) return prices;
  const lo = q1 - 5 * iqr;
  const hi = q3 + 5 * iqr;
  return prices.filter(p => p >= lo && p <= hi);
}

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

  // ── Creator public profile ────────────────────────────────────────────────────

  app.get('/api/marketplace/creator/:address', async (req, res) => {
    const { address } = req.params;
    const { data: collections } = await supabase
      .from('projects')
      .select('id,name,symbol,total_supply,mint_price_mojo,marketplace_status,minted_count,collection_image_url,collection_image_path,royalty_percent,created_at')
      .eq('creator_address', address)
      .not('marketplace_status', 'eq', 'draft')
      .order('created_at', { ascending: false });

    const totalMinted = (collections || []).reduce((s, c) => s + (c.minted_count || 0), 0);
    const totalRevenueMojo = (collections || []).reduce((s, c) => s + (c.mint_price_mojo || 0) * (c.minted_count || 0), 0);

    res.json({ address, collections: collections || [], total_minted: totalMinted, total_revenue_mojo: totalRevenueMojo });
  });

  // ── Creator earnings for a project ───────────────────────────────────────────

  app.get('/api/marketplace/:id/earnings', async (req, res) => {
    const { id } = req.params;
    const { data: proj } = await supabase
      .from('projects')
      .select('mint_price_mojo,creator_price_mojo,minted_count,royalty_percent')
      .eq('id', id)
      .maybeSingle();
    if (!proj) return res.status(404).json({ error: 'Not found' });

    // Daily confirmed orders for the last 30 days
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: orders } = await supabase
      .from('orders')
      .select('created_at')
      .eq('project_id', id)
      .in('status', ['confirmed', 'minting', 'minted'])
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    const byDay = {};
    for (const o of orders || []) {
      const day = (o.created_at || '').slice(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + 1;
    }

    const chart = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, mints]) => ({ date, mints }));

    const earningsPerMint = proj.creator_price_mojo ?? proj.mint_price_mojo ?? 0;
    res.json({
      primary_revenue_mojo: earningsPerMint * (proj.minted_count || 0),
      minted_count: proj.minted_count || 0,
      chart,
    });
  });

  // ── UTM page-view tracking ────────────────────────────────────────────────────

  app.post('/api/analytics/pageview', async (req, res) => {
    const { collection_id, utm_source, utm_medium, utm_campaign } = req.body;
    if (!collection_id || !utm_source) return res.json({ ok: true }); // only track UTM views
    await supabase.from('page_views').insert({ collection_id, utm_source, utm_medium: utm_medium || null, utm_campaign: utm_campaign || null });
    res.json({ ok: true });
  });

  app.get('/api/analytics/:id/referrals', async (req, res) => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data } = await supabase
      .from('page_views')
      .select('utm_source')
      .eq('collection_id', req.params.id)
      .gte('created_at', since);

    const counts = {};
    for (const r of data || []) counts[r.utm_source || 'unknown'] = (counts[r.utm_source || 'unknown'] || 0) + 1;
    res.json(Object.entries(counts).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count));
  });

  // ── Single collection ─────────────────────────────────────────────────────────

  app.get('/api/marketplace/:id', async (req, res, next) => {
    // Pass through to later-registered static routes that share this path prefix
    const STATIC_ROUTES = ['profile', 'rankings', 'activity', 'notable-sales', 'offers'];
    if (STATIC_ROUTES.includes(req.params.id)) return next();

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
    // MintGarden cursors are prefixed "mg_" to avoid colliding with numeric DB offsets.
    // DB cursors are plain integers (48, 96, …). Never send an mg_ cursor to the DB path.
    const isMgCursor = typeof cursor === 'string' && cursor.startsWith('mg_');

    if (!isMgCursor) {
      const offset = cursor && cursor !== '__more__' ? parseInt(cursor, 10) || 0 : 0;
      const sort = req.query.sort || 'default';
      const BURN_PH = '0000000000000000000000000000000000000000000000000000000000000000';
      let query = supabase
        .from('indexed_nfts')
        .select('nft_id,token_index,name,image_url,traits,metadata_uri,owner_puzzle_hash,rarity_rank')
        .eq('collection_id', id)
        .not('image_url', 'is', null)
        .filter('nft_id', 'not.like', '0x%')
        .or(`owner_puzzle_hash.is.null,owner_puzzle_hash.neq.${BURN_PH}`);

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
            image_url:    (n.image_url || '').replace('https://gateway.pinata.cloud/ipfs/', 'https://ipfs.mintgarden.io/ipfs/'),
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
      const mgPage = isMgCursor ? cursor.slice(3) : null;
      if (mgPage) mgUrl.searchParams.set('page', mgPage);

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
        next: json.next ? `mg_${json.next}` : null,
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
    const ttl = hit?.data?.filterable ? TRAITS_TTL : TRAITS_TTL_PARTIAL;
    if (hit && Date.now() - hit.time < ttl) return res.json(hit.data);

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
      const result = { filterable: true, traits: agg };
      traitsCache.set(id, { data: result, time: Date.now() });
      return res.json(result);
    }

    // External: aggregate from indexed_nfts (populated by nft-backfill.js)
    // Supabase caps results at 1000 rows per call, so paginate to collect all traits.
    const BURN_PH = '0000000000000000000000000000000000000000000000000000000000000000';
    const PAGE = 1000;
    const allIndexed = [];
    let offset = 0;
    while (true) {
      const { data: page } = await supabase
        .from('indexed_nfts')
        .select('traits')
        .eq('collection_id', id)
        .not('traits', 'is', null)
        .filter('nft_id', 'not.like', '0x%')
        .or(`owner_puzzle_hash.is.null,owner_puzzle_hash.neq.${BURN_PH}`)
        .range(offset, offset + PAGE - 1);
      if (!page?.length) break;
      allIndexed.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }

    if (allIndexed.length) {
      const withTraits = allIndexed.filter(t => t.traits && Object.keys(t.traits).length > 0);
      const { data: collInfo } = await supabase
        .from('indexed_collections').select('minted_count').eq('collection_id', id).maybeSingle();
      const totalSupply = collInfo?.minted_count || 0;

      // Only use DB counts when the backfill has covered ≥80% of the collection.
      const covered = totalSupply > 0 ? withTraits.length / totalSupply : 1;
      if (covered >= 0.8) {
        const agg = {};
        withTraits.forEach(t => {
          Object.entries(t.traits).forEach(([k, v]) => {
            if (!agg[k]) agg[k] = {};
            const val = String(v);
            agg[k][val] = (agg[k][val] || 0) + 1;
          });
        });
        const result = { filterable: true, traits: agg };
        traitsCache.set(id, { data: result, time: Date.now() });
        return res.json(result);
      }
    }

    // Last resort: fetch attributes_frequency_counts from MintGarden
    // filterable: false — per-NFT traits not in DB yet, can't JSONB-filter gallery
    try {
      const mgRes = await fetch(
        `https://api.mintgarden.io/collections/${encodeURIComponent(id)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
      );
      if (!mgRes.ok) return res.json({ filterable: false, traits: {} });
      const json = await mgRes.json();
      const traits = json.attributes_frequency_counts || {};
      const result = { filterable: false, traits };
      traitsCache.set(id, { data: result, time: Date.now() });
      return res.json(result);
    } catch (e) {
      return res.json({ filterable: false, traits: {} });
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

  // ── Floor items for sweep (cheapest N open asks for a collection) ────────────

  app.get('/api/marketplace/:id/floor-items', async (req, res) => {
    const id    = req.params.id;
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);
    const now   = new Date().toISOString();

    const { data: offers, error } = await supabase
      .from('nft_offers')
      .select('id,nft_id,price_mojo,price_token,maker_puzzle_hash')
      .eq('collection_id', id)
      .eq('offer_type', 'ask')
      .eq('status', 'open')
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('price_mojo', { ascending: true })
      .limit(limit);

    if (error) return res.status(400).json({ error: error.message });
    if (!offers?.length) return res.json([]);

    // Enrich with NFT metadata
    const nftIds = offers.map(o => o.nft_id).filter(Boolean);
    const { data: nftRows } = nftIds.length
      ? await supabase.from('indexed_nfts').select('nft_id,name,image_url,token_index').in('nft_id', nftIds)
      : { data: [] };

    const nftMap = Object.fromEntries((nftRows || []).map(n => [n.nft_id, n]));

    res.json(offers.map(o => {
      const nft = nftMap[o.nft_id] || {};
      const name = nft.name || (nft.token_index != null ? `#${nft.token_index + 1}` : null);
      return {
        offer_id:    o.id,
        nft_id:      o.nft_id,
        nft_name:    name || null,
        image_url:   nft.image_url ? (nft.image_url.replace('https://gateway.pinata.cloud/ipfs/', 'https://ipfs.mintgarden.io/ipfs/')) : null,
        price_mojo:  o.price_mojo,
        price_token: o.price_token || 'xch',
      };
    }));
  });

  // ── Collection bids ───────────────────────────────────────────────────────────

  app.get('/api/marketplace/:id/collection-bids', async (req, res) => {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('collection_bids')
      .select('*')
      .eq('collection_id', req.params.id)
      .eq('status', 'open')
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('price_mojo', { ascending: false })
      .limit(50);
    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  });

  app.post('/api/marketplace/:id/collection-bids', async (req, res) => {
    const { price_mojo, price_token, bidder_address, expires_at } = req.body;
    if (!price_mojo || !bidder_address) return res.status(400).json({ error: 'price_mojo and bidder_address required' });
    const { data, error } = await supabase
      .from('collection_bids')
      .insert({
        collection_id: req.params.id,
        price_mojo:    Number(price_mojo),
        price_token:   price_token || 'xch',
        bidder_address,
        expires_at:    expires_at || null,
      })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  app.delete('/api/marketplace/collection-bids/:bidId', async (req, res) => {
    const { error } = await supabase
      .from('collection_bids')
      .update({ status: 'cancelled' })
      .eq('id', req.params.bidId);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  });

  // Returns collection bids for collections where the given address owns NFTs
  app.get('/api/marketplace/collection-bids/for-owner/:address', async (req, res) => {
    let puzzleHex;
    try {
      const { bech32m: bm } = require('bech32');
      const d = bm.decode(String(req.params.address), 90);
      puzzleHex = Buffer.from(bm.fromWords(d.words)).toString('hex');
    } catch {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const { data: owned } = await supabase
      .from('indexed_nfts')
      .select('collection_id')
      .or(`owner_puzzle_hash.eq.${puzzleHex},owner_puzzle_hash.eq.0x${puzzleHex}`);

    const collectionIds = [...new Set((owned || []).map(n => n.collection_id).filter(Boolean))];
    if (!collectionIds.length) return res.json([]);

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('collection_bids')
      .select('*, indexed_collections!collection_bids_collection_id_fkey(name, thumbnail_url)')
      .in('collection_id', collectionIds)
      .eq('status', 'open')
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('price_mojo', { ascending: false })
      .limit(100);

    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  });

  app.post('/api/nft/:nftId/create-offer', async (req, res) => {
    const { nftId } = req.params;
    const { offer_type, price_mojo, token_id = 'xch', expires_at = null } = req.body;
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
      expires_at:   expires_at || null,
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify the NFT owner when someone places a bid
    if (offer_type === 'bid') {
      try {
        const { data: nftRow } = await supabase.from('indexed_nfts')
          .select('owner_puzzle_hash,name,token_index,collection_id').eq('nft_id', nftId).maybeSingle();
        if (nftRow?.owner_puzzle_hash) {
          const ownerAddr = puzzleHashToAddress(nftRow.owner_puzzle_hash);
          if (ownerAddr) {
            const nftLabel = nftRow.name || (nftRow.token_index != null ? `#${nftRow.token_index + 1}` : 'your NFT');
            const xchAmt = (priceAmount / 1e12).toFixed(priceAmount >= 1e12 ? 2 : 4).replace(/\.?0+$/, '');
            await supabase.from('notifications').insert({
              wallet_address: ownerAddr,
              type:     'offer_received',
              title:    `New offer on ${nftLabel}`,
              body:     `${xchAmt} XCH bid`,
              link_url: nftRow.collection_id ? `/marketplace/${nftRow.collection_id}?nft=${encodeURIComponent(nftId)}` : null,
            });
          }
        }
      } catch { /* non-critical */ }
    }

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

      // Notify the offer maker that their listing sold (ask) or bid was accepted (bid)
      try {
        if (offer.maker_puzzle_hash) {
          const makerAddr = puzzleHashToAddress(offer.maker_puzzle_hash);
          if (makerAddr) {
            const { data: nftRow } = await supabase.from('indexed_nfts')
              .select('name,token_index,collection_id').eq('nft_id', offer.nft_id).maybeSingle();
            const nftLabel = nftRow?.name || (nftRow?.token_index != null ? `#${nftRow.token_index + 1}` : 'NFT');
            const xchAmt = offer.price_mojo ? ((offer.price_mojo / 1e12).toFixed(2).replace(/\.?0+$/, '')) : '';
            const isAsk = offer.offer_type === 'ask';
            await supabase.from('notifications').insert({
              wallet_address: makerAddr,
              type:     isAsk ? 'offer_taken' : 'bid_accepted',
              title:    isAsk ? `${nftLabel} sold!` : `Your bid on ${nftLabel} was accepted`,
              body:     xchAmt ? `${xchAmt} XCH` : undefined,
              link_url: nftRow?.collection_id ? `/marketplace/${nftRow.collection_id}` : null,
            });
          }
        }
      } catch { /* non-critical */ }

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

  // Also handle POST for when nft_ids list is too long for a query string (260+ NFTs)
  async function handleProfileRequest(req, res) {
    const address = req.query.address || req.body?.address;
    if (!address) return res.status(400).json({ error: 'address required' });

    // nft_ids can come from query string (small lists) or POST body (large lists)
    const rawIds = req.body?.nft_ids || req.query.nft_ids;
    const nftIds = Array.isArray(rawIds)
      ? rawIds
      : typeof rawIds === 'string'
        ? rawIds.split(',').map(s => s.trim()).filter(Boolean)
        : null;

    // Always decode the address to a puzzle hash for the primary-address query
    let puzzleHex;
    try {
      const d = bech32m.decode(String(address), 90);
      puzzleHex = Buffer.from(bech32m.fromWords(d.words)).toString('hex');
    } catch {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const SELECT = 'nft_id,name,token_index,image_url,traits,collection_id,rarity_rank,rarity_score';

    // Run both queries in parallel and merge:
    // 1. puzzle-hash query  → NFTs at the primary address (e.g. all Meowfers)
    // 2. nft_id query       → NFTs at other wallet derivation addresses (other collections)
    const [phResult, idResult] = await Promise.all([
      supabase.from('indexed_nfts').select(SELECT)
        .or(`owner_puzzle_hash.eq.${puzzleHex},owner_puzzle_hash.eq.0x${puzzleHex}`)
        .order('collection_id', { ascending: true })
        .order('token_index', { ascending: true, nullsFirst: false }),
      nftIds?.length
        ? supabase.from('indexed_nfts').select(SELECT)
            .in('nft_id', nftIds)
            .order('collection_id', { ascending: true })
            .order('token_index', { ascending: true, nullsFirst: false })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (phResult.error) return res.status(500).json({ error: phResult.error.message });

    // Merge, deduplicate by nft_id
    const seen = new Set();
    const nfts = [...(phResult.data || []), ...(idResult.data || [])].filter(n => {
      if (seen.has(n.nft_id)) return false;
      seen.add(n.nft_id);
      return true;
    });

    if (phResult.error) return res.status(500).json({ error: phResult.error.message });

    const collectionIds = [...new Set((nfts || []).map(n => n.collection_id).filter(Boolean))];
    const uncategorised = (nfts || []).filter(n => !n.collection_id).length;

    const { data: colRows } = await supabase
      .from('indexed_collections')
      .select('collection_id,name,thumbnail_url')
      .in('collection_id', collectionIds.length ? collectionIds : ['__none__']);

    const colMap = Object.fromEntries((colRows || []).map(c => [c.collection_id, c]));

    const collectionCounts = {};
    (nfts || []).forEach(n => {
      const key = n.collection_id || '__other__';
      collectionCounts[key] = (collectionCounts[key] || 0) + 1;
    });

    const collections = [
      ...collectionIds.map(id => ({
        id,
        name: colMap[id]?.name || id.slice(0, 12) + '…',
        thumbnail_url: colMap[id]?.thumbnail_url || null,
        count: collectionCounts[id] || 0,
      })),
      ...(uncategorised > 0 ? [{ id: '__other__', name: 'Other', thumbnail_url: null, count: uncategorised }] : []),
    ].sort((a, b) => b.count - a.count);

    res.json({ nfts: nfts || [], collections });
  }

  app.get('/api/marketplace/profile', handleProfileRequest);
  app.post('/api/marketplace/profile', handleProfileRequest);


  // ── Debug: what does the wallet daemon see? ───────────────────────────────────

  app.get('/api/debug/wallet-nfts', async (req, res) => {
    try {
      const { wallets } = await walletRpc('get_wallets', { include_data: false });
      const nftWallets = (wallets || []).filter(w => w.type === 10);
      const result = [];
      for (const w of nftWallets) {
        try {
          const { nft_list } = await walletRpc('nft_get_nfts', { wallet_id: w.id });
          result.push({ wallet_id: w.id, name: w.name, count: (nft_list || []).length,
            nfts: (nft_list || []).map(n => ({ launcher_id: n.launcher_id, minter_did: n.minter_did })) });
        } catch (e) {
          result.push({ wallet_id: w.id, name: w.name, error: e.message });
        }
      }
      res.json({ nft_wallet_count: nftWallets.length, wallets: result });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // ── Profile wallet sync — index any owned NFTs not yet in the DB ─────────────
  // Queries the local wallet daemon for all NFTs, fetches IPFS metadata for
  // any not already in indexed_nfts, and upserts them so the profile page shows
  // the full wallet contents even for collections the block crawler hasn't hit yet.

  // The address of the site/node operator. When set, sync returns wallet daemon
  // NFTs for this address (and only this address) even without a connected browser wallet.
  // Set PROFILE_OWNER_ADDRESS in .env to the operator's primary XCH address.
  const PROFILE_OWNER_ADDRESS = (process.env.PROFILE_OWNER_ADDRESS || '').toLowerCase().trim();

  app.post('/api/marketplace/profile/sync', async (req, res) => {
    try {
      const requestedAddress = (req.body?.address || '').toLowerCase().trim();

      // If an address is provided and PROFILE_OWNER_ADDRESS is configured,
      // only return wallet NFTs when the request is for the owner's address.
      // This prevents a visitor from accidentally loading the operator's wallet
      // into someone else's profile view.
      if (requestedAddress && PROFILE_OWNER_ADDRESS && requestedAddress !== PROFILE_OWNER_ADDRESS) {
        return res.json({ synced: 0, total: 0, nft_ids: [] });
      }

      const { wallets } = await walletRpc('get_wallets', { include_data: false });
      const nftWallets = (wallets || []).filter(w => w.type === 10);

      // Collect all NFTs from every NFT wallet; normalize nft_id to 0x-prefixed hex
      const allNfts = [];
      for (const w of nftWallets) {
        try {
          const { nft_list } = await walletRpc('nft_get_nfts', { wallet_id: w.id });
          for (const nft of (nft_list || [])) {
            const rawHex = (nft.launcher_id || '').replace('0x', '').toLowerCase();
            if (rawHex) allNfts.push({ nftId: `0x${rawHex}`, nft });
          }
        } catch { /* skip wallets that fail */ }
      }

      if (!allNfts.length) return res.json({ synced: 0, total: 0, nft_ids: [] });


      // Find which are already in indexed_nfts (DB stores with 0x prefix)
      const { data: existing } = await supabase
        .from('indexed_nfts')
        .select('nft_id,collection_id')
        .in('nft_id', allNfts.map(n => n.nftId));
      const indexedSet = new Set((existing || []).map(r => r.nft_id.toLowerCase()));

      // Also re-fetch metadata for stubs that were inserted without a collection_id
      const needsMetadata = new Set(
        (existing || []).filter(r => !r.collection_id).map(r => r.nft_id.toLowerCase())
      );

      const toInsert  = allNfts.filter(n => !indexedSet.has(n.nftId.toLowerCase()));
      const toRefetch = allNfts.filter(n => needsMetadata.has(n.nftId.toLowerCase()));

      // ── Phase 1: fast stub insert (no IPFS) — image comes from data_uris ──────
      for (const { nftId, nft } of toInsert) {
        try {
          const imageUri = (nft.data_uris || [])[0] || null;
          const imageUrl = imageUri
            ? (imageUri.startsWith('ipfs://')
                ? `https://gateway.pinata.cloud/ipfs/${imageUri.replace('ipfs://', '')}`
                : imageUri)
            : null;
          await supabase.from('indexed_nfts').upsert({
            nft_id:            nftId,
            image_url:         imageUrl,
            metadata_uri:      (nft.metadata_uris || [])[0] || null,
            data_hash:         (nft.data_hash     || '').replace('0x', '') || null,
            meta_hash:         (nft.metadata_hash || '').replace('0x', '') || null,
            owner_puzzle_hash: (nft.p2_address    || '').replace('0x', '') || null,
            minter_did:        (nft.minter_did    || '').replace('0x', '') || null,
            updated_at:        new Date().toISOString(),
          }, { onConflict: 'nft_id' });
        } catch { /* skip */ }
      }

      // Respond immediately with all wallet IDs so the profile can load
      res.json({ synced: toInsert.length, total: allNfts.length, nft_ids: allNfts.map(n => n.nftId) });

      // ── Phase 2: background IPFS metadata fetch (3 concurrent) ───────────────
      const needFetch = [...toInsert, ...toRefetch];
      if (!needFetch.length) return;

      async function fetchAndUpdateMeta({ nftId, nft }) {
        const metadataUri = (nft.metadata_uris || [])[0] || null;
        const imageUri    = (nft.data_uris || [])[0] || null;
        const minterDid   = (nft.minter_did || '').replace('0x', '') || null;
        const imageUrl    = imageUri
          ? (imageUri.startsWith('ipfs://')
              ? `https://gateway.pinata.cloud/ipfs/${imageUri.replace('ipfs://', '')}`
              : imageUri)
          : null;

        let meta = null;
        if (metadataUri) {
          const url = metadataUri.startsWith('ipfs://')
            ? `https://gateway.pinata.cloud/ipfs/${metadataUri.replace('ipfs://', '')}`
            : metadataUri;
          try {
            const mr = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
            if (mr.ok && (mr.headers.get('content-type') || '').includes('json')) meta = await mr.json();
          } catch { /* leave meta null */ }
        }

        const collectionId = meta?.collection?.id || null;
        const traits       = meta?.attributes
          ? Object.fromEntries(meta.attributes.map(a => [a.trait_type, String(a.value)]))
          : {};

        if (collectionId) {
          const collectionAttrs = meta?.collection?.attributes || [];
          const iconAttr = collectionAttrs.find(a => a.type === 'icon');
          const thumbUrl = iconAttr?.value
            ? (iconAttr.value.startsWith('ipfs://')
                ? `https://gateway.pinata.cloud/ipfs/${iconAttr.value.replace('ipfs://', '')}`
                : iconAttr.value)
            : imageUrl;
          const { data: ec } = await supabase.from('indexed_collections')
            .select('thumbnail_url,verified,floor_price_mojo,total_supply,minted_count,source')
            .eq('collection_id', collectionId).maybeSingle();
          await supabase.from('indexed_collections').upsert({
            collection_id:    collectionId,
            name:             meta?.collection?.name || 'Unknown Collection',
            thumbnail_url:    thumbUrl || ec?.thumbnail_url || null,
            total_supply:     meta?.series_total || ec?.total_supply || 0,
            minted_count:     (ec?.minted_count || 0) + (ec ? 0 : 1),
            floor_price_mojo: ec?.floor_price_mojo || 0,
            creator_did:      minterDid || null,
            source:           ec?.source || 'wallet-sync',
            verified:         ec?.verified || false,
            updated_at:       new Date().toISOString(),
          }, { onConflict: 'collection_id' });
        }

        await supabase.from('indexed_nfts').upsert({
          nft_id:        nftId,
          collection_id: collectionId,
          token_index:   meta?.series_number != null ? meta.series_number - 1 : null,
          name:          meta?.name || null,
          image_url:     imageUrl,
          traits,
          updated_at:    new Date().toISOString(),
        }, { onConflict: 'nft_id' });
      }

      // Run 3 IPFS fetches at a time
      const CONCURRENCY = 3;
      for (let i = 0; i < needFetch.length; i += CONCURRENCY) {
        await Promise.allSettled(needFetch.slice(i, i + CONCURRENCY).map(fetchAndUpdateMeta));
      }
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: e.message });
    }
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
      supabase.from('indexed_nfts').select('nft_id', { count: 'exact', head: true }).eq('collection_id', id).not('image_url', 'is', null),
      supabase.from('indexed_nfts').select('owner_puzzle_hash').eq('collection_id', id).not('owner_puzzle_hash', 'is', null).neq('owner_puzzle_hash', '0000000000000000000000000000000000000000000000000000000000000000'),
      supabase.from('nft_offers').select('price_mojo').eq('collection_id', id).eq('status', 'open').eq('offer_type', 'ask').eq('price_token', 'xch').or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).order('price_mojo', { ascending: true }).limit(1),
      supabase.from('nft_offers').select('*', { count: 'exact', head: true }).eq('collection_id', id).eq('status', 'open').eq('offer_type', 'ask').or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
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

  // ── Collection activity feed ─────────────────────────────────────────────────

  app.get('/api/marketplace/collections/:id/activity', async (req, res) => {
    const id     = req.params.id;
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const PAGE   = 50;

    // Fetch recent transfers + first 500 nft_ids (for offers lookup) in parallel
    const [{ data: transfers }, { data: collNfts }] = await Promise.all([
      supabase
        .from('nft_transfers')
        .select('nft_id,price_mojo,price_token,from_puzzle_hash,to_puzzle_hash,block_height,transferred_at')
        .eq('collection_id', id)
        .not('transferred_at', 'is', null)
        .order('transferred_at', { ascending: false })
        .range(offset, offset + PAGE - 1),
      supabase
        .from('indexed_nfts')
        .select('nft_id')
        .eq('collection_id', id)
        .limit(500),
    ]);

    // Normalise collNftIds to bech32m so offers lookup works regardless of format
    const collNftIds = (collNfts || []).map(n => {
      if (n.nft_id.startsWith('0x')) {
        try {
          const words = bech32m.toWords(Buffer.from(n.nft_id.slice(2), 'hex'));
          return bech32m.encode('nft', words);
        } catch {}
      }
      return n.nft_id;
    });

    // Offers lookup via nft_id (collection_id not always set on offers)
    const { data: listings } = collNftIds.length
      ? await supabase
          .from('nft_offers')
          .select('id,nft_id,offer_type,price_mojo,price_token,maker_puzzle_hash,created_at,status')
          .in('nft_id', collNftIds)
          .order('created_at', { ascending: false })
          .limit(50)
      : { data: [] };

    // Enrich with names/images
    const allNftIds = [...new Set([
      ...(transfers || []).map(t => t.nft_id),
      ...(listings  || []).map(l => l.nft_id),
    ].filter(Boolean))];

    // Also include 0x-hex variants so we match backfill-indexed_nfts entries
    const hexVariants = allNftIds.map(id => {
      const hex = decodeNftId(id);
      return hex ? `0x${hex}` : null;
    }).filter(Boolean);

    const { data: nftRows } = allNftIds.length
      ? await supabase
          .from('indexed_nfts')
          .select('nft_id,name,token_index,image_url')
          .in('nft_id', [...allNftIds, ...hexVariants])
      : { data: [] };

    // Normalize map: 0x-hex entries are keyed by their bech32m equivalent
    const nftMap = {};
    for (const n of (nftRows || [])) {
      nftMap[n.nft_id] = n;
      if (n.nft_id.startsWith('0x')) {
        try {
          const words = bech32m.toWords(Buffer.from(n.nft_id.slice(2), 'hex'));
          nftMap[bech32m.encode('nft', words)] = n;
        } catch {}
      }
    }

    const events = [];

    for (const t of (transfers || [])) {
      events.push({
        event_type:   t.price_mojo != null ? 'sale' : 'transfer',
        nft_id:       t.nft_id,
        nft_name:     nftMap[t.nft_id]?.name     || null,
        token_index:  nftMap[t.nft_id]?.token_index ?? null,
        image_url:    nftMap[t.nft_id]?.image_url || null,
        price_mojo:   t.price_mojo,
        price_token:  t.price_token || 'xch',
        from_address: puzzleHashToAddress(t.from_puzzle_hash),
        to_address:   puzzleHashToAddress(t.to_puzzle_hash),
        block_height: t.block_height,
        timestamp:    t.transferred_at,
      });
    }

    for (const l of (listings || [])) {
      const ev = l.offer_type === 'ask'
        ? (l.status === 'taken' ? 'sale' : l.status === 'cancelled' ? 'listing_cancelled' : 'listing')
        : (l.status === 'taken' ? 'sale' : 'offer');
      events.push({
        event_type:   ev,
        nft_id:       l.nft_id,
        nft_name:     nftMap[l.nft_id]?.name     || null,
        token_index:  nftMap[l.nft_id]?.token_index ?? null,
        image_url:    nftMap[l.nft_id]?.image_url || null,
        price_mojo:   l.price_mojo,
        price_token:  l.price_token || 'xch',
        from_address: puzzleHashToAddress(l.maker_puzzle_hash),
        to_address:   null,
        block_height: null,
        timestamp:    l.created_at,
      });
    }

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ events: events.slice(0, PAGE), hasMore: events.length >= PAGE });
  });

  // ── Offer board — all open asks across all collections ────────────────────────

  app.get('/api/marketplace/offers/board', async (req, res) => {
    // Lightweight check: which of a specific set of NFTs have active asks?
    // Used by the profile page to show "Listed" badges without loading the full board.
    if (req.query.nft_ids) {
      const ids = String(req.query.nft_ids).split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
      const { data } = await supabase
        .from('nft_offers').select('nft_id')
        .in('nft_id', ids).eq('status', 'open').eq('offer_type', 'ask');
      return res.json({ offers: (data || []).map(o => ({ nft_id: o.nft_id })) });
    }

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

  // ── Rankings ─────────────────────────────────────────────────────────────────

  app.get('/api/marketplace/rankings', async (req, res) => {
    const sort  = req.query.sort || 'volume_7d';   // volume_7d | volume_24h | floor | trending | sales_7d
    const limit = Math.min(200, parseInt(req.query.limit) || 100);

    const col = {
      volume_7d:   'volume_7d_mojo',
      volume_24h:  'volume_24h_mojo',
      floor:       'floor_price_mojo',
      trending:    'trending_score',
      sales_7d:    'sales_7d',
    }[sort] || 'volume_7d_mojo';

    const { data, error } = await supabase
      .from('indexed_collections')
      .select('collection_id,name,thumbnail_url,thumbnail_uri,verified,total_supply,minted_count,floor_price_mojo,volume_24h_mojo,volume_7d_mojo,sales_24h,sales_7d,listed_count,trending_score,source')
      .not(col, 'is', null)
      .gt(col, 0)
      .order(col, { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── Global activity feed ──────────────────────────────────────────────────────

  app.get('/api/marketplace/activity', async (req, res) => {
    const type   = req.query.type   || 'all';  // all | sale | transfer | listing | offer
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const PAGE   = 50;

    // Optional address filter for profile activity tab.
    // Dexie-sourced transfers store nft_id (bech32m) but have null puzzle hashes,
    // so we filter by the set of nft_ids the address owns rather than by puzzle hash.
    let addressNftIds = null;  // null = no filter (global feed)
    if (req.query.address) {
      try {
        const d = bech32m.decode(String(req.query.address), 90);
        const puzzleHex = Buffer.from(bech32m.fromWords(d.words)).toString('hex');

        // Fetch all nft_ids owned by this address from indexed_nfts
        const { data: ownedNfts } = await supabase
          .from('indexed_nfts')
          .select('nft_id')
          .or(`owner_puzzle_hash.eq.${puzzleHex},owner_puzzle_hash.eq.0x${puzzleHex}`)
          .limit(500);

        // Normalise to bech32m (nft1...) — that's what nft_transfers.nft_id stores
        addressNftIds = (ownedNfts || []).map(n => {
          if (n.nft_id && n.nft_id.startsWith('0x')) {
            try {
              const words = bech32m.toWords(Buffer.from(n.nft_id.slice(2), 'hex'));
              return bech32m.encode('nft', words);
            } catch { return null; }
          }
          return n.nft_id; // already bech32m
        }).filter(Boolean);

        if (!addressNftIds.length) return res.json({ events: [], hasMore: false });
      } catch { /* invalid address — ignore filter */ }
    }

    // Transfers
    let xferQuery = supabase
      .from('nft_transfers')
      .select('nft_id,collection_id,price_mojo,price_token,from_puzzle_hash,to_puzzle_hash,transferred_at')
      .not('transferred_at', 'is', null)
      .order('transferred_at', { ascending: false });

    if (type === 'sale')     xferQuery = xferQuery.not('price_mojo', 'is', null);
    if (type === 'transfer') xferQuery = xferQuery.is('price_mojo', null);
    if (addressNftIds)       xferQuery = xferQuery.in('nft_id', addressNftIds);

    // Offers
    let offerQuery = supabase
      .from('nft_offers')
      .select('id,nft_id,collection_id,offer_type,price_mojo,price_token,maker_puzzle_hash,created_at,status')
      .order('created_at', { ascending: false });

    if (addressNftIds) offerQuery = offerQuery.in('nft_id', addressNftIds);

    const includeXfers  = ['all', 'sale', 'transfer'].includes(type);
    const includeOffers = ['all', 'listing', 'offer'].includes(type);

    const [xferRes, offerRes] = await Promise.all([
      includeXfers  ? xferQuery.range(offset, offset + PAGE - 1)  : { data: [] },
      includeOffers ? offerQuery.range(offset, offset + PAGE - 1) : { data: [] },
    ]);

    // Collect unique IDs for enrichment
    const allNftIds = [...new Set([
      ...(xferRes.data  || []).map(t => t.nft_id),
      ...(offerRes.data || []).map(o => o.nft_id),
    ].filter(Boolean))];

    const allColIds = [...new Set([
      ...(xferRes.data  || []).map(t => t.collection_id),
      ...(offerRes.data || []).map(o => o.collection_id),
    ].filter(Boolean))];

    const [{ data: nftRows }, { data: colRows }] = await Promise.all([
      allNftIds.length
        ? supabase.from('indexed_nfts').select('nft_id,name,token_index,image_url').in('nft_id', allNftIds.slice(0, 100))
        : { data: [] },
      allColIds.length
        ? supabase.from('indexed_collections').select('collection_id,name,thumbnail_url').in('collection_id', allColIds.slice(0, 100))
        : { data: [] },
    ]);

    const nftMap = Object.fromEntries((nftRows || []).map(n => [n.nft_id, n]));
    const colMap = Object.fromEntries((colRows || []).map(c => [c.collection_id, c]));

    const events = [];

    for (const t of (xferRes.data || [])) {
      events.push({
        event_type:       t.price_mojo != null ? 'sale' : 'transfer',
        nft_id:           t.nft_id,
        nft_name:         nftMap[t.nft_id]?.name || null,
        token_index:      nftMap[t.nft_id]?.token_index ?? null,
        image_url:        nftMap[t.nft_id]?.image_url || null,
        collection_id:    t.collection_id,
        collection_name:  colMap[t.collection_id]?.name || null,
        collection_thumb: colMap[t.collection_id]?.thumbnail_url || null,
        price_mojo:       t.price_mojo,
        price_token:      t.price_token || 'xch',
        from_address:     puzzleHashToAddress(t.from_puzzle_hash),
        to_address:       puzzleHashToAddress(t.to_puzzle_hash),
        timestamp:        t.transferred_at,
      });
    }

    for (const o of (offerRes.data || [])) {
      const ev = o.offer_type === 'ask'
        ? (o.status === 'cancelled' ? 'listing_cancelled' : 'listing')
        : 'offer';
      events.push({
        event_type:       ev,
        nft_id:           o.nft_id,
        nft_name:         nftMap[o.nft_id]?.name || null,
        token_index:      nftMap[o.nft_id]?.token_index ?? null,
        image_url:        nftMap[o.nft_id]?.image_url || null,
        collection_id:    o.collection_id,
        collection_name:  colMap[o.collection_id]?.name || null,
        collection_thumb: colMap[o.collection_id]?.thumbnail_url || colMap[o.collection_id]?.thumbnail_uri || null,
        price_mojo:       o.price_mojo,
        price_token:      o.price_token || 'xch',
        from_address:     puzzleHashToAddress(o.maker_puzzle_hash),
        to_address:       null,
        timestamp:        o.created_at,
      });
    }

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const page = events.slice(0, PAGE);
    res.json({ events: page, hasMore: page.length >= PAGE });
  });

  // ── Notable sales (top sales last 7 days) ─────────────────────────────────────

  app.get('/api/marketplace/notable-sales', async (req, res) => {
    const days  = Math.min(30, parseInt(req.query.days) || 7);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data: transfers } = await supabase
      .from('nft_transfers')
      .select('nft_id,collection_id,price_mojo,price_token,transferred_at')
      .not('price_mojo', 'is', null)
      .gte('transferred_at', since)
      .order('price_mojo', { ascending: false })
      .limit(limit);

    if (!transfers?.length) return res.json([]);

    const nftIds = transfers.map(t => t.nft_id).filter(Boolean);
    const colIds = [...new Set(transfers.map(t => t.collection_id).filter(Boolean))];

    const [{ data: nftRows }, { data: colRows }] = await Promise.all([
      nftIds.length ? supabase.from('indexed_nfts').select('nft_id,name,token_index,image_url,rarity_rank').in('nft_id', nftIds) : { data: [] },
      colIds.length ? supabase.from('indexed_collections').select('collection_id,name,thumbnail_url,thumbnail_uri').in('collection_id', colIds) : { data: [] },
    ]);

    const nftMap = Object.fromEntries((nftRows || []).map(n => [n.nft_id, n]));
    const colMap = Object.fromEntries((colRows || []).map(c => [c.collection_id, c]));

    res.json(transfers.map(t => ({
      nft_id:           t.nft_id,
      name:             nftMap[t.nft_id]?.name || null,
      token_index:      nftMap[t.nft_id]?.token_index ?? null,
      image_url:        nftMap[t.nft_id]?.image_url || null,
      rarity_rank:      nftMap[t.nft_id]?.rarity_rank || null,
      collection_id:    t.collection_id,
      collection_name:  colMap[t.collection_id]?.name || null,
      collection_thumb: colMap[t.collection_id]?.thumbnail_url || null,
      price_mojo:       t.price_mojo,
      price_token:      t.price_token || 'xch',
      sold_at:          t.transferred_at,
    })));
  });

  // ── Favorites ─────────────────────────────────────────────────────────────────

  app.get('/api/favorites', async (req, res) => {
    const { address, type } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    let q = supabase.from('favorites').select('item_type,item_id,created_at').eq('wallet_address', address);
    if (type) q = q.eq('item_type', type);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  app.post('/api/favorites', async (req, res) => {
    const { address, item_type, item_id } = req.body;
    if (!address || !item_type || !item_id) return res.status(400).json({ error: 'address, item_type, item_id required' });
    const { error } = await supabase.from('favorites')
      .upsert({ wallet_address: address, item_type, item_id }, { onConflict: 'wallet_address,item_type,item_id' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  app.delete('/api/favorites/:itemType/:itemId', async (req, res) => {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    const { error } = await supabase.from('favorites').delete()
      .eq('wallet_address', address)
      .eq('item_type', req.params.itemType)
      .eq('item_id', decodeURIComponent(req.params.itemId));
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // Enrich favorited collections with live market data for the Watchlist page
  app.get('/api/favorites/collections', async (req, res) => {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    const { data: favs } = await supabase.from('favorites').select('item_id')
      .eq('wallet_address', address).eq('item_type', 'collection');
    if (!favs?.length) return res.json([]);
    const ids = favs.map(f => f.item_id);
    const { data: cols } = await supabase.from('indexed_collections')
      .select('collection_id,name,thumbnail_url,thumbnail_uri,verified,total_supply,minted_count,floor_price_mojo,volume_7d_mojo,sales_7d,trending_score,listed_count')
      .in('collection_id', ids);
    res.json((cols || []).map(c => ({
      id:              c.collection_id,
      name:            c.name,
      thumbnail_url:   c.thumbnail_url || c.thumbnail_uri || '',
      verified:        c.verified || false,
      total_supply:    c.total_supply || 0,
      minted_count:    c.minted_count || 0,
      floor_price_mojo: c.floor_price_mojo || 0,
      volume_7d_mojo:  c.volume_7d_mojo || 0,
      sales_7d:        c.sales_7d || 0,
      trending_score:  c.trending_score || 0,
      listed_count:    c.listed_count || 0,
    })));
  });

  // ── User profiles ─────────────────────────────────────────────────────────────

  app.get('/api/user-profile/:address', async (req, res) => {
    const { data } = await supabase.from('user_profiles').select('*')
      .eq('address', req.params.address).maybeSingle();
    res.json(data || { address: req.params.address });
  });

  app.put('/api/user-profile/:address', async (req, res) => {
    const { display_name, bio, twitter_handle, website_url } = req.body;
    const { data, error } = await supabase.from('user_profiles')
      .upsert({
        address:       req.params.address,
        display_name:  display_name  || null,
        bio:           bio           || null,
        twitter_handle: twitter_handle || null,
        website_url:   website_url   || null,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'address' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // ── Notifications ─────────────────────────────────────────────────────────────

  app.get('/api/notifications', async (req, res) => {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    const { data, error } = await supabase.from('notifications').select('*')
      .eq('wallet_address', address).order('created_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  app.post('/api/notifications/read-all', async (req, res) => {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    await supabase.from('notifications').update({ read: true })
      .eq('wallet_address', address).eq('read', false);
    res.json({ ok: true });
  });

  app.post('/api/notifications/:notifId/read', async (req, res) => {
    await supabase.from('notifications').update({ read: true }).eq('id', req.params.notifId);
    res.json({ ok: true });
  });

  // ── Token list ────────────────────────────────────────────────────────────────

  app.get('/api/tokens', async (req, res) => {
    const limit  = Math.min(200, parseInt(req.query.limit) || 100);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const search = (req.query.q || '').trim().toLowerCase();

    // Join cat_tokens with tibet_pairs for price + reserves
    let q = supabase
      .from('cat_tokens')
      .select(`
        asset_id, name, short_name, image_url, tibet_pair_id, updated_at,
        tibet_pairs ( xch_reserve, token_reserve, current_price_xch, fee_rate )
      `)
      .order('asset_id');

    if (search) {
      q = q.or(`name.ilike.%${search}%,short_name.ilike.%${search}%,asset_id.ilike.%${search}%`);
    }

    const { data: tokens, error } = await q.range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: error.message });

    // Compute 24h volume from cat_transfers
    const since24h = new Date(Date.now() - 86_400_000).toISOString();
    const assetIds = (tokens || []).map(t => t.asset_id);

    let vol24h = {};
    if (assetIds.length) {
      const { data: vols } = await supabase
        .from('cat_transfers')
        .select('asset_id, volume_xch')
        .in('asset_id', assetIds)
        .gte('transferred_at', since24h)
        .not('volume_xch', 'is', null);

      for (const v of (vols || [])) {
        vol24h[v.asset_id] = (vol24h[v.asset_id] || 0) + Number(v.volume_xch);
      }
    }

    res.json((tokens || []).map(t => {
      const pair = Array.isArray(t.tibet_pairs) ? t.tibet_pairs[0] : t.tibet_pairs;
      return {
        asset_id:          t.asset_id,
        name:              t.name,
        short_name:        t.short_name,
        image_url:         t.image_url,
        tibet_pair_id:     t.tibet_pair_id,
        current_price_xch: pair?.current_price_xch ?? null,
        xch_reserve:       pair?.xch_reserve ?? null,
        token_reserve:     pair?.token_reserve ?? null,
        volume_24h_xch:    vol24h[t.asset_id] || 0,
      };
    }));
  });

  // ── Token detail ──────────────────────────────────────────────────────────────

  app.get('/api/tokens/:assetId', async (req, res) => {
    const assetId = req.params.assetId.toLowerCase();

    const [{ data: token }, { data: pair }] = await Promise.all([
      supabase.from('cat_tokens').select('*').eq('asset_id', assetId).maybeSingle(),
      supabase.from('tibet_pairs').select('*').eq('asset_id', assetId).maybeSingle(),
    ]);

    if (!token) return res.status(404).json({ error: 'Token not found' });

    // 24h stats
    const since24h = new Date(Date.now() - 86_400_000).toISOString();
    const since7d  = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const [{ data: stats24h }, { data: stats7d }, { data: lastTrade }] = await Promise.all([
      supabase.from('cat_transfers').select('price_xch, volume_xch')
        .eq('asset_id', assetId).gte('transferred_at', since24h).not('price_xch', 'is', null),
      supabase.from('cat_transfers').select('volume_xch')
        .eq('asset_id', assetId).gte('transferred_at', since7d).not('volume_xch', 'is', null),
      supabase.from('cat_transfers').select('price_xch, transferred_at')
        .eq('asset_id', assetId).not('price_xch', 'is', null)
        .order('transferred_at', { ascending: false }).limit(1),
    ]);

    const rawPrices24h = (stats24h || []).map(r => Number(r.price_xch));
    const prices24h    = iqrFilter(rawPrices24h);
    const volume24hXch = (stats24h || []).reduce((s, r) => s + Number(r.volume_xch || 0), 0);
    const volume7dXch  = (stats7d  || []).reduce((s, r) => s + Number(r.volume_xch || 0), 0);
    const high24h      = prices24h.length ? Math.max(...prices24h) : null;
    const low24h       = prices24h.length ? Math.min(...prices24h) : null;

    res.json({
      asset_id:          token.asset_id,
      name:              token.name,
      short_name:        token.short_name,
      image_url:         token.image_url,
      tibet_pair_id:     token.tibet_pair_id,
      current_price_xch: pair?.current_price_xch ?? null,
      xch_reserve:       pair?.xch_reserve ?? null,
      token_reserve:     pair?.token_reserve ?? null,
      fee_rate:          pair?.fee_rate ?? null,
      last_trade_at:     lastTrade?.[0]?.transferred_at ?? null,
      last_price_xch:    lastTrade?.[0]?.price_xch ?? null,
      high_24h_xch:      high24h,
      low_24h_xch:       low24h,
      volume_24h_xch:    volume24hXch,
      volume_7d_xch:     volume7dXch,
    });
  });

  // ── Token OHLCV ───────────────────────────────────────────────────────────────

  app.get('/api/tokens/:assetId/ohlcv', async (req, res) => {
    const assetId   = req.params.assetId.toLowerCase();
    const timeframe = ['1h','4h','1d','1w','1m'].includes(req.query.timeframe)
      ? req.query.timeframe : '1d';
    const limit  = Math.min(500, parseInt(req.query.limit) || 200);

    const { data, error } = await supabase
      .from('cat_ohlcv')
      .select('bucket_start, open, high, low, close, volume_xch, trade_count')
      .eq('asset_id', assetId)
      .eq('timeframe', timeframe)
      .order('bucket_start', { ascending: true })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── Token recent trades ───────────────────────────────────────────────────────

  app.get('/api/tokens/:assetId/trades', async (req, res) => {
    const assetId = req.params.assetId.toLowerCase();
    const limit   = Math.min(100, parseInt(req.query.limit) || 50);
    const offset  = Math.max(0, parseInt(req.query.offset) || 0);

    const { data, error } = await supabase
      .from('cat_transfers')
      .select('price_xch, amount_tokens, volume_xch, block_height, transferred_at, source')
      .eq('asset_id', assetId)
      .not('price_xch', 'is', null)
      .order('transferred_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── Floor price history (for collection chart) ────────────────────────────────

  app.get('/api/marketplace/:id/floor-history', async (req, res) => {
    const id   = req.params.id;
    const days = Math.min(90, parseInt(req.query.days) || 30);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data } = await supabase
      .from('floor_snapshots')
      .select('floor_price_mojo,snapshot_at')
      .eq('collection_id', id)
      .gte('snapshot_at', since)
      .order('snapshot_at', { ascending: true });

    res.json(data || []);
  });

  // Pre-warm the external collections cache on startup so first browser request
  // doesn't hit a cold DB query that may time out under load.
  setTimeout(async () => {
    try {
      const { data, error } = await supabase
        .from('indexed_collections')
        .select('collection_id,name,description,thumbnail_url,total_supply,minted_count,floor_price_mojo,source,external_url,verified,trending_score,volume_24h_mojo,volume_7d_mojo,sales_24h,sales_7d,mint_24h,listed_count')
        .order('minted_count', { ascending: false })
        .limit(200);
      if (!error && data?.length) {
        externalCache = data.map(col => ({
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
        externalCacheTime = Date.now();
        console.log(`[marketplace] cache warmed: ${externalCache.length} external collections`);
      }
    } catch (e) {
      console.warn('[marketplace] cache warm-up failed:', e.message);
    }
  }, 5000); // 5 s after startup, before the trending job fires
};
