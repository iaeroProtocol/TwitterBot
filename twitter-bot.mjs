// twitter-bot.mjs - Complete version with documentation integration
import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import OpenAI from 'openai';
import cron from 'node-cron';
import express from 'express';
import { ethers } from 'ethers';

// Health check server for Railway
const app = express();
const PORT = process.env.PORT || 3001;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

// Initialize clients
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Tweet templates and topics
const PROTOCOL_TOPICS = [
  "How iAERO's liquid staking works",
  "Benefits of permanent AERO locking vs 4-year locks",
  "LIQ token emissions and halving schedule",
  "Using stiAERO as collateral for borrowing",
  "Protocol security and audit results",
  "Yield optimization with iAERO staking",
  "veAERO voting power and bribes",
  "Protocol fee distribution model",
  "iAERO/AERO peg stability mechanics",
  "Staking rewards and current APR"
];

const SHITPOST_TOPICS = [
  "Market volatility",
  "DeFi yields",
  "Airdrop farming",
  "Gas fees",
  "Crypto Twitter drama",
  "Bull/bear market memes",
  "Liquidity mining",
  "Protocol wars on Base",
  "Whale movements",
  "CEX vs DEX debate"
];

// --- Minimal ABIs used by the stats code ---
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

// Compact number like you already do for TVL/locked/minted
function compactUSDorToken(n) {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n.toFixed(0);
}

// Read pair tokens + reserves
async function readPair(provider, pairAddr) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);

  const token0Raw = await pair.token0();
  const token1Raw = await pair.token1();

  // getReserves returns [reserve0, reserve1, blockTimestampLast]
  const reserves = await pair.getReserves();
  const reserve0 = reserves[0];
  const reserve1 = reserves[1];

  return { token0: token0Raw.toLowerCase(), token1: token1Raw.toLowerCase(), reserve0, reserve1 };
}

// Resolve token addresses (AERO, LIQ, iAERO) from the three pairs you already configured.
// It infers AERO from the AERO/USDC pair, LIQ from LIQ/USDC, and iAERO from iAERO/AERO.
async function resolveCoreTokens(provider, { AERO_USDC_POOL, LIQ_USDC_POOL, IAERO_AERO_POOL, USDC }) {
  const usdc = USDC.toLowerCase();

  // AERO from (AERO, USDC)
  const aeroPair = await readPair(provider, AERO_USDC_POOL);
  const AERO = (aeroPair.token0 === usdc ? aeroPair.token1 : aeroPair.token0);

  // LIQ from (LIQ, USDC)
  const liqPair = await readPair(provider, LIQ_USDC_POOL);
  const LIQ = (liqPair.token0 === usdc ? liqPair.token1 : liqPair.token0);

  // iAERO from (iAERO, AERO)
  const iaeroPair = await readPair(provider, IAERO_AERO_POOL);
  const IAERO = (iaeroPair.token0 === AERO ? iaeroPair.token1 : iaeroPair.token0);

  // decimals
  const decMap = new Map();
  async function putDecimals(addr) {
    const c = new ethers.Contract(addr, ERC20_DECIMALS_ABI, provider);
    const d = await c.decimals().catch(() => 18);
    decMap.set(addr.toLowerCase(), Number(d));
  }

  await Promise.all([
    putDecimals(AERO),
    putDecimals(LIQ),
    putDecimals(IAERO),
    putDecimals(usdc)
  ]);

  return {
    tokens: { AERO, LIQ, IAERO, USDC: usdc },
    decimals: decMap
  };
}

// Compute price(base in quote) from a pair, with decimals adjustment.
// Example: price of AERO in USDC from the AERO/USDC pool.
async function pairPrice(provider, pairAddr, baseAddr, quoteAddr, decMap) {
  const { token0, token1, reserve0, reserve1 } = await readPair(provider, pairAddr);
  const base = baseAddr.toLowerCase();
  const quote = quoteAddr.toLowerCase();

  // locate indices
  if (base !== token0 && base !== token1) throw new Error('base token not in pair');
  if (quote !== token0 && quote !== token1) throw new Error('quote token not in pair');

  const baseReserve = (base === token0) ? reserve0 : reserve1;
  const quoteReserve = (quote === token0) ? reserve0 : reserve1;

  const baseDec = decMap.get(base) ?? 18;
  const quoteDec = decMap.get(quote) ?? 18;

  // Normalize to floats using accurate decimals
  const baseFloat = parseFloat(ethers.formatUnits(baseReserve, baseDec));
  const quoteFloat = parseFloat(ethers.formatUnits(quoteReserve, quoteDec));
  if (baseFloat === 0) throw new Error('zero base reserve');
  return quoteFloat / baseFloat;
}


// Documentation context - hardcoded facts from docs.iaero.finance
function getDocumentationContext() {
  return {
    keyFacts: [
      "iAERO is a liquid staking protocol on Base network",
      "Users lock AERO permanently and receive liquid iAERO tokens at 0.95:1 ratio",
      "5% protocol fee means you get 0.95 iAERO for every 1 AERO deposited",
      "iAERO can be traded on DEXs while earning staking rewards",
      "Stakers of iAERO earn 80% of all protocol fees",
      "Protocol treasury receives 20% of fees",
      "LIQ token has a halving emission schedule every 5M tokens",
      "stiAERO (staked iAERO) can be used as collateral for borrowing",
      "Protocol owns permanently locked veAERO NFTs",
      "5% protocol fee on all AERO deposits",
      "No unlock period - iAERO is always liquid and tradeable",
      "iAERO maintains peg through arbitrage opportunities",
      "Staking rewards are distributed weekly after epoch ends",
      "Protocol is non-custodial and immutable"
    ],
    stats: {
      protocolFee: "5%",
      stakerShare: "80%",
      treasuryShare: "20%",
      liqEmissionModel: "halving per 5M tokens",
      stakingLockPeriod: "7 days for LIQ unstaking",
      conversionRatio: "0.95 iAERO per 1 AERO"
    }
  };
}

