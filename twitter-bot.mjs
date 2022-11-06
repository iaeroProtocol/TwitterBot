// twitter-bot.mjs — Fixed TVL reading issue
import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import OpenAI from 'openai';
import cron from 'node-cron';
import express from 'express';
import { ethers } from 'ethers';

/* ---------------- Health check (Railway) ---------------- */
const app = express();
const PORT = process.env.PORT || 3001;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

/* ---------------- Clients ---------------- */
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEBUG_STATS = process.env.DEBUG_STATS === '1';

/* ---------------- Topics ---------------- */
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

/* ---------------- Minimal ABIs ---------------- */
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

/* ---------------- Helpers ---------------- */
function compactUSDorToken(n) {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n.toFixed(0);
}

async function readPair(provider, pairAddr) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const token1 = (await pair.token1()).toLowerCase();
  const reserves = await pair.getReserves();
  const reserve0 = reserves[0];
  const reserve1 = reserves[1];
  return { token0, token1, reserve0, reserve1 };
}

async function resolveCoreTokens(provider, cfg) {
  const usdc = cfg.USDC.toLowerCase();

  // AERO from AERO/USDC
  const aeroPair = await readPair(provider, cfg.AERO_USDC_POOL);
  const AERO = (aeroPair.token0 === usdc) ? aeroPair.token1 : aeroPair.token0;

  // LIQ from LIQ/USDC
  const liqPair = await readPair(provider, cfg.LIQ_USDC_POOL);
  const LIQ = (liqPair.token0 === usdc) ? liqPair.token1 : liqPair.token0;

  // iAERO from iAERO/AERO
  const iaeroPair = await readPair(provider, cfg.IAERO_AERO_POOL);
  const IAERO = (iaeroPair.token0 === AERO) ? iaeroPair.token1 : iaeroPair.token0;

  // decimals
  const decMap = new Map();
  async function putDecimals(addr) {
    try {
      const c = new ethers.Contract(addr, ERC20_DECIMALS_ABI, provider);
      const d = await c.decimals();
      decMap.set(addr.toLowerCase(), Number(d));
    } catch {
      decMap.set(addr.toLowerCase(), 18);
    }
  }
  await putDecimals(AERO);
  await putDecimals(LIQ);
  await putDecimals(IAERO);
  await putDecimals(usdc);

  return { tokens: { AERO, LIQ, IAERO, USDC: usdc }, decimals: decMap };
}

async function pairPrice(provider, pairAddr, baseAddr, quoteAddr, decMap) {
  const info = await readPair(provider, pairAddr);
  const base = baseAddr.toLowerCase();
  const quote = quoteAddr.toLowerCase();

  if (base !== info.token0 && base !== info.token1) throw new Error('base not in pair');
  if (quote !== info.token0 && quote !== info.token1) throw new Error('quote not in pair');

  const baseReserve = (base === info.token0) ? info.reserve0 : info.reserve1;
  const quoteReserve = (quote === info.token0) ? info.reserve0 : info.reserve1;

  const baseDec = decMap.get(base) ?? 18;
  const quoteDec = decMap.get(quote) ?? 18;

  const baseFloat = parseFloat(ethers.formatUnits(baseReserve, baseDec));
  const quoteFloat = parseFloat(ethers.formatUnits(quoteReserve, quoteDec));
  if (baseFloat === 0) throw new Error('zero base reserve');
  return quoteFloat / baseFloat;
}

/* ---------------- Docs context + GitBook ---------------- */
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

async function fetchGitBookContent() {
  const baseUrl = 'https://docs.iaero.finance';
  const pages = [
    '/introduction/what-is-iaero',
    '/getting-started/key-concepts-and-how-to',
    '/getting-started/what-is-stiaero',
    '/getting-started/the-magic-of-iaero',
    '/tokenomics/iaero-token',
    '/tokenomics/liq-token'
  ];

  try {
    console.log('Fetching GitBook documentation...');
    const texts = [];
    for (const page of pages) {
      const resp = await fetch(`${baseUrl}${page}`);
      if (!resp.ok) continue;
      const html = await resp.text();
      const text = html
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
      if (text) texts.push(text);
    }
    return texts.join('\n\n');
  } catch (err) {
    console.error('Failed to fetch GitBook:', err);
    return null;
  }
}

