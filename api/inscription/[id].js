const fs = require('fs');
const path = require('path');

const INSCRIPTIONS_FILE = path.join(__dirname, '..', '..', 'inscriptions-index.json');
const CSV_PATH = path.join(__dirname, '..', '..', 'punks.whitelabel', 'punks.csv');

const TOTAL_SUPPLY = 10000;
const COLLECTION_NAME = 'X1 Punk';
const COLLECTION_SYMBOL = 'X1PUNK';
const PROGRAM_NAME = 'X1 Punks';

let punkMetaCache = null;

function loadPunkMetadata() {
  if (punkMetaCache) return punkMetaCache;
  if (!fs.existsSync(CSV_PATH)) return {};
  const lines = fs.readFileSync(CSV_PATH, 'utf-8').split('\n');
  const metadata = {};
  lines.slice(1).forEach((line, index) => {
    if (line.trim()) {
      const parts = line.split(',');
      const traits = parts.slice(1).filter(t => t && t.trim());
      metadata[index] = { type: parts[0] || 'Unknown', traits };
    }
  });
  punkMetaCache = metadata;
  return metadata;
}

function getRarity(type) {
  if (type === 'Alien') return 'Legendary';
  if (type === 'Ape') return 'Epic';
  if (type === 'Zombie') return 'Rare';
  return 'Common';
}

function buildInscriptionJson(punkId) {
  const allMeta = loadPunkMetadata();
  const meta = allMeta[punkId] || { type: 'Unknown', traits: [] };
  const rarity = getRarity(meta.type);

  return {
    name: `${COLLECTION_NAME} #${punkId}`,
    symbol: COLLECTION_SYMBOL,
    description: `X1 Punk #${punkId} - Unique pixel punk fully inscribed on the X1 blockchain. Image and metadata stored 100% on-chain.`,
    collection: { name: COLLECTION_NAME, family: PROGRAM_NAME },
    attributes: [
      { trait_type: 'Type', value: meta.type },
      { trait_type: 'Rarity', value: rarity },
      ...meta.traits.map((trait, i) => ({
        trait_type: `Accessory ${i + 1}`,
        value: trait.trim()
      }))
    ],
    properties: {
      category: 'image',
      files: [{ type: 'image/png', uri: 'inscription' }]
    },
    inscription: {
      protocol: 'metaplex-inscription',
      version: '1.0',
      chain: 'x1',
      programId: '1NSCRfGeyo7wPUazGbaPBUsTM49e1k2aXewHGARfzSo'
    }
  };
}

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id } = req.query;
    const punkId = parseInt(id);

    if (isNaN(punkId) || punkId < 0 || punkId >= TOTAL_SUPPLY) {
      return res.status(400).json({ error: 'Invalid punk ID' });
    }

    const metadata = buildInscriptionJson(punkId);

    let onChainData = null;
    let imageSize = 0;
    if (fs.existsSync(INSCRIPTIONS_FILE)) {
      const index = JSON.parse(fs.readFileSync(INSCRIPTIONS_FILE, 'utf-8'));
      onChainData = index.inscriptions?.find(i => i.punkId === punkId);
      if (onChainData?.onChain?.imageSize) {
        imageSize = onChainData.onChain.imageSize;
      }
    }

    // Return image URL instead of base64 to avoid bundling 70MB of images in the function
    res.status(200).json({
      punkId,
      metadata,
      image: `https://raw.githubusercontent.com/Execute007/x1punks-images/master/generated/punk_${punkId}.png`,
      imageSize,
      onChain: onChainData?.onChain || null,
      inscribed: !!onChainData
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load inscription: ' + e.message });
  }
};
