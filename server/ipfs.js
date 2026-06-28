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

  // NFT.storage: test with a tiny JSON upload
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
  const { data: tokens } = await supabase.from('generated_tokens').select('*').eq('project_id', projectId).order('token_index');
  if (!tokens || tokens.length === 0) throw new Error('No generated tokens found for this project');

  const projectOutputDir = path.join(OUTPUT_DIR, projectId);
  let lastCid = '';

  for (const token of tokens) {
    const imgPath = path.join(projectOutputDir, `${token.token_index}.png`);
    let imageCid = '';
    if (fs.existsSync(imgPath)) {
      imageCid = await uploadFile(fs.readFileSync(imgPath), 'image/png', `${token.token_index}.png`);
    }
    const metadata = buildMetadata(project, token.token_index, token.traits, imageCid);
    const metaBuffer = Buffer.from(JSON.stringify(metadata, null, 2));
    lastCid = await uploadFile(metaBuffer, 'application/json', `${token.token_index}.json`);
    await supabase.from('generated_tokens')
      .update({ metadata_uri: `ipfs://${lastCid}`, status: 'pinned' })
      .eq('id', token.id);
  }

  return { cid: lastCid, service: serviceName };
}

module.exports = { pinToIPFS, testIPFS };