/* ---------------- On-chain stats ---------------- */
async function getProtocolStats() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org');

  // Addresses
  const VAULT_ADDRESS   = process.env.VAULT_ADDRESS   || '0x877398Aea8B5cCB0D482705c2D88dF768c953957';
  const IAERO_AERO_POOL = process.env.IAERO_AERO_POOL || '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd';
  const LIQ_USDC_POOL   = process.env.LIQ_USDC_POOL   || '0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4';
  const AERO_USDC_POOL  = process.env.AERO_USDC_POOL  || '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
  const USDC_ADDRESS    = process.env.USDC_ADDRESS    || '0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913';

  // Correct ABI based on your actual PermalockVault_V5 contract
  const VAULT_ABI = [
    // These are public state variables in your contract (automatic getters)
    'function totalAEROLocked() view returns (uint256)',
    'function totalLIQMinted() view returns (uint256)', 
    'function totalIAEROMinted() view returns (uint256)',
    // vaultStatus returns comprehensive info
    'function vaultStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)',
    // Additional view functions from your contract
    'function getTotalValueLocked() view returns (uint256)'
  ];

  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

  let aeroLockedNum = 0;
  let liqMintedNum = 0;
  let iAeroMintedNum = 0;

  let aeroPrice = NaN;
  let liqPrice  = NaN;
  let iaeroPeg  = NaN;

  /* -------- 1) Read vault metrics directly -------- */
  let aeroLockedNum = 0;
  let liqMintedNum = 0;
  let iAeroMintedNum = 0;

  // Your contract has these as public state variables (automatic getters)
  try {
    const totalAEROLocked = await vault.totalAEROLocked();
    aeroLockedNum = parseFloat(ethers.formatEther(totalAEROLocked));
    console.log('✓ AERO locked from totalAEROLocked():', aeroLockedNum);
  } catch (e) {
    console.error('totalAEROLocked() failed:', e?.message || e);
    
    // Fallback: try getTotalValueLocked() which also returns totalAEROLocked
    try {
      const tvl = await vault.getTotalValueLocked();
      aeroLockedNum = parseFloat(ethers.formatEther(tvl));
      console.log('✓ AERO locked from getTotalValueLocked():', aeroLockedNum);
    } catch (e2) {
      console.error('getTotalValueLocked() failed:', e2?.message || e2);
    }
  }

  // If still zero, try vaultStatus() which returns totalUserDeposits as first value
  if (!aeroLockedNum || aeroLockedNum === 0) {
    try {
      const vs = await vault.vaultStatus();
      // vs[0] = totalUserDeposits = totalAEROLocked
      aeroLockedNum = parseFloat(ethers.formatEther(vs[0]));
      console.log('✓ AERO locked from vaultStatus()[0]:', aeroLockedNum);
    } catch (e) {
      console.error('vaultStatus() fallback failed:', e?.message || e);
    }
  }

  // Get LIQ minted
  try {
    const totalLIQMinted = await vault.totalLIQMinted();
    liqMintedNum = parseFloat(ethers.formatEther(totalLIQMinted));
    console.log('✓ LIQ minted:', liqMintedNum);
  } catch (e) {
    console.error('totalLIQMinted() failed:', e?.message || e);
  }

  // Get iAERO minted
  try {
    const totalIAEROMinted = await vault.totalIAEROMinted();
    iAeroMintedNum = parseFloat(ethers.formatEther(totalIAEROMinted));
    console.log('✓ iAERO minted:', iAeroMintedNum);
  } catch (e) {
    console.error('totalIAEROMinted() failed:', e?.message || e);
  }

  /* -------- 3) Get prices from DEX pools -------- */
  try {
    const { tokens, decimals } = await resolveCoreTokens(provider, {
      AERO_USDC_POOL, LIQ_USDC_POOL, IAERO_AERO_POOL, USDC: USDC_ADDRESS
    });

    if (DEBUG_STATS) {
      console.log('[DEBUG] Resolved tokens:', tokens);
      console.log('[DEBUG] Token decimals:', Array.from(decimals.entries()));
    }

    // Get AERO price in USDC
    try {
      aeroPrice = await pairPrice(provider, AERO_USDC_POOL, tokens.AERO, tokens.USDC, decimals);
      console.log('✓ AERO price:', aeroPrice);
    } catch (e) {
      console.error('AERO price failed:', e?.message || e);
    }

    // Get LIQ price in USDC
    try {
      liqPrice = await pairPrice(provider, LIQ_USDC_POOL, tokens.LIQ, tokens.USDC, decimals);
      console.log('✓ LIQ price:', liqPrice);
    } catch (e) {
      console.error('LIQ price failed:', e?.message || e);
    }

    // Get iAERO/AERO peg ratio
    try {
      iaeroPeg = await pairPrice(provider, IAERO_AERO_POOL, tokens.IAERO, tokens.AERO, decimals);
      console.log('✓ iAERO peg:', iaeroPeg);
    } catch (e) {
      console.error('iAERO peg failed:', e?.message || e);
    }
  } catch (e) {
    console.error('Token resolution failed:', e?.message || e);
  }

  /* -------- 4) Calculate TVL -------- */
  const tvlFloat = (isFinite(aeroPrice) && aeroLockedNum > 0) ? aeroLockedNum * aeroPrice : 0;

  console.log('=== PROTOCOL STATS ===');
  console.log('AERO Locked:', aeroLockedNum);
  console.log('AERO Price:', aeroPrice);
  console.log('TVL:', tvlFloat);
  console.log('iAERO Minted:', iAeroMintedNum);
  console.log('LIQ Minted:', liqMintedNum);
  console.log('====================');

  // Warn if TVL is still zero
  if (tvlFloat === 0) {
    console.warn('⚠️ WARNING: TVL is still 0. Check:');
    console.warn('1. Vault address is correct:', VAULT_ADDRESS);
    console.warn('2. Vault has deposits (check on basescan)');
    console.warn('3. Function names match your contract');
    console.warn('4. RPC endpoint is working properly');
  }

  /* -------- 5) Return formatted stats -------- */
  return {
    tvl:         compactUSDorToken(tvlFloat),
    apy:         '30', // placeholder
    totalStaked: compactUSDorToken(iAeroMintedNum),
    liqPrice:    isFinite(liqPrice)  ? liqPrice.toFixed(4)  : '0.0000',
    aeroLocked:  compactUSDorToken(aeroLockedNum),
    aeroPrice:   isFinite(aeroPrice) ? aeroPrice.toFixed(4) : '0.0000',
    iAeroPeg:    isFinite(iaeroPeg)  ? iaeroPeg.toFixed(4)  : '1.0000',
    liqMinted:   compactUSDorToken(liqMintedNum)
  };
}