// Fetch GitBook content
async function fetchGitBookContent() {
  const baseUrl = 'https://docs.iaero.finance';
  const pages = [
    '/introduction/what-is-iaero',
    '/getting-started/key-concepts-and-how-to',
    '/getting-started/what-is-stiaero',
    '/getting-started/the-magic-of-iaero',
    '/tokenomics/iaero-token',
    '/tokenomics/liq-token',
  ];
  
  try {
    console.log('Fetching GitBook documentation...');
    const pageContents = await Promise.all(
      pages.map(async (page) => {
        const response = await fetch(`${baseUrl}${page}`);
        if (!response.ok) return '';
        const html = await response.text();
        // Strip HTML tags to get plain text
        const text = html.replace(/<[^>]*>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
        return text.substring(0, 2000); // Limit each page
      })
    );
    
    return pageContents.filter(content => content.length > 0).join('\n\n');
  } catch (error) {
    console.error('Failed to fetch GitBook:', error);
    return null;
  }
}

// Stats fetcher from your API
async function getProtocolStats() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org');

  // Addresses (you already had these)
  const VAULT_ADDRESS    = process.env.VAULT_ADDRESS     || '0x877398Aea8B5cCB0D482705c2D88dF768c953957';
  const IAERO_AERO_POOL  = process.env.IAERO_AERO_POOL   || '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd';
  const LIQ_USDC_POOL    = process.env.LIQ_USDC_POOL     || '0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4';
  const AERO_USDC_POOL   = process.env.AERO_USDC_POOL    || '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
  const USDC_ADDRESS     = process.env.USDC_ADDRESS      || '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

  // Vault ABI (unchanged)
  const VAULT_ABI = [
    'function totalAEROLocked() view returns (uint256)',
    'function totalLIQMinted() view returns (uint256)',
    'function totalIAEROMinted() view returns (uint256)',
    'function vaultStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)'
  ];

  // Initialize vault
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

  // Prepare defaults
  let aeroLockedNum = 0;
  let liqMintedNum = 0;
  let iAeroMintedNum = 0;

  let aeroPrice = NaN;
  let liqPrice  = NaN;
  let iaeroPeg  = NaN;

  // 1) Read vault numbers (isolated try/catch)
  try {
    const [aeroLocked, liqMinted, iAeroMinted] = await Promise.all([
      vault.totalAEROLocked(),
      vault.totalLIQMinted(),
      vault.totalIAEROMinted()
    ]);
    aeroLockedNum  = parseFloat(ethers.formatEther(aeroLocked));
    liqMintedNum   = parseFloat(ethers.formatEther(liqMinted));
    iAeroMintedNum = parseFloat(ethers.formatEther(iAeroMinted));
  } catch (err) {
    console.error('Vault metric fetch failed:', err?.message || err);
  }

  // 2) Resolve tokens/decimals from pairs once, then compute prices
  try {
    const { tokens, decimals } = await resolveCoreTokens(provider, {
      AERO_USDC_POOL,
      LIQ_USDC_POOL,
      IAERO_AERO_POOL,
      USDC: USDC_ADDRESS
    });

    // AERO price in USDC
    try {
      aeroPrice = await pairPrice(provider, AERO_USDC_POOL, tokens.AERO, tokens.USDC, decimals);
    } catch (e) {
      console.error('AERO price fetch failed:', e?.message || e);
    }

    // LIQ price in USDC
    try {
      liqPrice = await pairPrice(provider, LIQ_USDC_POOL, tokens.LIQ, tokens.USDC, decimals);
    } catch (e) {
      console.error('LIQ price fetch failed:', e?.message || e);
    }

    // iAERO peg (iAERO in AERO)
    try {
      iaeroPeg = await pairPrice(provider, IAERO_AERO_POOL, tokens.IAERO, tokens.AERO, decimals);
    } catch (e) {
      console.error('iAERO peg fetch failed:', e?.message || e);
    }
  } catch (err) {
    console.error('Token resolution failed (pairs/decimals):', err?.message || err);
  }

  // 3) Derived values (with graceful fallbacks)
  const tvl = isFinite(aeroPrice) ? aeroLockedNum * aeroPrice : 0;

  // 4) Build return object (mirror your original shape)
  return {
    tvl: compactUSDorToken(tvl),
    apy: '30', // placeholder until you wire a real figure
    totalStaked: compactUSDorToken(iAeroMintedNum), // your “iAERO minted” display
    liqPrice: isFinite(liqPrice) ? liqPrice.toFixed(4) : '0.0000',
    aeroLocked: compactUSDorToken(aeroLockedNum),
    aeroPrice: isFinite(aeroPrice) ? aeroPrice.toFixed(4) : '0.0000',
    iAeroPeg: isFinite(iaeroPeg) ? iaeroPeg.toFixed(4) : '1.0000',
    liqMinted: compactUSDorToken(liqMintedNum)
  };
}


