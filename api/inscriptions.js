const fs = require('fs');
const path = require('path');

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
    let index = { program: 'X1 Punks', inscriptions: [], totalInscribed: 0 };
    if (fs.existsSync(INSCRIPTIONS_FILE)) {
      index = JSON.parse(fs.readFileSync(INSCRIPTIONS_FILE, 'utf-8'));
    }

    res.status(200).json({
      program: 'X1 Punks',
      protocol: 'metaplex-inscription',
      chain: 'x1',
      totalInscribed: index.inscriptions?.length || 0,
      lastUpdated: index.lastUpdated || null,
      inscriptions: index.inscriptions || []
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load inscriptions: ' + e.message });
  }
};
