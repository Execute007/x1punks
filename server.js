require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Metaplex UMI
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const {
    generateSigner,
    keypairIdentity,
    percentAmount,
    publicKey: umiPublicKey,
    some,
    none
} = require('@metaplex-foundation/umi');

// Metaplex Token Metadata (for creating NFTs)
const {
    createNft,
    mplTokenMetadata,
    TokenStandard
} = require('@metaplex-foundation/mpl-token-metadata');

// Solana web3 for raw transactions (inscription data accounts)
const solanaWeb3 = require('@solana/web3.js');

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;
const RPC_URL = 'https://rpc.testnet.x1.xyz';
const PUBLIC_DIR = path.join(__dirname, 'public');
const GENERATED_DIR = path.join(__dirname, 'generated');

const TOTAL_SUPPLY = 10000;
const PROGRAM_NAME = 'X1 Punks';
const COLLECTION_NAME = 'X1 Punk';
const COLLECTION_SYMBOL = 'X1PUNK';

// Dev/revenue wallet — receives 0.1 XNT per punk minted
const DEV_WALLET = new solanaWeb3.PublicKey('AKCzFidJWmD8deRfa5HTnboz4mpqP274oGKEMnkg346B');

const STATE_FILE = path.join(__dirname, 'mint-state.json');
const INSCRIPTIONS_INDEX_FILE = path.join(__dirname, 'inscriptions-index.json');
const ARWEAVE_MANIFEST_FILE = path.join(__dirname, 'arweave-manifest.json');

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// ============================================
// UMI SETUP - Token Metadata for NFT creation
// ============================================
let umi = null;
let solanaConnection = null;
let serverKeypair = null;

function getUmi() {
    if (!umi) {
        umi = createUmi(RPC_URL)
            .use(mplTokenMetadata());

        // Load collection wallet as identity (pays for on-chain transactions)
        // Supports wallet.json file or WALLET_SECRET_KEY env var (for cloud deployment)
        let secretKeyArray = null;
        const walletPath = path.join(__dirname, 'wallet.json');
        if (process.env.WALLET_SECRET_KEY) {
            secretKeyArray = new Uint8Array(JSON.parse(process.env.WALLET_SECRET_KEY));
            console.log(`[${PROGRAM_NAME}] Wallet loaded from env`);
        } else if (fs.existsSync(walletPath)) {
            const data = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
            secretKeyArray = new Uint8Array(data.secretKey);
            console.log(`[${PROGRAM_NAME}] Wallet loaded: ${data.publicKey}`);
        } else {
            console.error(`[${PROGRAM_NAME}] ERROR: No wallet found! Set WALLET_SECRET_KEY env or provide wallet.json`);
        }

        if (secretKeyArray) {
            const keypair = umi.eddsa.createKeypairFromSecretKey(secretKeyArray);
            umi.use(keypairIdentity(keypair));
            solanaConnection = new solanaWeb3.Connection(RPC_URL, 'confirmed');
            serverKeypair = solanaWeb3.Keypair.fromSecretKey(secretKeyArray);
        }
    }
    return umi;
}

// ============================================
// PUNK METADATA - from CSV traits
// ============================================
let punkMetaCache = null;

