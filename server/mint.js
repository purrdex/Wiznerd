'use strict';

const PROXY = process.env.PROXY_URL || 'http://localhost:3001';

async function mintNFT(token, project, recipientAddress) {
  const body = {
    wallet_id: 1,
    uris: [token.metadata_uri || ''],
    hash: token.image_cid || '',
    meta_uris: [token.metadata_uri || ''],
    meta_hash: '',
    target_address: recipientAddress || project.creator_address || '',
    royalty_address: project.creator_address || '',
    royalty_percentage: Math.round((project.royalty_percent || 0) * 100),
    fee: 0,
  };

  const res = await fetch(`${PROXY}/wallet/nft_mint_nft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`nft_mint_nft HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`nft_mint_nft bad JSON: ${text.slice(0, 200)}`); }
  if (!json.success) throw new Error(`nft_mint_nft: ${json.error || JSON.stringify(json).slice(0, 200)}`);

  return (
    json.nft_id ||
    json.spend_bundle?.coin_spends?.[0]?.coin?.parent_coin_info ||
    json.tx_id ||
    ''
  );
}

async function mint(orderId, supabase) {
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('*, projects(*)')
    .eq('id', orderId)
    .single();

  if (orderErr || !order) throw new Error(`Order ${orderId} not found`);
  if (!['payment_detected', 'failed'].includes(order.status)) return;

  const project = order.projects;
  if (project.mints_paused) throw new Error('Minting is paused for this collection');

  await supabase.from('orders').update({ status: 'minting' }).eq('id', orderId);

  const { data: token } = await supabase
    .from('generated_tokens')
    .select('*')
    .eq('project_id', order.project_id)
    .eq('status', 'pinned')
    .is('buyer_address', null)
    .order('token_index')
    .limit(1)
    .single();

  if (!token) {
    await supabase.from('orders').update({ status: 'failed', tx_id: 'No available tokens' }).eq('id', orderId);
    throw new Error('No available tokens to mint');
  }

  // Optimistic lock: reserve the token by setting buyer_address
  const { error: reserveErr } = await supabase
    .from('generated_tokens')
    .update({ buyer_address: '__reserved__' })
    .eq('id', token.id)
    .is('buyer_address', null);

  if (reserveErr) {
    await supabase.from('orders').update({ status: 'payment_detected' }).eq('id', orderId);
    throw new Error('Token reservation conflict — will retry');
  }

  try {
    const txId = await mintNFT(token, project, order.buyer_address || project.creator_address);

    await supabase.from('generated_tokens')
      .update({ buyer_address: order.buyer_address || project.creator_address })
      .eq('id', token.id);

    await supabase.from('orders').update({
      status: 'confirmed',
      token_id: token.id,
      tx_id: txId,
      confirmed_at: new Date().toISOString(),
    }).eq('id', orderId);

    // Check if sold out
    const { count: minted } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', order.project_id)
      .eq('status', 'confirmed');

    if ((minted || 0) >= project.total_supply) {
      await supabase.from('projects')
        .update({ marketplace_status: 'sold_out' })
        .eq('id', order.project_id);
    }
  } catch (e) {
    await supabase.from('generated_tokens').update({ buyer_address: null }).eq('id', token.id);
    await supabase.from('orders').update({
      status: 'failed',
      tx_id: e.message.slice(0, 200),
    }).eq('id', orderId);
    throw e;
  }
}

module.exports = { mint };
