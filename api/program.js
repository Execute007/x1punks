const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'mint-state.json');
const INSCRIPTIONS_FILE = path.join(__dirname, '..', 'inscriptions-index.json');

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
    let state = { mintedCount: 0, mints: [], mintedIds: [] };
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }

    let index = { inscriptions: [] };
    if (fs.existsSync(INSCRIPTIONS_FILE)) {
      index = JSON.parse(fs.readFileSync(INSCRIPTIONS_FILE, 'utf-8'));
    }

    res.status(200).json({
      program: 'X1 Punks',
      collection: 'X1 Punk',
      symbol: 'X1PUNK',
      protocol: 'metaplex-inscription',
      chain: 'x1',
      rpc: 'https://rpc.testnet.x1.xyz',
      totalSupply: 10000,
      mintedCount: state.mintedCount,
      inscribedCount: index.inscriptions?.length || 0,
      lastUpdated: index.lastUpdated || null
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load program info: ' + e.message });
  }
};