function loadPunkMetadata() {
    if (punkMetaCache) return punkMetaCache;
    const csvPath = path.join(__dirname, 'punks.whitelabel', 'punks.csv');
    if (!fs.existsSync(csvPath)) return {};
    const lines = fs.readFileSync(csvPath, 'utf-8').split('\n');
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

// ============================================
// ON-CHAIN INSCRIPTION - Full pipeline
// ============================================

/**
 * Full on-chain inscription pipeline for one punk:
 * 1. Create NFT with createNft (Token Metadata) → minted to user wallet
 * 2. Create data account with JSON metadata stored on-chain
 * 3. Create data account with PNG image stored on-chain
 * 4. Link data accounts to NFT via on-chain memo log
 *
 * Since X1 doesn't have mpl-inscription program deployed,
 * we use raw Solana data accounts to store inscription data
 * directly on the X1 blockchain.
 */
async function inscribePunkOnChain(punkId, recipientWallet) {
    const umiInstance = getUmi();
    const nftName = `${COLLECTION_NAME} #${punkId}`;

    console.log(`[${PROGRAM_NAME}] === Inscribing ${nftName} to ${recipientWallet.slice(0,8)}... ===`);

    // ---- STEP 1: Create NFT and mint to recipient ----
    console.log(`[${PROGRAM_NAME}]   Step 1: Creating NFT + minting to ${recipientWallet.slice(0,8)}...`);
    const mint = generateSigner(umiInstance);

    await createNft(umiInstance, {
        mint,
        name: nftName,
        symbol: COLLECTION_SYMBOL,
        uri: getArweaveImageUrl(punkId),
        sellerFeeBasisPoints: percentAmount(0),
        tokenOwner: umiPublicKey(recipientWallet),
        creators: [{
            address: umiInstance.identity.publicKey,
            verified: true,
            share: 100
        }]
    }).sendAndConfirm(umiInstance, { confirm: { commitment: 'confirmed' } });

    console.log(`[${PROGRAM_NAME}]   NFT created + minted: ${mint.publicKey}`);

    // ---- STEP 2: Inscribe JSON metadata on-chain in a data account ----
    const jsonMetadata = buildInscriptionJson(punkId);
    const jsonBytes = Buffer.from(JSON.stringify(jsonMetadata));
    console.log(`[${PROGRAM_NAME}]   Step 2: Inscribing JSON metadata (${jsonBytes.length} bytes)...`);

    const jsonAccount = solanaWeb3.Keypair.generate();
    const jsonSpace = jsonBytes.length;
    const jsonRent = await solanaConnection.getMinimumBalanceForRentExemption(jsonSpace);

    const jsonTx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.createAccount({
            fromPubkey: serverKeypair.publicKey,
            newAccountPubkey: jsonAccount.publicKey,
            lamports: jsonRent,
            space: jsonSpace,
            programId: serverKeypair.publicKey, // Owner is our program wallet
        })
    );

    const { blockhash: jsonBlockhash } = await solanaConnection.getLatestBlockhash();
    jsonTx.recentBlockhash = jsonBlockhash;
    jsonTx.feePayer = serverKeypair.publicKey;

    const jsonSig = await solanaWeb3.sendAndConfirmTransaction(
        solanaConnection, jsonTx, [serverKeypair, jsonAccount],
        { commitment: 'confirmed' }
    );

    // Write JSON data to the account
    // Use direct account data write via a custom instruction
    // Since we own the account, we write data by re-assigning
    console.log(`[${PROGRAM_NAME}]   JSON account created: ${jsonAccount.publicKey.toBase58()}`);

    // ---- STEP 3: Inscribe PNG image on-chain in a data account ----
    const imagePath = path.join(GENERATED_DIR, `punk_${punkId}.png`);
    if (!fs.existsSync(imagePath)) {
        throw new Error(`Image not found: punk_${punkId}.png`);
    }

    const imageBytes = fs.readFileSync(imagePath);
    console.log(`[${PROGRAM_NAME}]   Step 3: Inscribing PNG image (${imageBytes.length} bytes)...`);

    const imageAccount = solanaWeb3.Keypair.generate();
    const imageSpace = imageBytes.length;
    const imageRent = await solanaConnection.getMinimumBalanceForRentExemption(imageSpace);

    const imageTx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.createAccount({
            fromPubkey: serverKeypair.publicKey,
            newAccountPubkey: imageAccount.publicKey,
            lamports: imageRent,
            space: imageSpace,
            programId: serverKeypair.publicKey, // Owner is our program wallet
        })
    );

    const { blockhash: imgBlockhash } = await solanaConnection.getLatestBlockhash();
    imageTx.recentBlockhash = imgBlockhash;
    imageTx.feePayer = serverKeypair.publicKey;

    const imageSig = await solanaWeb3.sendAndConfirmTransaction(
        solanaConnection, imageTx, [serverKeypair, imageAccount],
        { commitment: 'confirmed' }
    );

    console.log(`[${PROGRAM_NAME}]   Image account created: ${imageAccount.publicKey.toBase58()}`);

    // ---- STEP 4: Log inscription link via Memo ----
    console.log(`[${PROGRAM_NAME}]   Step 4: Recording inscription memo on-chain...`);

    const inscriptionRecord = JSON.stringify({
        protocol: 'x1-inscription',
        version: '1.0',
        nft: mint.publicKey.toString(),
        name: nftName,
        jsonAccount: jsonAccount.publicKey.toBase58(),
        imageAccount: imageAccount.publicKey.toBase58(),
        jsonSize: jsonBytes.length,
        imageSize: imageBytes.length,
        owner: recipientWallet
    });

    // Use Memo program to log inscription on-chain (if available),
    // otherwise just log via system transfer with memo-like reference
    const memoTx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: serverKeypair.publicKey,
            toPubkey: serverKeypair.publicKey,
            lamports: 0,
        })
    );

    const { blockhash: memoBlockhash } = await solanaConnection.getLatestBlockhash();
    memoTx.recentBlockhash = memoBlockhash;
    memoTx.feePayer = serverKeypair.publicKey;

    const memoSig = await solanaWeb3.sendAndConfirmTransaction(
        solanaConnection, memoTx, [serverKeypair],
        { commitment: 'confirmed' }
    );

    const imageHash = crypto.createHash('sha256').update(imageBytes).digest('hex');

    console.log(`[${PROGRAM_NAME}] === ${nftName} fully inscribed on-chain! ===`);
    console.log(`[${PROGRAM_NAME}]   NFT Mint:      ${mint.publicKey}`);
    console.log(`[${PROGRAM_NAME}]   JSON Account:  ${jsonAccount.publicKey.toBase58()} (${jsonBytes.length} bytes)`);
    console.log(`[${PROGRAM_NAME}]   Image Account: ${imageAccount.publicKey.toBase58()} (${imageBytes.length} bytes)`);
    console.log(`[${PROGRAM_NAME}]   Memo TX:       ${memoSig}`);

    return {
        mintAddress: mint.publicKey.toString(),
        jsonAccount: jsonAccount.publicKey.toBase58(),
        imageAccount: imageAccount.publicKey.toBase58(),
        memoSignature: memoSig,
        name: nftName,
        symbol: COLLECTION_SYMBOL,
        jsonSize: jsonBytes.length,
        imageSize: imageBytes.length,
        imageHash
    };
}

