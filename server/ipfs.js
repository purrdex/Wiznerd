'use strict';
const fs = require('fs');
const path = require('path');

function getSupabase() { return require('./index').supabase; }

const OUTPUT_DIR = path.join(__dirname, 'output');

function buildMetadata(project, tokenIndex, traits, imageCid) {
  return {
    format: 'CHIP-0007',
    name: `${project.name} #${tokenIndex + 1}`,
    description: `${project.name} — token ${tokenIndex + 1} of ${project.total_supply}`,
    image: `ipfs://${imageCid}`,
    attributes: Object.entries(traits).map(([trait_type, value]) => ({ trait_type, value })),
    collection: {
      name: project.name,
      id: project.id,
      attributes: [
        { type: 'royalty', value: String(Math.round(project.royalty_percent * 100)) },
        { type: 'trading_price_percentage', value: String(project.royalty_percent) },
      ],
    },
  };
}

async function uploadToNFTStorage(buffer, mimeType, apiKey) {
  const res = await fetch('https://api.nft.storage/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': mimeType },
    body: buffer,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`NFT.storage ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.value?.cid ?? json.cid;
}

async function uploadToPinata(buffer, mimeType, filename, pinataJwt) {
  const blob = new Blob([buffer], { type: mimeType });
  const fd = new FormData();
  fd.append('file', blob, filename || 'file');
  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pinataJwt}` },
    body: fd,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.IpfsHash;
}

function detectService() {
  if (process.env.NFT_STORAGE_KEY) return { service: 'nftstorage', key: process.env.NFT_STORAGE_KEY };
  if (process.env.PINATA_JWT) return { service: 'pinata', key: process.env.PINATA_JWT };
  return null;
}

async function uploadFile(buffer, mimeType, filename) {
  const svc = detectService();
  if (!svc) throw new Error('No IPFS service configured — set NFT_STORAGE_KEY or PINATA_JWT in .env');
  if (svc.service === 'nftstorage') return uploadToNFTStorage(buffer, mimeType, svc.key);
  return uploadToPinata(buffer, mimeType, filename, svc.key);
}

async function testIPFS() {
  const svc = detectService();
  if (!svc) return { ok: false, service: null, error: 'No IPFS service configured — set NFT_STORAGE_KEY or PINATA_JWT in .env' };

  if (svc.service === 'pinata') {
    try {
      const res = await fetch('https://api.pinata.cloud/data/testAuthentication', {
        headers: { Authorization: `Bearer ${svc.key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return { ok: true, service: 'Pinata' };
    } catch (e) {
      return { ok: false, service: 'Pinata', error: e.message };
    }
  }

  try {
    const cid = await uploadToNFTStorage(Buffer.from('{"test":true}'), 'application/json', svc.key);
    return { ok: true, service: 'NFT.storage', cid };
  } catch (e) {
    return { ok: false, service: 'NFT.storage', error: e.message };
  }
}

async function pinToIPFS(projectId) {
  const svc = detectService();
  if (!svc) throw new Error('No IPFS service configured — set NFT_STORAGE_KEY or PINATA_JWT in .env');
  const serviceName = svc.service === 'pinata' ? 'Pinata' : 'NFT.storage';

  const supabase = getSupabase();
  const { data: project } = await supabase.from('projects').select('*').eq('id', projectId).single();
  const { data: tokens } = await supabase.from('generated_tokens')
    .select('*').eq('project_id', projectId).order('token_index');
  if (!tokens || tokens.length === 0) throw new Error('No generated tokens found for this project');

  const total = tokens.length;
  const alreadyHaveImage = tokens.filter(t => t.image_cid).length;
  const alreadyPinned = tokens.filter(t => t.status === 'pinned' && t.metadata_uri).length;

  await supabase.from('projects').update({
    ipfs_phase: 'images',
    ipfs_images_done: alreadyHaveImage,
    ipfs_meta_done: alreadyPinned,
    ipfs_total: total,
    ipfs_current_file: null,
    ipfs_error: null,
    ipfs_service: serviceName,
  }).eq('id', projectId);

  const projectOutputDir = path.join(OUTPUT_DIR, projectId);

  // Phase 1: upload images (skip tokens that already have an image_cid)
  const imageCids = new Map(tokens.filter(t => t.image_cid).map(t => [t.id, t.image_cid]));
  let imagesDone = alreadyHaveImage;

  for (const token of tokens) {
    if (imageCids.has(token.id)) continue;

    const filename = `token_${String(token.token_index).padStart(4, '0')}.png`;
    await supabase.from('projects').update({ ipfs_current_file: filename }).eq('id', projectId);

    try {
      const imgPath = path.join(projectOutputDir, `${token.token_index}.png`);
      let imageCid = '';
      if (fs.existsSync(imgPath)) {
        imageCid = await uploadFile(fs.readFileSync(imgPath), 'image/png', filename);
      }
      await supabase.from('generated_tokens').update({ image_cid: imageCid }).eq('id', token.id);
      imageCids.set(token.id, imageCid);
      imagesDone++;
      await supabase.from('projects').update({ ipfs_images_done: imagesDone }).eq('id', projectId);
    } catch (e) {
      await supabase.from('projects').update({
        ipfs_phase: 'error',
        ipfs_error: `Failed to upload ${filename}: ${e.message}`,
        ipfs_current_file: filename,
      }).eq('id', projectId);
      throw new Error(`Failed to upload ${filename}: ${e.message}`);
    }
  }

  // Phase 2: upload metadata JSON (skip already-pinned tokens)
  await supabase.from('projects').update({ ipfs_phase: 'metadata', ipfs_current_file: null }).eq('id', projectId);

  let lastCid = '';
  let metaDone = alreadyPinned;

  for (const token of tokens) {
    if (token.status === 'pinned' && token.metadata_uri) {
      lastCid = token.metadata_uri.replace('ipfs://', '');
      continue;
    }

    const filename = `token_${String(token.token_index).padStart(4, '0')}.json`;
    await supabase.from('projects').update({ ipfs_current_file: filename }).eq('id', projectId);

    try {
      const imageCid = imageCids.get(token.id) || '';
      const metadata = buildMetadata(project, token.token_index, token.traits, imageCid);
      const metaBuffer = Buffer.from(JSON.stringify(metadata, null, 2));
      lastCid = await uploadFile(metaBuffer, 'application/json', filename);
      await supabase.from('generated_tokens')
        .update({ metadata_uri: `ipfs://${lastCid}`, status: 'pinned' })
        .eq('id', token.id);
      metaDone++;
      await supabase.from('projects').update({ ipfs_meta_done: metaDone }).eq('id', projectId);
    } catch (e) {
      await supabase.from('projects').update({
        ipfs_phase: 'error',
        ipfs_error: `Failed to upload ${filename}: ${e.message}`,
        ipfs_current_file: filename,
      }).eq('id', projectId);
      throw new Error(`Failed to upload ${filename}: ${e.message}`);
    }
  }

  await supabase.from('projects').update({
    ipfs_phase: 'complete',
    ipfs_current_file: null,
    ipfs_error: null,
    status: 'pinned',
    ipfs_cid: lastCid,
  }).eq('id', projectId);

  return { cid: lastCid, service: serviceName };
}

module.exports = { pinToIPFS, testIPFS };