/* ---------------- Tweet builders ---------------- */
async function generateProtocolTweet() {
  const topic = PROTOCOL_TOPICS[Math.floor(Math.random() * PROTOCOL_TOPICS.length)];
  const stats = await getProtocolStats();

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
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.8
    });
    return resp.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI error (protocol tweet):', error);
    const fallbacks = [
      `🚀 Lock AERO permanently, get 0.95 iAERO. Trade anytime while earning 80% of protocol fees. No unlock periods on Base. TVL: $${stats?.tvl}`,
      `💎 iAERO: Permanent lock, liquid token. Earn 80% protocol fees + LIQ rewards. Always tradeable. ${stats?.apy}% APY`,
      `📊 Why lock for 4 years? iAERO gives permanent lock + liquid tokens. Trade, earn, use as collateral. DeFi evolved.`
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

async function generateShitpost() {
  const topic = SHITPOST_TOPICS[Math.floor(Math.random() * SHITPOST_TOPICS.length)];

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
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.9
    });
    return resp.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI error (shitpost):', error);
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

/* ---------------- Posting loop ---------------- */
async function postTweet() {
  try {
    const isProtocolTweet = Math.random() < 0.75;
    let tweetContent = isProtocolTweet ? await generateProtocolTweet() : await generateShitpost();

    console.log(`[${new Date().toISOString()}] Posting tweet:`, tweetContent);

    if (tweetContent && tweetContent.length > 280) {
      console.warn('Tweet too long, truncating…');
      tweetContent = tweetContent.slice(0, 277) + '...';
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
    if (error && error.code === 429) console.log('Rate limited; will retry later');
  }
}

function getRandomIntervalMinutes() {
  // 4–6 hours
  return Math.floor(Math.random() * (360 - 240 + 1) + 240);
}

function scheduleNextTweet() {
  const minutes = getRandomIntervalMinutes();
  const ms = minutes * 60 * 1000;
  console.log(`Next tweet in ${minutes} minutes (${(minutes / 60).toFixed(1)} hours)`);

  setTimeout(async () => {
    await postTweet();
    scheduleNextTweet();
  }, ms);
}

/* ---------------- Bootstrap ---------------- */
async function startBot() {
  console.log('🤖 iAERO Twitter Bot starting...');
  console.log('Configuration:', {
    hasTwitterCreds: !!process.env.TWITTER_API_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    vaultAddress: process.env.VAULT_ADDRESS || '0x877398Aea8B5cCB0D482705c2D88dF768c953957'
  });

  // Test stats first to debug
  console.log('Testing protocol stats...');
  const testStats = await getProtocolStats();
  console.log('Test stats result:', testStats);

  // first tweet on startup
  await postTweet();

  // recurring
  scheduleNextTweet();

  // daily stats at 14:00 UTC
  cron.schedule('0 14 * * *', async () => {
    console.log('Posting daily stats tweet…');
    const stats = await getProtocolStats();
    if (stats) {
      const statsTweet =
`📊 iAERO Daily Stats
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

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully…');
  process.exit(0);
});

startBot();  "Benefits of permanent AERO locking vs 4-year locks",
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

/* ---------------- Minimal ABIs ---------------- */
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

/* ---------------- Helpers ---------------- */
function compactUSDorToken(n) {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n.toFixed(0);
}

// No nested destructuring; no Promise.all for this read
async function readPair(provider, pairAddr) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const token1 = (await pair.token1()).toLowerCase();
  const reserves = await pair.getReserves(); // [r0, r1, ts]
  const reserve0 = reserves[0];
  const reserve1 = reserves[1];
  return { token0, token1, reserve0, reserve1 };
}

async function resolveCoreTokens(provider, cfg) {
  const usdc = cfg.USDC.toLowerCase();

  // AERO from AERO/USDC
  const aeroPair = await readPair(provider, cfg.AERO_USDC_POOL);
  const AERO = (aeroPair.token0 === usdc) ? aeroPair.token1 : aeroPair.token0;

  // LIQ from LIQ/USDC
  const liqPair = await readPair(provider, cfg.LIQ_USDC_POOL);
  const LIQ = (liqPair.token0 === usdc) ? liqPair.token1 : liqPair.token0;

  // iAERO from iAERO/AERO
  const iaeroPair = await readPair(provider, cfg.IAERO_AERO_POOL);
  const IAERO = (iaeroPair.token0 === AERO) ? iaeroPair.token1 : iaeroPair.token0;

  // decimals (sequential avoids Promise.all bracket soup)
  const decMap = new Map();
  async function putDecimals(addr) {
    try {
      const c = new ethers.Contract(addr, ERC20_DECIMALS_ABI, provider);
      const d = await c.decimals();
      decMap.set(addr.toLowerCase(), Number(d));
    } catch {
      decMap.set(addr.toLowerCase(), 18);
    }
  }
  await putDecimals(AERO);
  await putDecimals(LIQ);
  await putDecimals(IAERO);
  await putDecimals(usdc);

  return { tokens: { AERO, LIQ, IAERO, USDC: usdc }, decimals: decMap };
}

async function pairPrice(provider, pairAddr, baseAddr, quoteAddr, decMap) {
  const info = await readPair(provider, pairAddr);
  const base = baseAddr.toLowerCase();
  const quote = quoteAddr.toLowerCase();

  if (base !== info.token0 && base !== info.token1) throw new Error('base not in pair');
  if (quote !== info.token0 && quote !== info.token1) throw new Error('quote not in pair');

  const baseReserve = (base === info.token0) ? info.reserve0 : info.reserve1;
  const quoteReserve = (quote === info.token0) ? info.reserve0 : info.reserve1;

  const baseDec = decMap.get(base) ?? 18;
  const quoteDec = decMap.get(quote) ?? 18;

  const baseFloat = parseFloat(ethers.formatUnits(baseReserve, baseDec));
  const quoteFloat = parseFloat(ethers.formatUnits(quoteReserve, quoteDec));
  if (baseFloat === 0) throw new Error('zero base reserve');
  return quoteFloat / baseFloat;
}

/* ---------------- Docs context + GitBook ---------------- */
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

async function fetchGitBookContent() {
  const baseUrl = 'https://docs.iaero.finance';
  const pages = [
    '/introduction/what-is-iaero',
    '/getting-started/key-concepts-and-how-to',
    '/getting-started/what-is-stiaero',
    '/getting-started/the-magic-of-iaero',
    '/tokenomics/iaero-token',
    '/tokenomics/liq-token'
  ];

  try {
    console.log('Fetching GitBook documentation...');
    const texts = [];
    for (const page of pages) {
      const resp = await fetch(`${baseUrl}${page}`);
      if (!resp.ok) continue;
      const html = await resp.text();
      const text = html
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
      if (text) texts.push(text);
    }
    return texts.join('\n\n');
  } catch (err) {
    console.error('Failed to fetch GitBook:', err);
    return null;
  }
}

/* ---------------- On-chain stats ---------------- */
async function getProtocolStats() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org');

  // Addresses (override via env to be 100% sure they match prod)
  const VAULT_ADDRESS   = process.env.VAULT_ADDRESS   || '0x877398Aea8B5cCB0D482705c2D88dF768c953957';
  const IAERO_AERO_POOL = process.env.IAERO_AERO_POOL || '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd';
  const LIQ_USDC_POOL   = process.env.LIQ_USDC_POOL   || '0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4';
  const AERO_USDC_POOL  = process.env.AERO_USDC_POOL  || '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
  const USDC_ADDRESS    = process.env.USDC_ADDRESS    || '0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913';

  // Minimal ABI for vault reads
  const VAULT_ABI = [
    'function totalAEROLocked() view returns (uint256)',
    'function totalLIQMinted() view returns (uint256)',
    'function totalIAEROMinted() view returns (uint256)',
    // fallback view in case the above is not behaving
    'function vaultStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)'
  ];

  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

  let aeroLockedNum = 0;
  let liqMintedNum = 0;
  let iAeroMintedNum = 0;

  let aeroPrice = NaN;
  let liqPrice  = NaN;
  let iaeroPeg  = NaN;

  /* -------- 1) Vault metrics with robust fallback -------- */
  try {
    const totalAEROLocked = await vault.totalAEROLocked();
    aeroLockedNum = parseFloat(ethers.formatEther(totalAEROLocked));
  } catch (e) {
    console.error('totalAEROLocked() failed:', e?.message || e);
  }

  // Fallback if zero (common cause of $0 TVL)
  if (!aeroLockedNum) {
    try {
      const vs = await vault.vaultStatus();
      // vs[0] = totalUserDeposits = totalAEROLocked (per your contract)
      aeroLockedNum = parseFloat(ethers.formatEther(vs[0]));
      if (DEBUG_STATS) console.log('[DEBUG] vaultStatus fallback totalAEROLocked:', aeroLockedNum);
    } catch (e) {
      console.error('vaultStatus() fallback failed:', e?.message || e);
    }
  }

  try {
    const totalLIQMinted = await vault.totalLIQMinted();
    liqMintedNum = parseFloat(ethers.formatEther(totalLIQMinted));
  } catch (e) {
    console.error('totalLIQMinted() failed:', e?.message || e);
  }

  try {
    const totalIAEROMinted = await vault.totalIAEROMinted();
    iAeroMintedNum = parseFloat(ethers.formatEther(totalIAEROMinted));
  } catch (e) {
    console.error('totalIAEROMinted() failed:', e?.message || e);
  }

  /* -------- 2) Resolve tokens and prices safely -------- */
  try {
    const { tokens, decimals } = await resolveCoreTokens(provider, {
      AERO_USDC_POOL, LIQ_USDC_POOL, IAERO_AERO_POOL, USDC: USDC_ADDRESS
    });

    if (DEBUG_STATS) {
      console.log('[DEBUG] Resolved tokens:', tokens);
    }

    try {
      aeroPrice = await pairPrice(provider, AERO_USDC_POOL, tokens.AERO, tokens.USDC, decimals);
    } catch (e) {
      console.error('AERO price failed:', e?.message || e);
    }

    try {
      liqPrice = await pairPrice(provider, LIQ_USDC_POOL, tokens.LIQ, tokens.USDC, decimals);
    } catch (e) {
      console.error('LIQ price failed:', e?.message || e);
    }

    try {
      iaeroPeg = await pairPrice(provider, IAERO_AERO_POOL, tokens.IAERO, tokens.AERO, decimals);
    } catch (e) {
      console.error('iAERO peg failed:', e?.message || e);
    }
  } catch (e) {
    console.error('Token resolution/decimals failed:', e?.message || e);
  }

  /* -------- 3) Derived values (with guards) -------- */
  const tvlFloat = isFinite(aeroPrice) ? aeroLockedNum * aeroPrice : 0;

  if (DEBUG_STATS) {
    console.log('[DEBUG] aeroLockedNum:', aeroLockedNum);
    console.log('[DEBUG] aeroPrice:', aeroPrice);
    console.log('[DEBUG] tvlFloat:', tvlFloat);
  }

  /* -------- 4) Return tweet-friendly shape -------- */
  return {
    tvl:         compactUSDorToken(tvlFloat),
    apy:         '30', // still placeholder until you wire real APY logic
    totalStaked: compactUSDorToken(iAeroMintedNum),
    liqPrice:    isFinite(liqPrice)  ? liqPrice.toFixed(4)  : '0.0000',
    aeroLocked:  compactUSDorToken(aeroLockedNum),
    aeroPrice:   isFinite(aeroPrice) ? aeroPrice.toFixed(4) : '0.0000',
    iAeroPeg:    isFinite(iaeroPeg)  ? iaeroPeg.toFixed(4)  : '1.0000',
    liqMinted:   compactUSDorToken(liqMintedNum)
  };
}

/* ---------------- Tweet builders ---------------- */
async function generateProtocolTweet() {
  const topic = PROTOCOL_TOPICS[Math.floor(Math.random() * PROTOCOL_TOPICS.length)];
  const stats = await getProtocolStats();

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
    const resp = await openai.responses.create({
      model: "gpt-5-mini",
      input: prompt,
      reasoning: { effort: "minimal" },
      text: { verbosity: "low" }
    });
    return resp.output_text;
  } catch (error) {
    console.error('OpenAI error (protocol tweet):', error);
    const fallbacks = [
      `🚀 Lock AERO permanently, get 0.95 iAERO. Trade anytime while earning 80% of protocol fees. No unlock periods on Base. TVL: $${stats?.tvl}`,
      `💎 iAERO: Permanent lock, liquid token. Earn 80% protocol fees + LIQ rewards. Always tradeable. ${stats?.apy}% APY`,
      `📊 Why lock for 4 years? iAERO gives permanent lock + liquid tokens. Trade, earn, use as collateral. DeFi evolved.`
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

async function generateShitpost() {
  const topic = SHITPOST_TOPICS[Math.floor(Math.random() * SHITPOST_TOPICS.length)];

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
    const resp = await openai.responses.create({
      model: "gpt-5-nano",
      input: prompt,
      reasoning: { effort: "minimal" },
      text: { verbosity: "medium" }
    });
    return resp.output_text;
  } catch (error) {
    console.error('OpenAI error (shitpost):', error);
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

/* ---------------- Posting loop ---------------- */
async function postTweet() {
  try {
    const isProtocolTweet = Math.random() < 0.75;
    let tweetContent = isProtocolTweet ? await generateProtocolTweet() : await generateShitpost();

    console.log(`[${new Date().toISOString()}] Posting tweet:`, tweetContent);

    if (tweetContent && tweetContent.length > 280) {
      console.warn('Tweet too long, truncating…');
      tweetContent = tweetContent.slice(0, 277) + '...';
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
    if (error && error.code === 429) console.log('Rate limited; will retry later');
  }
}

function getRandomIntervalMinutes() {
  // 4–6 hours
  return Math.floor(Math.random() * (360 - 240 + 1) + 240);
}

function scheduleNextTweet() {
  const minutes = getRandomIntervalMinutes();
  const ms = minutes * 60 * 1000;
  console.log(`Next tweet in ${minutes} minutes (${(minutes / 60).toFixed(1)} hours)`);

  setTimeout(async () => {
    await postTweet();
    scheduleNextTweet();
  }, ms);
}

/* ---------------- Bootstrap ---------------- */
async function startBot() {
  console.log('🤖 iAERO Twitter Bot starting...');
  console.log('Configuration:', {
    hasTwitterCreds: !!process.env.TWITTER_API_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY
  });

  // first tweet on startup
  await postTweet();

  // recurring
  scheduleNextTweet();

  // daily stats at 14:00 UTC
  cron.schedule('0 14 * * *', async () => {
    console.log('Posting daily stats tweet…');
    const stats = await getProtocolStats();
    if (stats) {
      const statsTweet =
`📊 iAERO Daily Stats
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

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully…');
  process.exit(0);
});

startBot();
