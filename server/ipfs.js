'use strict';
/**
 * IPFS pinning via NFT.storage HTTP API (v1).
 * Uploads all generated images + Chia NFT1-standard metadata JSON for a project.
 */
const fs = require('fs');
const path = require('path');

function getSupabase() {
  return require('./index').supabase;
}

const OUTPUT_DIR = path.join(__dirname, 'output');

// Build Chia CHIP-0007 metadata for a single token
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

// Upload a single file to NFT.storage and return the CID
async function uploadFileToNFTStorage(buffer, mimeType, apiKey) {
  const res = await fetch('https://api.nft.storage/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': mimeType,
    },
    body: buffer,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`NFT.storage upload failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.value?.cid ?? json.cid;
}

async function pinToIPFS(projectId) {
  const apiKey = process.env.NFT_STORAGE_KEY;
  if (!apiKey) throw new Error('NFT_STORAGE_KEY env var not set');

  const supabase = getSupabase();

  const { data: project } = await supabase.from('projects').select('*').eq('id', projectId).single();
  const { data: tokens } = await supabase.from('generated_tokens').select('*').eq('project_id', projectId).order('token_index');

  if (!tokens || tokens.length === 0) throw new Error('No generated tokens found for this project');

  const projectOutputDir = path.join(OUTPUT_DIR, projectId);
  const metadataCids = [];

  for (const token of tokens) {
    // Upload image
    const imgPath = path.join(projectOutputDir, `${token.token_index}.png`);
    let imageCid = '';
    if (fs.existsSync(imgPath)) {
      const imgBuffer = fs.readFileSync(imgPath);
      imageCid = await uploadFileToNFTStorage(imgBuffer, 'image/png', apiKey);
    }

    // Build and upload metadata
    const metadata = buildMetadata(project, token.token_index, token.traits, imageCid);
    const metaBuffer = Buffer.from(JSON.stringify(metadata, null, 2));
    const metaCid = await uploadFileToNFTStorage(metaBuffer, 'application/json', apiKey);
    metadataCids.push(metaCid);

    // Update token record with metadata URI
    await supabase
      .from('generated_tokens')
      .update({ metadata_uri: `ipfs://${metaCid}`, status: 'pinned' })
      .eq('id', token.id);
  }

  // Return the last CID as a collection-level reference (could be a CAR file CID in production)
  return metadataCids[metadataCids.length - 1] ?? '';
}

module.exports = { pinToIPFS };
