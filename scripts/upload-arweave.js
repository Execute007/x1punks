/**
 * Batch upload all X1 Punk images + metadata to Arweave
 *
 * Usage:
 *   node scripts/upload-arweave.js              # Upload all 10,000
 *   node scripts/upload-arweave.js --test       # Test with first 5 punks
 *   node scripts/upload-arweave.js --start=500  # Resume from punk #500
 */

const Arweave = require('arweave');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.join(__dirname, '..');
const GENERATED_DIR = path.join(PROJECT_DIR, 'generated');
const WALLET_PATH = path.join(PROJECT_DIR, 'arweave-wallet.json');
const MANIFEST_PATH = path.join(PROJECT_DIR, 'arweave-manifest.json');
const CSV_PATH = path.join(PROJECT_DIR, 'punks.whitelabel', 'punks.csv');

const TOTAL_SUPPLY = 10000;
const COLLECTION_NAME = 'X1 Punk';
const PROGRAM_NAME = 'X1 Punks';
const COLLECTION_SYMBOL = 'X1PUNK';

// Concurrency: how many uploads at once (be gentle on Arweave gateway)
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES_MS = 2000;

// ============================================
// SETUP
// ============================================

const arweave = Arweave.init({
    host: 'arweave.net',
    port: 443,
    protocol: 'https',
    timeout: 60000
});

// ============================================
// PUNK METADATA (same logic as server.js)
// ============================================

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

function buildMetadataJson(punkId, imageArweaveUrl) {
    const allMeta = loadPunkMetadata();
    const meta = allMeta[punkId] || { type: 'Unknown', traits: [] };
    const rarity = getRarity(meta.type);

    return {
        name: `${COLLECTION_NAME} #${punkId}`,
        symbol: COLLECTION_SYMBOL,
        description: `X1 Punk #${punkId} - Unique pixel punk fully inscribed on the X1 blockchain. Image and metadata stored permanently on Arweave.`,
        image: imageArweaveUrl,
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
            files: [{ type: 'image/png', uri: imageArweaveUrl }]
        }
    };
}

// ============================================
// ARWEAVE UPLOAD FUNCTIONS
// ============================================

async function uploadData(key, data, contentType, tags = []) {
    const tx = await arweave.createTransaction({ data }, key);
    tx.addTag('Content-Type', contentType);
    for (const tag of tags) {
        tx.addTag(tag.name, tag.value);
    }
    await arweave.transactions.sign(tx, key);

    const uploader = await arweave.transactions.getUploader(tx);
    while (!uploader.isComplete) {
        await uploader.uploadChunk();
    }

    return tx.id;
}

async function uploadPunk(key, punkId) {
    const imagePath = path.join(GENERATED_DIR, `punk_${punkId}.png`);
    if (!fs.existsSync(imagePath)) {
        throw new Error(`Image not found: punk_${punkId}.png`);
    }

    // Upload image only (metadata is already stored on-chain)
    const imageData = fs.readFileSync(imagePath);
    const imageTxId = await uploadData(key, imageData, 'image/png', [
        { name: 'App-Name', value: 'X1Punks' },
        { name: 'Punk-Id', value: String(punkId) },
        { name: 'Type', value: 'image' }
    ]);
    const imageUrl = `https://arweave.net/${imageTxId}`;

    return {
        punkId,
        imageTxId,
        imageUrl,
        imageSize: imageData.length
    };
}

// ============================================
// MANIFEST (tracks progress, allows resume)
// ============================================

function loadManifest() {
    if (fs.existsSync(MANIFEST_PATH)) {
        return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    }
    return { uploads: {}, totalUploaded: 0, startedAt: new Date().toISOString() };
}

function saveManifest(manifest) {
    manifest.lastUpdated = new Date().toISOString();
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ============================================
// BATCH UPLOAD
// ============================================

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const args = process.argv.slice(2);
    const testMode = args.includes('--test');
    const startArg = args.find(a => a.startsWith('--start='));
    const startFrom = startArg ? parseInt(startArg.split('=')[1]) : 0;

    const endId = testMode ? Math.min(startFrom + 5, TOTAL_SUPPLY) : TOTAL_SUPPLY;

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   X1 PUNKS - ARWEAVE BATCH UPLOAD               ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log();

    // Load wallet
    if (!fs.existsSync(WALLET_PATH)) {
        console.error('ERROR: arweave-wallet.json not found!');
        process.exit(1);
    }
    const key = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
    const addr = await arweave.wallets.jwkToAddress(key);
    const balance = await arweave.wallets.getBalance(addr);
    const balanceAR = arweave.ar.winstonToAr(balance);

    console.log(`Wallet:  ${addr}`);
    console.log(`Balance: ${balanceAR} AR`);
    console.log(`Range:   Punk #${startFrom} → #${endId - 1} (${endId - startFrom} punks)`);
    console.log(`Mode:    ${testMode ? 'TEST (5 punks)' : 'FULL UPLOAD'}`);
    console.log();

    // Load manifest for resume support
    const manifest = loadManifest();
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    // Build list of punk IDs to upload
    const punkIds = [];
    for (let i = startFrom; i < endId; i++) {
        if (manifest.uploads[i]) {
            skipped++;
        } else {
            punkIds.push(i);
        }
    }

    if (skipped > 0) {
        console.log(`Skipping ${skipped} already-uploaded punks (resuming)`);
    }
    console.log(`Uploading ${punkIds.length} punks...\n`);

    // Process in batches
    for (let batchStart = 0; batchStart < punkIds.length; batchStart += BATCH_SIZE) {
        const batch = punkIds.slice(batchStart, batchStart + BATCH_SIZE);
        const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(punkIds.length / BATCH_SIZE);

        console.log(`--- Batch ${batchNum}/${totalBatches} (Punks: ${batch.join(', ')}) ---`);

        const results = await Promise.allSettled(
            batch.map(id => uploadPunk(key, id))
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                const r = result.value;
                manifest.uploads[r.punkId] = {
                    imageTxId: r.imageTxId,
                    imageUrl: r.imageUrl,
                    imageSize: r.imageSize,
                    uploadedAt: new Date().toISOString()
                };
                manifest.totalUploaded = Object.keys(manifest.uploads).length;
                uploaded++;
                console.log(`  ✓ Punk #${r.punkId} → ${r.imageUrl}`);
            } else {
                failed++;
                console.error(`  ✗ Failed: ${result.reason?.message || result.reason}`);
            }
        }

        // Save manifest after each batch (resume support)
        saveManifest(manifest);

        // Don't delay after the last batch
        if (batchStart + BATCH_SIZE < punkIds.length) {
            await sleep(DELAY_BETWEEN_BATCHES_MS);
        }
    }

    // Final summary
    const finalBalance = await arweave.wallets.getBalance(addr);
    const spent = (parseFloat(balanceAR) - parseFloat(arweave.ar.winstonToAr(finalBalance))).toFixed(6);

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   UPLOAD COMPLETE                                ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  Uploaded:  ${uploaded}`);
    console.log(`  Skipped:   ${skipped}`);
    console.log(`  Failed:    ${failed}`);
    console.log(`  Total:     ${manifest.totalUploaded} in manifest`);
    console.log(`  AR Spent:  ~${spent} AR`);
    console.log(`  Remaining: ${arweave.ar.winstonToAr(finalBalance)} AR`);
    console.log(`  Manifest:  ${MANIFEST_PATH}`);
    console.log();

    if (failed > 0) {
        console.log(`⚠ ${failed} failed. Re-run the script to retry — it will skip already-uploaded punks.`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