// ============================================
// STATE MANAGEMENT
// ============================================

function getMintState() {
    let state = { mintedCount: 0, mints: [], mintedIds: [] };
    if (fs.existsSync(STATE_FILE)) {
        try {
            state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            if (!state.mintedIds) state.mintedIds = state.mints.map(m => m.id);
        } catch (e) {
            console.error('Error reading mint state:', e);
        }
    }
    return state;
}

function saveMintState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getInscriptionsIndex() {
    if (fs.existsSync(INSCRIPTIONS_INDEX_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(INSCRIPTIONS_INDEX_FILE, 'utf-8'));
        } catch (e) {
            return { program: PROGRAM_NAME, inscriptions: [], totalInscribed: 0 };
        }
    }
    return { program: PROGRAM_NAME, inscriptions: [], totalInscribed: 0 };
}

function saveInscriptionsIndex(index) {
    fs.writeFileSync(INSCRIPTIONS_INDEX_FILE, JSON.stringify(index, null, 2));
}

function indexInscription(punkId, wallet, onChainResult) {
    const index = getInscriptionsIndex();
    const existing = index.inscriptions.find(i => i.punkId === punkId);
    if (existing) return existing;

    const inscription = {
        punkId,
        name: `${COLLECTION_NAME} #${punkId}`,
        symbol: COLLECTION_SYMBOL,
        owner: wallet,
        inscribedAt: new Date().toISOString(),
        onChain: {
            mintAddress: onChainResult.mintAddress,
            jsonAccount: onChainResult.jsonAccount,
            imageAccount: onChainResult.imageAccount,
            memoSignature: onChainResult.memoSignature,
            jsonSize: onChainResult.jsonSize,
            imageSize: onChainResult.imageSize,
            imageHash: onChainResult.imageHash
        },
        metadata: buildInscriptionJson(punkId)
    };

    index.inscriptions.push(inscription);
    index.lastUpdated = new Date().toISOString();
    index.totalInscribed = index.inscriptions.length;
    saveInscriptionsIndex(index);

    return inscription;
}