// Generate protocol information tweet
async function generateProtocolTweet() {
  const topic = PROTOCOL_TOPICS[Math.floor(Math.random() * PROTOCOL_TOPICS.length)];
  const stats = await getProtocolStats();
  
  // Fetch real documentation
  const gitbookContent = await fetchGitBookContent();
  const docsContext = gitbookContent || getDocumentationContext().keyFacts.join('\n');
  
  const prompt = `Based on this documentation about iAERO Protocol:
${docsContext}

Create a tweet about: ${topic}

Current stats: TVL $${stats?.tvl}, APY ${stats?.apy}%

Requirements:
- Under 280 characters
- Factually accurate based on the docs
- Include 1-2 emojis
- Include 1-2 hashtags`;

  try {
    const response = await openai.responses.create({
      model: "gpt-5-mini",  // Using mini for cost optimization
      input: prompt,
      reasoning: { 
        effort: "minimal"  // Fast response for simple tweet generation
      },
      text: { 
        verbosity: "low"  // Keep tweets concise
      }
    });
    
    return response.output_text;
  } catch (error) {
    console.error('GPT-5 API error:', error);
    // Fallback tweets
    const fallbacks = [
      `🚀 Lock AERO permanently, get 0.95 iAERO. Trade anytime while earning 80% of protocol fees. No unlock periods on Base. TVL: $${stats?.tvl}`,
      `💎 iAERO: Permanent lock, liquid token. Earn 80% protocol fees + LIQ rewards. Always tradeable. ${stats?.apy}% APY`,
      `📊 Why lock for 4 years? iAERO gives permanent lock + liquid tokens. Trade, earn, use as collateral. DeFi evolved.`
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

// Generate crypto shitpost
async function generateShitpost() {
  const topic = SHITPOST_TOPICS[Math.floor(Math.random() * SHITPOST_TOPICS.length)];
  const docs = getDocumentationContext();
  
  const prompt = `Create a witty, crypto-native tweet about ${topic}. 
  
Context about iAERO (use subtly if relevant):
- Permanent locks with liquid tokens
- No unlock periods unlike traditional ve(3,3)
- On Base network with low fees
- 80% protocol fee distribution

Requirements:
- Be funny and relatable to crypto Twitter
- Use crypto slang naturally (gm, ser, anon, etc.)
- Subtly relate to liquid staking or iAERO if possible
- Keep under 280 characters
- Use emojis
- Max 1 hashtag
- Don't be overly promotional`;

  try {
    const response = await openai.responses.create({
      model: "gpt-5-nano",  // Using nano for high-throughput simple tasks
      input: prompt,
      reasoning: { 
        effort: "minimal"  // Shitposts don't need deep reasoning
      },
      text: { 
        verbosity: "medium"  // Allow some creativity
      }
    });
    
    return response.output_text;
  } catch (error) {
    console.error('GPT-5 API error:', error);
    const fallbacks = [
      "Watching people check their 4-year lock countdown every day while iAERO holders are out here liquid and vibing 😎 Some choose prison, we choose freedom ser",
      "Gas fees so high on mainnet, even the whales are migrating to Base 🐋 Good thing iAERO lives where transactions don't cost your firstborn",
      "POV: You're explaining to your wife why your AERO is locked until 2028 while the iAERO chad next door is compounding daily 🗿",
      "gm to everyone except those still doing 4 year locks in 2025. Permanent lock + liquid token or ngmi, no in between 💀",
      "Imagine locking tokens and NOT being able to rage quit after a bad proposal passes. Couldn't be iAERO holders 🤝"
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

// Post tweet
async function postTweet() {
  try {
    // 75% protocol info, 25% shitpost
    const isProtocolTweet = Math.random() < 0.75;
    
    let tweetContent = isProtocolTweet
      ? await generateProtocolTweet()
      : await generateShitpost();
    
    console.log(`[${new Date().toISOString()}] Posting tweet:`, tweetContent);
    
    // Validate tweet length
    if (tweetContent && tweetContent.length > 280) {
      console.error('Tweet too long, truncating...');
      tweetContent = tweetContent.substring(0, 277) + '...';
    }
    
    if (!tweetContent) {
      console.error('No tweet content generated');
      return;
    }
    
    const tweet = await twitterClient.v2.tweet(tweetContent);
    console.log('Tweet posted successfully:', tweet.data.id);
    
    return tweet;
  } catch (error) {
    console.error('Failed to post tweet:', error);
    if (error.code === 429) {
      console.log('Rate limited, will retry later');
    }
  }
}

// Random interval between 4-6 hours (in minutes)
function getRandomInterval() {
  return Math.floor(Math.random() * (360 - 240 + 1) + 240);
}

// Schedule next tweet
function scheduleNextTweet() {
  const minutes = getRandomInterval();
  const milliseconds = minutes * 60 * 1000;
  
  console.log(`Next tweet scheduled in ${minutes} minutes (${(minutes/60).toFixed(1)} hours)`);
  
  setTimeout(async () => {
    await postTweet();
    scheduleNextTweet();
  }, milliseconds);
}

// Start the bot
async function startBot() {
  console.log('🤖 iAERO Twitter Bot starting...');
  console.log('Configuration:', {
    hasTwitterCreds: !!process.env.TWITTER_API_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    hasDocsBot: !!process.env.DOCSBOT_API_KEY,
  });
  
  // Post first tweet immediately when deployed
  console.log('Posting initial tweet on startup...');
  await postTweet();
  
  // Schedule recurring tweets
  scheduleNextTweet();
  
  // Daily stats tweet at 2 PM UTC
  cron.schedule('0 14 * * *', async () => {
    console.log('Posting daily stats tweet...');
    const stats = await getProtocolStats();
    const docs = getDocumentationContext();
    
    if (stats) {
      const statsTweet = `📊 iAERO Daily Stats Update
        💰 TVL: $${stats.tvl}
        📈 APY: ${stats.apy}%
        🔒 AERO Locked: ${stats.aeroLocked}
        💎 iAERO Minted: ${stats.totalStaked}
        🪙 LIQ Minted: ${stats.liqMinted}

        Prices:
        - AERO: $${stats.aeroPrice}
        - LIQ: $${stats.liqPrice}
        - iAERO Peg: ${stats.iAeroPeg}x

        Lock. Stake. Earn. Stay liquid.`;
      
      try {
        await twitterClient.v2.tweet(statsTweet);
        console.log('Daily stats tweet posted');
      } catch (error) {
        console.error('Failed to post daily stats:', error);
      }
    }
  });
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

// Start the bot
startBot();
  "LIQ token emissions and halving schedule",
  "Using stiAERO as collateral for borrowing",
  "Protocol security and audit results",
  "Yield optimization with iAERO staking",
  "veAERO voting power and bribes",
  "Protocol fee distribution model",
  "iAERO/AERO peg stability mechanics",
  "Staking rewards and current APR"
];

const SHITPOST_TOPICS = [
  "Market volatility",
  "DeFi yields",
  "Airdrop farming",
  "Gas fees",
  "Crypto Twitter drama",
  "Bull/bear market memes",
  "Liquidity mining",
  "Protocol wars on Base",
  "Whale movements",
  "CEX vs DEX debate"
];

// --- Minimal ABIs used by the stats code ---
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

// Compact number like you already do for TVL/locked/minted
function compactUSDorToken(n) {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n.toFixed(0);
}

// Read pair tokens + reserves
async function readPair(provider, pairAddr) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [token0, token1, [reserve0, reserve1]] = await Promise.all([
    pair.token0(),
    pair.token1(),
    pair.getReserves()
  ]);
  return { token0: token0.toLowerCase(), token1: token1.toLowerCase(), reserve0, reserve1 };
}

// Resolve token addresses (AERO, LIQ, iAERO) from the three pairs you already configured.
// It infers AERO from the AERO/USDC pair, LIQ from LIQ/USDC, and iAERO from iAERO/AERO.
async function resolveCoreTokens(provider, { AERO_USDC_POOL, LIQ_USDC_POOL, IAERO_AERO_POOL, USDC }) {
  const usdc = USDC.toLowerCase();

  // AERO from (AERO, USDC)
  const aeroPair = await readPair(provider, AERO_USDC_POOL);
  const AERO = (aeroPair.token0 === usdc ? aeroPair.token1 : aeroPair.token0);

  // LIQ from (LIQ, USDC)
  const liqPair = await readPair(provider, LIQ_USDC_POOL);
  const LIQ = (liqPair.token0 === usdc ? liqPair.token1 : liqPair.token0);

  // iAERO from (iAERO, AERO)
  const iaeroPair = await readPair(provider, IAERO_AERO_POOL);
  const IAERO = (iaeroPair.token0 === AERO ? iaeroPair.token1 : iaeroPair.token0);

  // decimals
  const decMap = new Map();
  async function putDecimals(addr) {
    const c = new ethers.Contract(addr, ERC20_DECIMALS_ABI, provider);
    const d = await c.decimals().catch(() => 18);
    decMap.set(addr.toLowerCase(), Number(d));
  }

  await Promise.all([
    putDecimals(AERO),
    putDecimals(LIQ),
    putDecimals(IAERO),
    putDecimals(usdc)
  ]);

  return {
    tokens: { AERO, LIQ, IAERO, USDC: usdc },
    decimals: decMap
  };
}

// Compute price(base in quote) from a pair, with decimals adjustment.
// Example: price of AERO in USDC from the AERO/USDC pool.
async function pairPrice(provider, pairAddr, baseAddr, quoteAddr, decMap) {
  const { token0, token1, reserve0, reserve1 } = await readPair(provider, pairAddr);
  const base = baseAddr.toLowerCase();
  const quote = quoteAddr.toLowerCase();

  // locate indices
  if (base !== token0 && base !== token1) throw new Error('base token not in pair');
  if (quote !== token0 && quote !== token1) throw new Error('quote token not in pair');

  const baseReserve = (base === token0) ? reserve0 : reserve1;
  const quoteReserve = (quote === token0) ? reserve0 : reserve1;

  const baseDec = decMap.get(base) ?? 18;
  const quoteDec = decMap.get(quote) ?? 18;

  // Normalize to floats using accurate decimals
  const baseFloat = parseFloat(ethers.formatUnits(baseReserve, baseDec));
  const quoteFloat = parseFloat(ethers.formatUnits(quoteReserve, quoteDec));
  if (baseFloat === 0) throw new Error('zero base reserve');
  return quoteFloat / baseFloat;
}


// Documentation context - hardcoded facts from docs.iaero.finance
function getDocumentationContext() {
  return {
    keyFacts: [
      "iAERO is a liquid staking protocol on Base network",
      "Users lock AERO permanently and receive liquid iAERO tokens at 0.95:1 ratio",
      "5% protocol fee means you get 0.95 iAERO for every 1 AERO deposited",
      "iAERO can be traded on DEXs while earning staking rewards",
      "Stakers of iAERO earn 80% of all protocol fees",
      "Protocol treasury receives 20% of fees",
      "LIQ token has a halving emission schedule every 5M tokens",
      "stiAERO (staked iAERO) can be used as collateral for borrowing",
      "Protocol owns permanently locked veAERO NFTs",
      "5% protocol fee on all AERO deposits",
      "No unlock period - iAERO is always liquid and tradeable",
      "iAERO maintains peg through arbitrage opportunities",
      "Staking rewards are distributed weekly after epoch ends",
      "Protocol is non-custodial and immutable"
    ],
    stats: {
      protocolFee: "5%",
      stakerShare: "80%",
      treasuryShare: "20%",
      liqEmissionModel: "halving per 5M tokens",
      stakingLockPeriod: "7 days for LIQ unstaking",
      conversionRatio: "0.95 iAERO per 1 AERO"
    }
  };
}

// Fetch GitBook content
async function fetchGitBookContent() {
  const baseUrl = 'https://docs.iaero.finance';
  const pages = [
    '/introduction/what-is-iaero',
    '/getting-started/key-concepts-and-how-to',
    '/getting-started/what-is-stiaero',
    '/getting-started/the-magic-of-iaero',
    '/tokenomics/iaero-token',
    '/tokenomics/liq-token',
  ];
  
  try {
    console.log('Fetching GitBook documentation...');
    const pageContents = await Promise.all(
      pages.map(async (page) => {
        const response = await fetch(`${baseUrl}${page}`);
        if (!response.ok) return '';
        const html = await response.text();
        // Strip HTML tags to get plain text
        const text = html.replace(/<[^>]*>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
        return text.substring(0, 2000); // Limit each page
      })
    );
    
    return pageContents.filter(content => content.length > 0).join('\n\n');
  } catch (error) {
    console.error('Failed to fetch GitBook:', error);
    return null;
  }
}

// Stats fetcher from your API
async function getProtocolStats() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org');

  // Addresses (you already had these)
  const VAULT_ADDRESS    = process.env.VAULT_ADDRESS     || '0x877398Aea8B5cCB0D482705c2D88dF768c953957';
  const IAERO_AERO_POOL  = process.env.IAERO_AERO_POOL   || '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd';
  const LIQ_USDC_POOL    = process.env.LIQ_USDC_POOL     || '0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4';
  const AERO_USDC_POOL   = process.env.AERO_USDC_POOL    || '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
  const USDC_ADDRESS     = process.env.USDC_ADDRESS      || '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

  // Vault ABI (unchanged)
  const VAULT_ABI = [
    'function totalAEROLocked() view returns (uint256)',
    'function totalLIQMinted() view returns (uint256)',
    'function totalIAEROMinted() view returns (uint256)',
    'function vaultStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)'
  ];

  // Initialize vault
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

  // Prepare defaults
  let aeroLockedNum = 0;
  let liqMintedNum = 0;
  let iAeroMintedNum = 0;

  let aeroPrice = NaN;
  let liqPrice  = NaN;
  let iaeroPeg  = NaN;

  // 1) Read vault numbers (isolated try/catch)
  try {
    const [aeroLocked, liqMinted, iAeroMinted] = await Promise.all([
      vault.totalAEROLocked(),
      vault.totalLIQMinted(),
      vault.totalIAEROMinted()
    ]);
    aeroLockedNum  = parseFloat(ethers.formatEther(aeroLocked));
    liqMintedNum   = parseFloat(ethers.formatEther(liqMinted));
    iAeroMintedNum = parseFloat(ethers.formatEther(iAeroMinted));
  } catch (err) {
    console.error('Vault metric fetch failed:', err?.message || err);
  }

  // 2) Resolve tokens/decimals from pairs once, then compute prices
  try {
    const { tokens, decimals } = await resolveCoreTokens(provider, {
      AERO_USDC_POOL,
      LIQ_USDC_POOL,
      IAERO_AERO_POOL,
      USDC: USDC_ADDRESS
    });

    // AERO price in USDC
    try {
      aeroPrice = await pairPrice(provider, AERO_USDC_POOL, tokens.AERO, tokens.USDC, decimals);
    } catch (e) {
      console.error('AERO price fetch failed:', e?.message || e);
    }

    // LIQ price in USDC
    try {
      liqPrice = await pairPrice(provider, LIQ_USDC_POOL, tokens.LIQ, tokens.USDC, decimals);
    } catch (e) {
      console.error('LIQ price fetch failed:', e?.message || e);
    }

    // iAERO peg (iAERO in AERO)
    try {
      iaeroPeg = await pairPrice(provider, IAERO_AERO_POOL, tokens.IAERO, tokens.AERO, decimals);
    } catch (e) {
      console.error('iAERO peg fetch failed:', e?.message || e);
    }
  } catch (err) {
    console.error('Token resolution failed (pairs/decimals):', err?.message || err);
  }

  // 3) Derived values (with graceful fallbacks)
  const tvl = isFinite(aeroPrice) ? aeroLockedNum * aeroPrice : 0;

  // 4) Build return object (mirror your original shape)
  return {
    tvl: compactUSDorToken(tvl),
    apy: '30', // placeholder until you wire a real figure
    totalStaked: compactUSDorToken(iAeroMintedNum), // your “iAERO minted” display
    liqPrice: isFinite(liqPrice) ? liqPrice.toFixed(4) : '0.0000',
    aeroLocked: compactUSDorToken(aeroLockedNum),
    aeroPrice: isFinite(aeroPrice) ? aeroPrice.toFixed(4) : '0.0000',
    iAeroPeg: isFinite(iaeroPeg) ? iaeroPeg.toFixed(4) : '1.0000',
    liqMinted: compactUSDorToken(liqMintedNum)
  };
}


// Generate protocol information tweet
async function generateProtocolTweet() {
  const topic = PROTOCOL_TOPICS[Math.floor(Math.random() * PROTOCOL_TOPICS.length)];
  const stats = await getProtocolStats();
  
  // Fetch real documentation
  const gitbookContent = await fetchGitBookContent();
  const docsContext = gitbookContent || getDocumentationContext().keyFacts.join('\n');
  
  const prompt = `Based on this documentation about iAERO Protocol:
${docsContext}

Create a tweet about: ${topic}

Current stats: TVL $${stats?.tvl}, APY ${stats?.apy}%

Requirements:
- Under 280 characters
- Factually accurate based on the docs
- Include 1-2 emojis
- Include 1-2 hashtags`;

  try {
    const response = await openai.responses.create({
      model: "gpt-5-mini",  // Using mini for cost optimization
      input: prompt,
      reasoning: { 
        effort: "minimal"  // Fast response for simple tweet generation
      },
      text: { 
        verbosity: "low"  // Keep tweets concise
      }
    });
    
    return response.output_text;
  } catch (error) {
    console.error('GPT-5 API error:', error);
    // Fallback tweets
    const fallbacks = [
      `🚀 Lock AERO permanently, get 0.95 iAERO. Trade anytime while earning 80% of protocol fees. No unlock periods on Base. TVL: $${stats?.tvl}`,
      `💎 iAERO: Permanent lock, liquid token. Earn 80% protocol fees + LIQ rewards. Always tradeable. ${stats?.apy}% APY`,
      `📊 Why lock for 4 years? iAERO gives permanent lock + liquid tokens. Trade, earn, use as collateral. DeFi evolved.`
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

// Generate crypto shitpost
async function generateShitpost() {
  const topic = SHITPOST_TOPICS[Math.floor(Math.random() * SHITPOST_TOPICS.length)];
  const docs = getDocumentationContext();
  
  const prompt = `Create a witty, crypto-native tweet about ${topic}. 
  
Context about iAERO (use subtly if relevant):
- Permanent locks with liquid tokens
- No unlock periods unlike traditional ve(3,3)
- On Base network with low fees
- 80% protocol fee distribution

Requirements:
- Be funny and relatable to crypto Twitter
- Use crypto slang naturally (gm, ser, anon, etc.)
- Subtly relate to liquid staking or iAERO if possible
- Keep under 280 characters
- Use emojis
- Max 1 hashtag
- Don't be overly promotional`;

  try {
    const response = await openai.responses.create({
      model: "gpt-5-nano",  // Using nano for high-throughput simple tasks
      input: prompt,
      reasoning: { 
        effort: "minimal"  // Shitposts don't need deep reasoning
      },
      text: { 
        verbosity: "medium"  // Allow some creativity
      }
    });
    
    return response.output_text;
  } catch (error) {
    console.error('GPT-5 API error:', error);
    const fallbacks = [
      "Watching people check their 4-year lock countdown every day while iAERO holders are out here liquid and vibing 😎 Some choose prison, we choose freedom ser",
      "Gas fees so high on mainnet, even the whales are migrating to Base 🐋 Good thing iAERO lives where transactions don't cost your firstborn",
      "POV: You're explaining to your wife why your AERO is locked until 2028 while the iAERO chad next door is compounding daily 🗿",
      "gm to everyone except those still doing 4 year locks in 2025. Permanent lock + liquid token or ngmi, no in between 💀",
      "Imagine locking tokens and NOT being able to rage quit after a bad proposal passes. Couldn't be iAERO holders 🤝"
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

// Post tweet
async function postTweet() {
  try {
    // 75% protocol info, 25% shitpost
    const isProtocolTweet = Math.random() < 0.75;
    
    let tweetContent = isProtocolTweet
      ? await generateProtocolTweet()
      : await generateShitpost();
    
    console.log(`[${new Date().toISOString()}] Posting tweet:`, tweetContent);
    
    // Validate tweet length
    if (tweetContent && tweetContent.length > 280) {
      console.error('Tweet too long, truncating...');
      tweetContent = tweetContent.substring(0, 277) + '...';
    }
    
    if (!tweetContent) {
      console.error('No tweet content generated');
      return;
    }
    
    const tweet = await twitterClient.v2.tweet(tweetContent);
    console.log('Tweet posted successfully:', tweet.data.id);
    
    return tweet;
  } catch (error) {
    console.error('Failed to post tweet:', error);
    if (error.code === 429) {
      console.log('Rate limited, will retry later');
    }
  }
}

// Random interval between 4-6 hours (in minutes)
function getRandomInterval() {
  return Math.floor(Math.random() * (360 - 240 + 1) + 240);
}

// Schedule next tweet
function scheduleNextTweet() {
  const minutes = getRandomInterval();
  const milliseconds = minutes * 60 * 1000;
  
  console.log(`Next tweet scheduled in ${minutes} minutes (${(minutes/60).toFixed(1)} hours)`);
  
  setTimeout(async () => {
    await postTweet();
    scheduleNextTweet();
  }, milliseconds);
}

// Start the bot
async function startBot() {
  console.log('🤖 iAERO Twitter Bot starting...');
  console.log('Configuration:', {
    hasTwitterCreds: !!process.env.TWITTER_API_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    hasDocsBot: !!process.env.DOCSBOT_API_KEY,
  });
  
  // Post first tweet immediately when deployed
  console.log('Posting initial tweet on startup...');
  await postTweet();
  
  // Schedule recurring tweets
  scheduleNextTweet();
  
  // Daily stats tweet at 2 PM UTC
  cron.schedule('0 14 * * *', async () => {
    console.log('Posting daily stats tweet...');
    const stats = await getProtocolStats();
    const docs = getDocumentationContext();
    
    if (stats) {
      const statsTweet = `📊 iAERO Daily Stats Update
        💰 TVL: $${stats.tvl}
        📈 APY: ${stats.apy}%
        🔒 AERO Locked: ${stats.aeroLocked}
        💎 iAERO Minted: ${stats.totalStaked}
        🪙 LIQ Minted: ${stats.liqMinted}

        Prices:
        - AERO: $${stats.aeroPrice}
        - LIQ: $${stats.liqPrice}
        - iAERO Peg: ${stats.iAeroPeg}x

        Lock. Stake. Earn. Stay liquid.`;
      
      try {
        await twitterClient.v2.tweet(statsTweet);
        console.log('Daily stats tweet posted');
      } catch (error) {
        console.error('Failed to post daily stats:', error);
      }
    }
  });
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

// Start the bot
startBot();
  "LIQ token emissions and halving schedule",
  "Using stiAERO as collateral for borrowing",
  "Protocol security and audit results",
  "Yield optimization with iAERO staking",
  "veAERO voting power and bribes",
  "Protocol fee distribution model",
  "iAERO/AERO peg stability mechanics",
  "Staking rewards and current APR"
];

const SHITPOST_TOPICS = [
  "Market volatility",
  "DeFi yields",
  "Airdrop farming",
  "Gas fees",
  "Crypto Twitter drama",
  "Bull/bear market memes",
  "Liquidity mining",
  "Protocol wars on Base",
  "Whale movements",
  "CEX vs DEX debate"
];

// Documentation context - hardcoded facts from docs.iaero.finance
function getDocumentationContext() {
  return {
    keyFacts: [
      "iAERO is a liquid staking protocol on Base network",
      "Users lock AERO permanently and receive liquid iAERO tokens at 0.95:1 ratio",
      "5% protocol fee means you get 0.95 iAERO for every 1 AERO deposited",
      "iAERO can be traded on DEXs while earning staking rewards",
      "Stakers of iAERO earn 80% of all protocol fees",
      "Protocol treasury receives 20% of fees",
      "LIQ token has a halving emission schedule every 5M tokens",
      "stiAERO (staked iAERO) can be used as collateral for borrowing",
      "Protocol owns permanently locked veAERO NFTs",
      "5% protocol fee on all AERO deposits",
      "No unlock period - iAERO is always liquid and tradeable",
      "iAERO maintains peg through arbitrage opportunities",
      "Staking rewards are distributed weekly after epoch ends",
      "Protocol is non-custodial and immutable"
    ],
    stats: {
      protocolFee: "5%",
      stakerShare: "80%",
      treasuryShare: "20%",
      liqEmissionModel: "halving per 5M tokens",
      stakingLockPeriod: "7 days for LIQ unstaking",
      conversionRatio: "0.95 iAERO per 1 AERO"
    }
  };
}

// Fetch GitBook content
async function fetchGitBookContent() {
  const baseUrl = 'https://docs.iaero.finance';
  const pages = [
    '/introduction/what-is-iaero',
    '/getting-started/key-concepts-and-how-to',
    '/getting-started/what-is-stiaero',
    '/getting-started/the-magic-of-iaero',
    '/tokenomics/iaero-token',
    '/tokenomics/liq-token',
  ];
  
  try {
    console.log('Fetching GitBook documentation...');
    const pageContents = await Promise.all(
      pages.map(async (page) => {
        const response = await fetch(`${baseUrl}${page}`);
        if (!response.ok) return '';
        const html = await response.text();
        // Strip HTML tags to get plain text
        const text = html.replace(/<[^>]*>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
        return text.substring(0, 2000); // Limit each page
      })
    );
    
    return pageContents.filter(content => content.length > 0).join('\n\n');
  } catch (error) {
    console.error('Failed to fetch GitBook:', error);
    return null;
  }
}

// Stats fetcher from your API
async function getProtocolStats() {
  try {
    const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
    
    // Contract addresses
    const VAULT_ADDRESS = '0x877398Aea8B5cCB0D482705c2D88dF768c953957';
    const IAERO_AERO_POOL = '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd';
    const LIQ_USDC_POOL = '0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4';
    const USDC_AERO_POOL = '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
    const BASE_USDC = '0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913';
    
    // ABIs
    const VAULT_ABI = [
      'function totalAEROLocked() view returns (uint256)',
      'function totalLIQMinted() view returns (uint256)',
      'function totalIAEROMinted() view returns (uint256)',
      'function vaultStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)'
    ];
    
    const POOL_ABI = [
      'function getReserves() view returns (uint256,uint256,uint256)',
      'function token0() view returns (address)',
      'function token1() view returns (address)'
    ];
    
    // Initialize contracts
    const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);
    const liqPool = new ethers.Contract(LIQ_USDC_POOL, POOL_ABI, provider);
    const aeroPool = new ethers.Contract(USDC_AERO_POOL, POOL_ABI, provider);
    const iAeroPool = new ethers.Contract(IAERO_AERO_POOL, POOL_ABI, provider);
    
    // Split into two batches to avoid the 10 call limit
    // Batch 1: Vault data
    const [
      aeroLocked,
      liqMinted,
      iAeroMinted,
      vaultStatus
    ] = await Promise.all([
      vault.totalAEROLocked(),
      vault.totalLIQMinted(),
      vault.totalIAEROMinted(),
      vault.vaultStatus()
    ]);
    
    // Batch 2: Pool data
    const [
      liqReserves,
      liqToken0,
      liqToken1,
      aeroReserves,
      aeroToken0,
      aeroToken1,
      iAeroReserves,
      iAeroToken0,
      iAeroToken1
    ] = await Promise.all([
      liqPool.getReserves(),
      liqPool.token0(),
      liqPool.token1(),
      aeroPool.getReserves(),
      aeroPool.token0(),
      aeroPool.token1(),
      iAeroPool.getReserves(),
      iAeroPool.token0(),
      iAeroPool.token1()
    ]);
    
    // Calculate LIQ/USDC price
    const liqIsToken0 = liqToken0.toLowerCase() !== BASE_USDC.toLowerCase();
    const liqReserve = liqIsToken0 ? liqReserves[0] : liqReserves[1];
    const usdcReserveLiq = liqIsToken0 ? liqReserves[1] : liqReserves[0];
    const liqPrice = Number(usdcReserveLiq) * 1e12 / Number(liqReserve);
    
    // Calculate AERO/USDC price
    const aeroIsToken0 = aeroToken0.toLowerCase() !== BASE_USDC.toLowerCase();
    const aeroReserve = aeroIsToken0 ? aeroReserves[0] : aeroReserves[1];
    const usdcReserveAero = aeroIsToken0 ? aeroReserves[1] : aeroReserves[0];
    const aeroPrice = Number(usdcReserveAero) * 1e12 / Number(aeroReserve);
    
    // Calculate iAERO/AERO peg
    const iAeroIsToken0 = iAeroToken0.toLowerCase() < iAeroToken1.toLowerCase();
    const iAeroReserve = iAeroIsToken0 ? iAeroReserves[0] : iAeroReserves[1];
    const aeroReserveInPair = iAeroIsToken0 ? iAeroReserves[1] : iAeroReserves[0];
    const peg = Number(aeroReserveInPair) / Number(iAeroReserve);
    
    // Format values
    const aeroLockedNum = Number(ethers.formatEther(aeroLocked));
    const liqMintedNum = Number(ethers.formatEther(liqMinted));
    const iAeroMintedNum = Number(ethers.formatEther(iAeroMinted));
    
    // Calculate TVL
    const tvl = aeroLockedNum * aeroPrice;
    
    // Calculate APY (placeholder - implement actual calculation)
    const apy = 30;
    
    return {
      tvl: tvl > 1000000 ? `${(tvl / 1000000).toFixed(2)}M` : `${(tvl / 1000).toFixed(0)}K`,
      apy: apy.toString(),
      totalStaked: iAeroMintedNum > 1000000 ? `${(iAeroMintedNum / 1000000).toFixed(2)}M` : `${(iAeroMintedNum / 1000).toFixed(0)}K`,
      liqPrice: liqPrice.toFixed(4),
      aeroLocked: aeroLockedNum > 1000000 ? `${(aeroLockedNum / 1000000).toFixed(2)}M` : `${(aeroLockedNum / 1000).toFixed(0)}K`,
      aeroPrice: aeroPrice.toFixed(4),
      iAeroPeg: peg.toFixed(4),
      liqMinted: liqMintedNum > 1000000 ? `${(liqMintedNum / 1000000).toFixed(2)}M` : `${(liqMintedNum / 1000).toFixed(0)}K`
    };
    
  } catch (error) {
    console.error('Failed to fetch on-chain stats:', error);
    // Return placeholder data
    return {
      tvl: '0.02M',
      apy: '30',
      totalStaked: '0.02M',
      liqPrice: '0.15',
      aeroLocked: '0.02M',
      aeroPrice: '1.20',
      iAeroPeg: '85%',
      liqMinted: '950K'
    };
  }
}

// Generate protocol information tweet
async function generateProtocolTweet() {
  const topic = PROTOCOL_TOPICS[Math.floor(Math.random() * PROTOCOL_TOPICS.length)];
  const stats = await getProtocolStats();
  
  // Fetch real documentation
  const gitbookContent = await fetchGitBookContent();
  const docsContext = gitbookContent || getDocumentationContext().keyFacts.join('\n');
  
  const prompt = `Based on this documentation about iAERO Protocol:
${docsContext}

Create a tweet about: ${topic}

Current stats: TVL $${stats?.tvl}, APY ${stats?.apy}%

Requirements:
- Under 280 characters
- Factually accurate based on the docs
- Include 1-2 emojis
- Include 1-2 hashtags`;

  try {
    const response = await openai.responses.create({
      model: "gpt-5-mini",  // Using mini for cost optimization
      input: prompt,
      reasoning: { 
        effort: "minimal"  // Fast response for simple tweet generation
      },
      text: { 
        verbosity: "low"  // Keep tweets concise
      }
    });
    
    return response.output_text;
  } catch (error) {
    console.error('GPT-5 API error:', error);
    // Fallback tweets
    const fallbacks = [
      `🚀 Lock AERO permanently, get 0.95 iAERO. Trade anytime while earning 80% of protocol fees. No unlock periods on Base. TVL: $${stats?.tvl}`,
      `💎 iAERO: Permanent lock, liquid token. Earn 80% protocol fees + LIQ rewards. Always tradeable. ${stats?.apy}% APY`,
      `📊 Why lock for 4 years? iAERO gives permanent lock + liquid tokens. Trade, earn, use as collateral. DeFi evolved.`
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

// Generate crypto shitpost
async function generateShitpost() {
  const topic = SHITPOST_TOPICS[Math.floor(Math.random() * SHITPOST_TOPICS.length)];
  const docs = getDocumentationContext();
  
  const prompt = `Create a witty, crypto-native tweet about ${topic}. 
  
Context about iAERO (use subtly if relevant):
- Permanent locks with liquid tokens
- No unlock periods unlike traditional ve(3,3)
- On Base network with low fees
- 80% protocol fee distribution

Requirements:
- Be funny and relatable to crypto Twitter
- Use crypto slang naturally (gm, ser, anon, etc.)
- Subtly relate to liquid staking or iAERO if possible
- Keep under 280 characters
- Use emojis
- Max 1 hashtag
- Don't be overly promotional`;

  try {
    const response = await openai.responses.create({
      model: "gpt-5-nano",  // Using nano for high-throughput simple tasks
      input: prompt,
      reasoning: { 
        effort: "minimal"  // Shitposts don't need deep reasoning
      },
      text: { 
        verbosity: "medium"  // Allow some creativity
      }
    });
    
    return response.output_text;
  } catch (error) {
    console.error('GPT-5 API error:', error);
    const fallbacks = [
      "Watching people check their 4-year lock countdown every day while iAERO holders are out here liquid and vibing 😎 Some choose prison, we choose freedom ser",
      "Gas fees so high on mainnet, even the whales are migrating to Base 🐋 Good thing iAERO lives where transactions don't cost your firstborn",
      "POV: You're explaining to your wife why your AERO is locked until 2028 while the iAERO chad next door is compounding daily 🗿",
      "gm to everyone except those still doing 4 year locks in 2025. Permanent lock + liquid token or ngmi, no in between 💀",
      "Imagine locking tokens and NOT being able to rage quit after a bad proposal passes. Couldn't be iAERO holders 🤝"
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

// Post tweet
async function postTweet() {
  try {
    // 75% protocol info, 25% shitpost
    const isProtocolTweet = Math.random() < 0.75;
    
    let tweetContent = isProtocolTweet
      ? await generateProtocolTweet()
      : await generateShitpost();
    
    console.log(`[${new Date().toISOString()}] Posting tweet:`, tweetContent);
    
    // Validate tweet length
    if (tweetContent && tweetContent.length > 280) {
      console.error('Tweet too long, truncating...');
      tweetContent = tweetContent.substring(0, 277) + '...';
    }
    
    if (!tweetContent) {
      console.error('No tweet content generated');
      return;
    }
    
    const tweet = await twitterClient.v2.tweet(tweetContent);
    console.log('Tweet posted successfully:', tweet.data.id);
    
    return tweet;
  } catch (error) {
    console.error('Failed to post tweet:', error);
    if (error.code === 429) {
      console.log('Rate limited, will retry later');
    }
  }
}

// Random interval between 4-6 hours (in minutes)
function getRandomInterval() {
  return Math.floor(Math.random() * (360 - 240 + 1) + 240);
}

// Schedule next tweet
function scheduleNextTweet() {
  const minutes = getRandomInterval();
  const milliseconds = minutes * 60 * 1000;
  
  console.log(`Next tweet scheduled in ${minutes} minutes (${(minutes/60).toFixed(1)} hours)`);
  
  setTimeout(async () => {
    await postTweet();
    scheduleNextTweet();
  }, milliseconds);
}

// Start the bot
async function startBot() {
  console.log('🤖 iAERO Twitter Bot starting...');
  console.log('Configuration:', {
    hasTwitterCreds: !!process.env.TWITTER_API_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    hasDocsBot: !!process.env.DOCSBOT_API_KEY,
  });
  
  // Post first tweet immediately when deployed
  console.log('Posting initial tweet on startup...');
  await postTweet();
  
  // Schedule recurring tweets
  scheduleNextTweet();
  
  // Daily stats tweet at 2 PM UTC
  cron.schedule('0 14 * * *', async () => {
    console.log('Posting daily stats tweet...');
    const stats = await getProtocolStats();
    const docs = getDocumentationContext();
    
    if (stats) {
      const statsTweet = `📊 iAERO Daily Stats Update
        💰 TVL: $${stats.tvl}
        📈 APY: ${stats.apy}%
        🔒 AERO Locked: ${stats.aeroLocked}
        💎 iAERO Minted: ${stats.totalStaked}
        🪙 LIQ Minted: ${stats.liqMinted}

        Prices:
        - AERO: $${stats.aeroPrice}
        - LIQ: $${stats.liqPrice}
        - iAERO Peg: ${stats.iAeroPeg}x

        Lock. Stake. Earn. Stay liquid.`;
      
      try {
        await twitterClient.v2.tweet(statsTweet);
        console.log('Daily stats tweet posted');
      } catch (error) {
        console.error('Failed to post daily stats:', error);
      }
    }
  });
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

// Start the bot
startBot();
