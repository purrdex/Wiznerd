'use strict';

const PROXY = process.env.PROXY_URL || 'http://localhost:3001';

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

module.exports = function registerMarketplaceRoutes(app, supabase) {

  // ── Browse ────────────────────────────────────────────────────────────────────

  app.get('/api/marketplace/listings', async (req, res) => {
    const { filter, search } = req.query;
    let query = supabase
      .from('projects')
      .select('id,name,symbol,total_supply,marketplace_status,mint_price_mojo,launch_at,creator_address')
      .neq('marketplace_status', 'draft')
      .order('created_at', { ascending: false });

    if (filter === 'live')     query = query.eq('marketplace_status', 'live');
    else if (filter === 'upcoming')  query = query.eq('marketplace_status', 'scheduled');
    else if (filter === 'soldout')   query = query.eq('marketplace_status', 'sold_out');
    if (search) query = query.ilike('name', `%${search}%`);

    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const enriched = await Promise.all((data || []).map(async p => {
      const [{ count }, { data: first }] = await Promise.all([
        supabase.from('orders').select('*', { count: 'exact', head: true })
          .eq('project_id', p.id).eq('status', 'confirmed'),
        supabase.from('generated_tokens').select('token_index')
          .eq('project_id', p.id).order('token_index').limit(1).single(),
      ]);
      return { ...p, minted_count: count || 0, first_token_index: first?.token_index ?? 0 };
    }));

    res.json(enriched);
  });

  // ── Single collection ─────────────────────────────────────────────────────────

  app.get('/api/marketplace/:id', async (req, res) => {
    const { data: project, error } = await supabase
      .from('projects').select('*').eq('id', req.params.id).single();
    if (error || !project) return res.status(404).json({ error: 'Collection not found' });

    const { count } = await supabase
      .from('orders').select('*', { count: 'exact', head: true })
      .eq('project_id', req.params.id).eq('status', 'confirmed');

    res.json({ ...project, minted_count: count || 0 });
  });

  app.get('/api/marketplace/:id/gallery', async (req, res) => {
    const { data } = await supabase
      .from('orders')
      .select('id,buyer_address,confirmed_at,token_id,generated_tokens(token_index,metadata_uri,traits,image_cid)')
      .eq('project_id', req.params.id)
      .eq('status', 'confirmed')
      .order('confirmed_at', { ascending: false })
      .limit(60);
    res.json(data || []);
  });

  // ── Publish (step 8 of wizard) ────────────────────────────────────────────────

  app.post('/api/marketplace/publish', async (req, res) => {
    const { project_id, mint_price_xch, launch_immediately, launch_at, allowlist, reveal_type } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    const mint_price_mojo = Math.round((Number(mint_price_xch) || 0) * 1e12);
    const marketplace_status = launch_immediately !== false ? 'live' : 'scheduled';

    const { data, error } = await supabase
      .from('projects')
      .update({
        mint_price_mojo,
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
    res.json(data);
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
      .select('id,status,confirmed_at,token_id,tx_id,generated_tokens(token_index,metadata_uri,traits)')
      .eq('id', req.params.orderId)
      .single();
    if (error) return res.status(404).json({ error: error.message });
    res.json(data);
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
};
