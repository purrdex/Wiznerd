'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getSupabase() { return require('./index').supabase; }

const OUTPUT_DIR = path.join(__dirname, 'output');

function buildMetadata(project, tokenIndex, traits, imageRef) {
  const collectionAttrs = [
    { type: 'description', value: project.description || project.name },
  ];
  if (project.collection_image_url) {
    collectionAttrs.push({ type: 'icon', value: project.collection_image_url });
  }
  return {
    format: 'CHIP-0007',
    name: `${project.name} #${tokenIndex + 1}`,
    description: project.description || `${project.name} — a collection of ${project.total_supply} unique NFTs on Chia`,
    sensitive_content: false,
    series_number: tokenIndex + 1,
    series_total: project.total_supply,
    image: `ipfs://${imageRef}`,
    attributes: Object.entries(traits).map(([trait_type, value]) => ({ trait_type, value })),
    collection: {
      name: project.name,
      id: project.id,
      attributes: collectionAttrs,
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

// Upload all files as a single IPFS directory — returns the directory CID.
// Each file is accessible at ipfs://{dirCid}/{file.name}
async function uploadDirectoryToPinata(files, dirName, pinataJwt) {
  const fd = new FormData();
  for (const { name, buffer, mimeType } of files) {
    fd.append('file', new Blob([buffer], { type: mimeType }), `${dirName}/${name}`);
  }
  fd.append('pinataMetadata', JSON.stringify({ name: dirName }));
  fd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pinataJwt}` },
    body: fd,
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`Pinata directory upload ${res.status}: ${await res.text()}`);
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

  await supabase.from('projects').update({
    ipfs_phase: 'images',
    ipfs_images_done: 0,
    ipfs_meta_done: 0,
    ipfs_total: total,
    ipfs_current_file: null,
    ipfs_error: null,
    ipfs_service: serviceName,
  }).eq('id', projectId);

  const projectOutputDir = path.join(OUTPUT_DIR, projectId);

  // Pin collection image first (before any phase) so buildMetadata can include it
  if (project.collection_image_path && !project.collection_image_url) {
    try {
      await supabase.from('projects').update({ ipfs_current_file: 'Pinning collection image...' }).eq('id', projectId);
      const { data: imgData } = await supabase.storage.from('output').download(project.collection_image_path);
      if (imgData) {
        const imgBuf = Buffer.from(await imgData.arrayBuffer());
        let collectionCid;
        if (svc.service === 'pinata') {
          collectionCid = await uploadToPinata(imgBuf, 'image/png', 'collection.png', svc.key);
        } else {
          collectionCid = await uploadToNFTStorage(imgBuf, 'image/png', svc.key);
        }
        project.collection_image_url = `ipfs://${collectionCid}`;
        await supabase.from('projects').update({ collection_image_url: project.collection_image_url }).eq('id', projectId);
      }
    } catch (e) {
      console.warn('[ipfs] collection image pin failed (non-fatal):', e.message);
    }
  }

  if (svc.service === 'pinata') {
    // === Pinata: directory-based upload (one CID for whole collection) ===

    // Phase 1: collect all images and upload as a directory
    await supabase.from('projects').update({ ipfs_current_file: 'Reading images...' }).eq('id', projectId);

    const imageFiles = [];
    const dataHashes = {};
    for (const token of tokens) {
      const imgPath = path.join(projectOutputDir, `${token.token_index}.png`);
      if (fs.existsSync(imgPath)) {
        const buf = fs.readFileSync(imgPath);
        imageFiles.push({ name: `${token.token_index}.png`, buffer: buf, mimeType: 'image/png' });
        dataHashes[token.token_index] = crypto.createHash('sha256').update(buf).digest('hex');
      }
    }

    await supabase.from('projects').update({
      ipfs_current_file: `Uploading ${imageFiles.length} images as IPFS directory...`,
    }).eq('id', projectId);

    const imageDirCid = await uploadDirectoryToPinata(imageFiles, project.name, svc.key);

    // image_cid stored as "{dirCid}/{index}.png" so mint.js can build gateway URLs directly
    for (const token of tokens) {
      if (dataHashes[token.token_index] !== undefined) {
        await supabase.from('generated_tokens')
          .update({
            image_cid: `${imageDirCid}/${token.token_index}.png`,
            data_hash: dataHashes[token.token_index],
          })
          .eq('id', token.id);
      }
    }
    await supabase.from('projects').update({ ipfs_images_done: imageFiles.length }).eq('id', projectId);

    // Phase 2: build metadata JSONs and upload as a directory
    await supabase.from('projects').update({
      ipfs_phase: 'metadata',
      ipfs_current_file: 'Building metadata...',
    }).eq('id', projectId);

    const metaFiles = [];
    const metaHashes = {};
    for (const token of tokens) {
      const imageRef = `${imageDirCid}/${token.token_index}.png`;
      const metadata = buildMetadata(project, token.token_index, token.traits, imageRef);
      const buf = Buffer.from(JSON.stringify(metadata, null, 2));
      metaHashes[token.token_index] = crypto.createHash('sha256').update(buf).digest('hex');
      metaFiles.push({ name: `${token.token_index}.json`, buffer: buf, mimeType: 'application/json' });
    }

    await supabase.from('projects').update({
      ipfs_current_file: `Uploading ${metaFiles.length} metadata files as IPFS directory...`,
    }).eq('id', projectId);

    const metaDirCid = await uploadDirectoryToPinata(metaFiles, `${project.name}-meta`, svc.key);

    for (const token of tokens) {
      await supabase.from('generated_tokens')
        .update({
          metadata_uri: `ipfs://${metaDirCid}/${token.token_index}.json`,
          meta_hash: metaHashes[token.token_index] || null,
          status: 'pinned',
        })
        .eq('id', token.id);
    }
    await supabase.from('projects').update({ ipfs_meta_done: total }).eq('id', projectId);

    await supabase.from('projects').update({
      ipfs_phase: 'complete',
      ipfs_current_file: null,
      ipfs_error: null,
      status: 'pinned',
      ipfs_cid: metaDirCid,
    }).eq('id', projectId);

    return { cid: metaDirCid, service: serviceName };
  }

  // === NFT.storage fallback: individual file upload ===
  const imageCids = new Map(tokens.filter(t => t.image_cid).map(t => [t.id, t.image_cid]));
  let imagesDone = tokens.filter(t => t.image_cid).length;

  for (const token of tokens) {
    if (imageCids.has(token.id)) continue;
    const filename = `token_${String(token.token_index).padStart(4, '0')}.png`;
    await supabase.from('projects').update({ ipfs_current_file: filename }).eq('id', projectId);
    try {
      const imgPath = path.join(projectOutputDir, `${token.token_index}.png`);
      let imageCid = '';
      let dataHash = '';
      if (fs.existsSync(imgPath)) {
        const imgBuf = fs.readFileSync(imgPath);
        imageCid = await uploadFile(imgBuf, 'image/png', filename);
        dataHash = crypto.createHash('sha256').update(imgBuf).digest('hex');
      }
      await supabase.from('generated_tokens').update({ image_cid: imageCid, data_hash: dataHash }).eq('id', token.id);
      imageCids.set(token.id, imageCid);
      imagesDone++;
      await supabase.from('projects').update({ ipfs_images_done: imagesDone }).eq('id', projectId);
    } catch (e) {
      await supabase.from('projects').update({ ipfs_phase: 'error', ipfs_error: e.message }).eq('id', projectId);
      throw e;
    }
  }

  await supabase.from('projects').update({ ipfs_phase: 'metadata', ipfs_current_file: null }).eq('id', projectId);
  let lastCid = '';
  let metaDone = tokens.filter(t => t.status === 'pinned' && t.metadata_uri).length;

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
      await supabase.from('projects').update({ ipfs_phase: 'error', ipfs_error: e.message }).eq('id', projectId);
      throw e;
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