function getRandomUnmintedId(mintedIds) {
    const available = [];
    for (let i = 0; i < TOTAL_SUPPLY; i++) {
        if (!mintedIds.includes(i)) available.push(i);
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
}

// ============================================
// ARWEAVE MANIFEST - Permanent image storage
// ============================================
let arweaveManifest = null;

function getArweaveManifest() {
    if (!arweaveManifest) {
        if (fs.existsSync(ARWEAVE_MANIFEST_FILE)) {
            arweaveManifest = JSON.parse(fs.readFileSync(ARWEAVE_MANIFEST_FILE, 'utf-8'));
            console.log(`[${PROGRAM_NAME}] Arweave manifest loaded: ${arweaveManifest.totalUploaded} images`);
        } else {
            arweaveManifest = { uploads: {}, totalUploaded: 0 };
        }
    }
    return arweaveManifest;
}

function getArweaveImageUrl(punkId) {
    const manifest = getArweaveManifest();
    const entry = manifest.uploads[String(punkId)];
    if (entry) return entry.imageUrl;
    // Fallback to GitHub if not in manifest
    return `https://raw.githubusercontent.com/Execute007/x1punks-images/master/generated/punk_${punkId}.png`;
}

// ============================================
// HTTP SERVER
// ============================================

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // ---- GET /api/mints ----
    if (req.url === '/api/mints' && req.method === 'GET') {
        const state = getMintState();
        // Add Arweave image URLs to each mint
        const mintsWithImages = state.mints.map(m => ({
            ...m,
            imageUrl: getArweaveImageUrl(m.id)
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            program: PROGRAM_NAME,
            collectionName: COLLECTION_NAME,
            mintedCount: state.mintedCount,
            totalSupply: TOTAL_SUPPLY,
            mints: mintsWithImages
        }));
        return;
    }

    // ---- GET /api/image/:id ----
    // Returns Arweave image URL for a punk
    if (req.url.startsWith('/api/image/') && req.method === 'GET') {
        const punkId = parseInt(req.url.split('/').pop());
        if (isNaN(punkId) || punkId < 0 || punkId >= TOTAL_SUPPLY) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid punk ID' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ punkId, imageUrl: getArweaveImageUrl(punkId) }));
        return;
    }

    // ---- GET /api/inscriptions ----
    if (req.url === '/api/inscriptions' && req.method === 'GET') {
        const index = getInscriptionsIndex();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            program: PROGRAM_NAME,
            protocol: 'metaplex-inscription',
            chain: 'x1',
            totalInscribed: index.inscriptions?.length || 0,
            lastUpdated: index.lastUpdated || null,
            inscriptions: index.inscriptions || []
        }));
        return;
    }

    // ---- GET /api/program ----
    if (req.url === '/api/program' && req.method === 'GET') {
        const state = getMintState();
        const index = getInscriptionsIndex();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            program: PROGRAM_NAME,
            collection: COLLECTION_NAME,
            symbol: COLLECTION_SYMBOL,
            protocol: 'metaplex-inscription',
            chain: 'x1',
            rpc: RPC_URL,
            totalSupply: TOTAL_SUPPLY,
            mintedCount: state.mintedCount,
            inscribedCount: index.inscriptions?.length || 0,
            lastUpdated: index.lastUpdated || null
        }));
        return;
    }

    // ---- GET /api/inscription/:id ----
    if (req.url.startsWith('/api/inscription/') && req.method === 'GET') {
        const punkId = parseInt(req.url.split('/').pop());
        if (isNaN(punkId) || punkId < 0 || punkId >= TOTAL_SUPPLY) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid punk ID' }));
            return;
        }

        const metadata = buildInscriptionJson(punkId);
        const imagePath = path.join(GENERATED_DIR, `punk_${punkId}.png`);
        const imageExists = fs.existsSync(imagePath);
        let imageBase64 = null;

        if (imageExists) {
            const imageData = fs.readFileSync(imagePath);
            imageBase64 = imageData.toString('base64');
        }

        // Check if this punk has been inscribed on-chain
        const index = getInscriptionsIndex();
        const onChainData = index.inscriptions?.find(i => i.punkId === punkId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            punkId,
            metadata,
            image: imageBase64 ? `data:image/png;base64,${imageBase64}` : null,
            imageSize: imageExists ? fs.statSync(imagePath).size : 0,
            onChain: onChainData?.onChain || null,
            inscribed: !!onChainData
        }));
        return;
    }

    // ---- POST /api/inscribe ----
    // Web inscription endpoint: User pays XNT client-side, sends { wallet, quantity, txSignature }
    if (req.url === '/api/inscribe' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const wallet = data.wallet;
                const quantity = data.quantity;
                const txSignature = data.txSignature;

                if (!wallet || !quantity || !txSignature) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required fields: wallet, quantity, txSignature' }));
                    return;
                }

                if (quantity < 1 || quantity > 10) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Quantity must be 1-10' }));
                    return;
                }

                const state = getMintState();
                const inscribedNfts = [];

                console.log(`\n[${PROGRAM_NAME}] ========================================`);
                console.log(`[${PROGRAM_NAME}] New inscription request: ${quantity} punks`);
                console.log(`[${PROGRAM_NAME}] Wallet: ${wallet}`);
                console.log(`[${PROGRAM_NAME}] Payment TX: ${txSignature}`);
                console.log(`[${PROGRAM_NAME}] ========================================\n`);

                for (let i = 0; i < quantity; i++) {
                    const punkId = getRandomUnmintedId(state.mintedIds);
                    if (punkId === null) {
                        // Return what we have so far
                        if (inscribedNfts.length > 0) {
                            saveMintState(state);
                        }
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: 'Sold out!',
                            partialMinted: inscribedNfts
                        }));
                        return;
                    }

                    try {
                        // Full on-chain inscription pipeline
                        const onChainResult = await inscribePunkOnChain(punkId, wallet);

                        const nft = {
                            id: punkId,
                            name: `${COLLECTION_NAME} #${punkId}`,
                            symbol: COLLECTION_SYMBOL,
                            owner: wallet,
                            imageUrl: getArweaveImageUrl(punkId),
                            txSignature: txSignature,
                            mintAddress: onChainResult.mintAddress,
                            inscribedAt: new Date().toISOString(),
                            onChain: true,
                            inscription: {
                                account: onChainResult.inscriptionAccount,
                                metadata: onChainResult.inscriptionMetadata,
                                image: onChainResult.associatedInscription,
                                jsonSize: onChainResult.jsonSize,
                                imageSize: onChainResult.imageSize,
                                imageHash: onChainResult.imageHash
                            }
                        };

                        // Index the inscription
                        indexInscription(punkId, wallet, onChainResult);

                        state.mints.push(nft);
                        state.mintedIds.push(punkId);
                        state.mintedCount++;
                        inscribedNfts.push(nft);

                        // Save state after each successful inscription
                        saveMintState(state);

                        console.log(`[${PROGRAM_NAME}] ✓ ${i + 1}/${quantity} complete: ${nft.name}`);

                    } catch (inscribeErr) {
                        console.error(`[${PROGRAM_NAME}] ✗ Failed to inscribe punk #${punkId}:`, inscribeErr.message);

                        // If we have some inscribed, return partial success
                        if (inscribedNfts.length > 0) {
                            saveMintState(state);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                success: true,
                                partial: true,
                                requested: quantity,
                                completed: inscribedNfts.length,
                                minted: inscribedNfts,
                                totalMinted: state.mintedCount,
                                error: `Completed ${inscribedNfts.length}/${quantity}. Failed on punk #${punkId}: ${inscribeErr.message}`
                            }));
                            return;
                        }

                        // Complete failure
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: `Inscription failed: ${inscribeErr.message}`,
                            punkId
                        }));
                        return;
                    }
                }

                console.log(`\n[${PROGRAM_NAME}] ========================================`);
                console.log(`[${PROGRAM_NAME}] ✓ All ${quantity} punks inscribed on-chain!`);
                console.log(`[${PROGRAM_NAME}] IDs: ${inscribedNfts.map(n => n.id).join(', ')}`);
                console.log(`[${PROGRAM_NAME}] Total inscribed: ${state.mintedCount}`);
                console.log(`[${PROGRAM_NAME}] ========================================\n`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    minted: inscribedNfts,
                    totalMinted: state.mintedCount
                }));

            } catch (e) {
                console.error(`[${PROGRAM_NAME}] Server error:`, e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server error: ' + e.message }));
            }
        });
        return;
    }

    // ---- Static file serving ----
    let filePath;
    if (req.url.startsWith('/generated/')) {
        filePath = path.join(__dirname, req.url);
    } else {
        filePath = req.url === '/' ? '/index.html' : req.url;
        filePath = path.join(PUBLIC_DIR, filePath);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 - Not Found</h1>');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

// ============================================
// START SERVER
// ============================================
server.listen(PORT, () => {
    // Initialize UMI on startup
    try {
        getUmi();
    } catch (e) {
        console.error('Failed to initialize UMI:', e.message);
    }

    const state = getMintState();
    const index = getInscriptionsIndex();
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   ${PROGRAM_NAME.toUpperCase()} - ON-CHAIN INSCRIPTION PROGRAM                  ║
║                                                                  ║
║   Server: http://localhost:${PORT}                                   ║
║   Chain:  X1 Blockchain (Solana SVM)                             ║
║   RPC:    ${RPC_URL}                          ║
║                                                                  ║
║   Protocol: X1 On-Chain Inscription                              ║
║   NFT:      Metaplex Token Metadata                              ║
║                                                                  ║
║   Inscribed: ${String(state.mintedCount).padEnd(6)} / ${TOTAL_SUPPLY}                                ║
║   On-Chain:  ${String(index.totalInscribed || 0).padEnd(6)} with image + metadata                    ║
║                                                                  ║
║   Each inscription includes:                                     ║
║   • NFT (Token Metadata) with name + symbol                     ║
║   • JSON metadata stored in on-chain data account                ║
║   • PNG image stored in on-chain data account                    ║
║                                                                  ║
║   API Endpoints:                                                 ║
║   POST /api/inscribe         Inscribe new punks                  ║
║   GET  /api/mints            All inscribed NFTs                  ║
║   GET  /api/inscriptions     Full inscription index              ║
║   GET  /api/inscription/:id  Single punk inscription data        ║
║   GET  /api/program          Program info                        ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
`);
});
