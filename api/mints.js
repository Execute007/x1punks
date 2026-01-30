const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'mint-state.json');

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
      if (!state.mintedIds) state.mintedIds = state.mints.map(m => m.id);
    }

    res.status(200).json({
      program: 'X1 Punks',
      collectionName: 'X1 Punk',
      mintedCount: state.mintedCount,
      totalSupply: 10000,
      mints: state.mints
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load mint state: ' + e.message });
  }
};
