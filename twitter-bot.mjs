    // twitter-bot.mjs — Production version with hash deduplication and improvements
import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import OpenAI from 'openai';
import cron from 'node-cron';
import express from 'express';
import { ethers } from 'ethers';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// For ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const STRICT_ORIGINALITY = process.env.STRICT_ORIGINALITY === '1'; // Optional deep checks

// Create a persistent provider instance
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org');

// Cache for stats with TTL
let statsCache = {
  data: null,
  timestamp: 0,
  ttl: 5 * 60 * 1000 // 5 minute cache
};

/* ---------------- Hash-based deduplication ---------------- */
const HASH_FILE = path.join(__dirname, 'tweet-hashes.json');
let postedHashes = new Set();

async function loadHashes() {
  try {
    const data = await fs.readFile(HASH_FILE, 'utf8');
    postedHashes = new Set(JSON.parse(data));
    console.log(`Loaded ${postedHashes.size} historical tweet hashes`);
  } catch (err) {
    console.log('No existing hash file, starting fresh');
    postedHashes = new Set();
  }
}

async function saveHashes() {
  try {
    // Keep only last 500 hashes to prevent file growing too large
    const hashArray = [...postedHashes];
    const toSave = hashArray.slice(-500);
    await fs.writeFile(HASH_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save tweet hashes:', err);
  }
}

function hashTweet(content) {
  // Normalize tweet for hashing (lowercase, trim, remove extra spaces)
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/* ---------------- Topic cooldowns ---------------- */
const topicCooldowns = new Map();
const TOPIC_COOLDOWN_DAYS = 2; // Don't repeat same topic for N days

function isTopicOnCooldown(topic) {
  const lastUsed = topicCooldowns.get(topic);
  if (!lastUsed) return false;
  const daysSince = (Date.now() - lastUsed) / (1000 * 60 * 60 * 24);
  return daysSince < TOPIC_COOLDOWN_DAYS;
}

function markTopicUsed(topic) {
  topicCooldowns.set(topic, Date.now());
}

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

// Properly handle tweet length with multi-byte characters
function safeTrimTweet(tweet, maxLength = 280) {
  // Convert to array to handle multi-byte characters properly
  const chars = [...tweet];
  if (chars.length <= maxLength) return tweet;
  
  // Trim and add ellipsis
  return chars.slice(0, maxLength - 1).join('') + '…';
}

async function readPair(pairAddr) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const token1 = (await pair.token1()).toLowerCase();
  const reserves = await pair.getReserves();
  const reserve0 = reserves[0];
  const reserve1 = reserves[1];
  return { token0, token1, reserve0, reserve1 };
}

async function resolveCoreTokens(cfg) {
  const usdc = cfg.USDC.toLowerCase();

  // AERO from AERO/USDC
  const aeroPair = await readPair(cfg.AERO_USDC_POOL);
  const AERO = (aeroPair.token0 === usdc) ? aeroPair.token1 : aeroPair.token0;

  // LIQ from LIQ/USDC
  const liqPair = await readPair(cfg.LIQ_USDC_POOL);
  const LIQ = (liqPair.token0 === usdc) ? liqPair.token1 : liqPair.token0;

  // iAERO from iAERO/AERO
  const iaeroPair = await readPair(cfg.IAERO_AERO_POOL);
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

async function pairPrice(pairAddr, baseAddr, quoteAddr, decMap) {
  const info = await readPair(pairAddr);
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

let gitBookCache = null;
async function fetchGitBookContent() {
  // Return cached content if available
  if (gitBookCache) return gitBookCache;
  
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
    gitBookCache = texts.join('\n\n');
    return gitBookCache;
  } catch (err) {
    console.error('Failed to fetch GitBook:', err);
    return null;
  }
}

/* ---------------- On-chain stats with caching ---------------- */
async function getProtocolStats(forceRefresh = false) {
  // Return cached stats if still valid
  if (!forceRefresh && statsCache.data && (Date.now() - statsCache.timestamp) < statsCache.ttl) {
    console.log('Returning cached stats');
    return statsCache.data;
  }

  console.log('Fetching fresh protocol stats...');
  
  // Addresses
  const VAULT_ADDRESS   = process.env.VAULT_ADDRESS   || '0x877398Aea8B5cCB0D482705c2D88dF768c953957';
  const IAERO_AERO_POOL = process.env.IAERO_AERO_POOL || '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd';
  const LIQ_USDC_POOL   = process.env.LIQ_USDC_POOL   || '0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4';
  const AERO_USDC_POOL  = process.env.AERO_USDC_POOL  || '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
  const USDC_ADDRESS    = process.env.USDC_ADDRESS    || '0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913';

  const VAULT_ABI = [
    'function totalAEROLocked() view returns (uint256)',
    'function totalLIQMinted() view returns (uint256)', 
    'function totalIAEROMinted() view returns (uint256)',
    'function vaultStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)',
    'function getTotalValueLocked() view returns (uint256)'
  ];

  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

  let aeroLockedNum = 0;
  let liqMintedNum = 0;
  let iAeroMintedNum = 0;
  let aeroPrice = NaN;
  let liqPrice  = NaN;
  let iaeroPeg  = NaN;

  /* -------- Read vault metrics with retry logic -------- */
  const retryCall = async (fn, fallback = 0, maxRetries = 5) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (e) {
        console.error(`Attempt ${i + 1}/${maxRetries} failed:`, e?.message || e);
        if (i < maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, i), 5000); // Exponential backoff, max 5s
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    return fallback;
  };

  // Get AERO locked
  aeroLockedNum = await retryCall(async () => {
    const totalAEROLocked = await vault.totalAEROLocked();
    return parseFloat(ethers.formatEther(totalAEROLocked));
  });

  if (!aeroLockedNum) {
    aeroLockedNum = await retryCall(async () => {
      const tvl = await vault.getTotalValueLocked();
      return parseFloat(ethers.formatEther(tvl));
    });
  }

  if (!aeroLockedNum) {
    aeroLockedNum = await retryCall(async () => {
      const vs = await vault.vaultStatus();
      return parseFloat(ethers.formatEther(vs[0]));
    });
  }

  console.log('✓ AERO locked:', aeroLockedNum);

  // Get LIQ minted
  liqMintedNum = await retryCall(async () => {
    const totalLIQMinted = await vault.totalLIQMinted();
    return parseFloat(ethers.formatEther(totalLIQMinted));
  });
  console.log('✓ LIQ minted:', liqMintedNum);

  // Get iAERO minted
  iAeroMintedNum = await retryCall(async () => {
    const totalIAEROMinted = await vault.totalIAEROMinted();
    return parseFloat(ethers.formatEther(totalIAEROMinted));
  });
  console.log('✓ iAERO minted:', iAeroMintedNum);

  /* -------- Get prices from DEX pools -------- */
  try {
    const { tokens, decimals } = await resolveCoreTokens({
      AERO_USDC_POOL, LIQ_USDC_POOL, IAERO_AERO_POOL, USDC: USDC_ADDRESS
    });

    // Get AERO price
    aeroPrice = await retryCall(async () => {
      return await pairPrice(AERO_USDC_POOL, tokens.AERO, tokens.USDC, decimals);
    }, 0);
    console.log('✓ AERO price:', aeroPrice);

    // Get LIQ price
    liqPrice = await retryCall(async () => {
      return await pairPrice(LIQ_USDC_POOL, tokens.LIQ, tokens.USDC, decimals);
    }, 0);
    console.log('✓ LIQ price:', liqPrice);

    // Get iAERO peg
    iaeroPeg = await retryCall(async () => {
      return await pairPrice(IAERO_AERO_POOL, tokens.IAERO, tokens.AERO, decimals);
    }, 1);
    console.log('✓ iAERO peg:', iaeroPeg);
  } catch (e) {
    console.error('Price fetching failed:', e?.message || e);
  }

  // Calculate TVL
  const tvlFloat = (isFinite(aeroPrice) && aeroLockedNum > 0) ? aeroLockedNum * aeroPrice : 0;

  console.log('=== PROTOCOL STATS ===');
  console.log('AERO Locked:', aeroLockedNum);
  console.log('AERO Price:', aeroPrice);
  console.log('TVL:', tvlFloat);
  console.log('iAERO Minted:', iAeroMintedNum);
  console.log('LIQ Minted:', liqMintedNum);
  console.log('====================');

  const stats = {
    tvl:         compactUSDorToken(tvlFloat),
    apy:         '30', // placeholder
    totalStaked: compactUSDorToken(iAeroMintedNum),
    liqPrice:    isFinite(liqPrice)  ? liqPrice.toFixed(4)  : '0.0000',
    aeroLocked:  compactUSDorToken(aeroLockedNum),
    aeroPrice:   isFinite(aeroPrice) ? aeroPrice.toFixed(4) : '0.0000',
    iAeroPeg:    isFinite(iaeroPeg)  ? iaeroPeg.toFixed(4)  : '1.0000',
    liqMinted:   compactUSDorToken(liqMintedNum)
  };

  // Update cache
  statsCache = {
    data: stats,
    timestamp: Date.now(),
    ttl: statsCache.ttl
  };

  return stats;
}

/* ---------------- Tweet History & Similarity (ENHANCED) ---------------- */
let recentTweetsCache = {
  tweets: [],
  timestamp: 0,
  ttl: 30 * 60 * 1000 // 30 minute cache
};

async function getRecentTweets(count = 20) {
  // Return cached tweets if still valid
  if (recentTweetsCache.tweets && recentTweetsCache.tweets.length > 0 && 
      (Date.now() - recentTweetsCache.timestamp) < recentTweetsCache.ttl) {
    console.log('Using cached recent tweets');
    return recentTweetsCache.tweets;
  }

  try {
    console.log(`Fetching last ${count} tweets...`);
    
    // Get the authenticated user's ID with retry logic
    let userId = process.env.TWITTER_USER_ID; // Try env var first
    
    if (!userId) {
      try {
        const me = await twitterClient.v2.me();
        userId = me.data.id;
        console.log('Got Twitter user ID:', userId);
      } catch (meError) {
        console.error('Failed to get user ID:', meError?.message || meError);
        // If rate limited, just return cached tweets
        if (meError?.code === 429 || meError?.status === 429) {
          console.log('Rate limited on getting user ID, will retry later');
          return recentTweetsCache.tweets || [];
        }
        return recentTweetsCache.tweets || [];
      }
    }
    
    // Fetch recent tweets with error handling
    const tweets = await twitterClient.v2.userTimeline(userId, {
      max_results: Math.min(count, 100), // Twitter max is 100
      exclude: ['retweets', 'replies'],
      'tweet.fields': ['created_at', 'text']
    });
    
    // Better handling of paginator structure
    const timeline = await twitterClient.v2.userTimeline(userId, { /* opts */ });
    const tweetObjs = timeline?.data?.data ?? [];
    
    const tweetTexts = [];
    for (const tweet of tweetObjs) {
      if (!tweet?.text) continue;
      
      // Clean tweet text (remove URLs, mentions, etc for comparison)
      const cleanText = tweet.text
        .replace(/https?:\/\/\S+/g, '') // Remove URLs
        .replace(/@\w+/g, '') // Remove mentions
        .replace(/#/g, '') // Remove hashtag symbols but keep text
        .trim();
      if (cleanText.length > 10) { // Skip very short tweets
        tweetTexts.push(cleanText);
      }
    }
    
    // Update cache only if we got tweets
    if (tweetTexts.length > 0) {
      recentTweetsCache = {
        tweets: tweetTexts,
        timestamp: Date.now(),
        ttl: recentTweetsCache.ttl
      };
      console.log(`Retrieved ${tweetTexts.length} recent tweets`);
    } else {
      console.log('No tweets retrieved, using previous cache if available');
    }
    
    return tweetTexts.length > 0 ? tweetTexts : (recentTweetsCache.tweets || []);
  } catch (error) {
    console.error('Failed to fetch recent tweets:', error?.message || error);
    // Check if rate limited
    if (error?.code === 429 || error?.status === 429) {
      console.log('Rate limited by Twitter API, using cached tweets');
    }
    return recentTweetsCache.tweets || []; // Return cached tweets if available
  }
}

// ENHANCED: Detect structural similarity patterns (less aggressive)
function detectStructuralSimilarity(text1, text2) {
  // More targeted patterns that are genuinely repetitive
  const patterns = [
    /with a tvl of.*?and.*?apy of/i,
    /don't (let|miss) this opportunity/i,
    /join.*?today!/i,
    /dive into.*?with.*?tvl/i,
    /enhance your.*?today/i,
    /ready to.*?\?.*?with.*?tvl/i
  ];
  
  let matchCount = 0;
  for (const pattern of patterns) {
    if (pattern.test(text1) && pattern.test(text2)) {
      matchCount++;
    }
  }
  
  // Require 2+ pattern matches for similarity
  return matchCount >= 2;
}

// ENHANCED: Better similarity checking
async function isTwitterSimilar(newTweet, recentTweets, threshold = 0.35) {
  const cleanNewTweet = newTweet
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/#/g, '')
    .trim()
    .toLowerCase();
  
  for (const recentTweet of recentTweets) {
    if (!recentTweet) continue; // Guard against undefined
    
    const cleanRecent = recentTweet.toLowerCase();
    
    // Check structural similarity first
    if (detectStructuralSimilarity(cleanNewTweet, cleanRecent)) {
      console.log('Tweet has similar structure to recent tweet');
      return true;
    }
    
    // Check word overlap
    const words1 = new Set(cleanNewTweet.match(/\b\w+\b/g) || []);
    const words2 = new Set(cleanRecent.match(/\b\w+\b/g) || []);
    
    if (words1.size < 3 || words2.size < 3) continue;
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    const similarity = intersection.size / union.size;
    
    if (similarity > threshold) {
      console.log(`Tweet too similar (${(similarity * 100).toFixed(1)}% word match)`);
      return true;
    }
  }
  
  return false;
}

// ENHANCED: More thorough OpenAI check (optional based on env)
async function checkWithOpenAI(newTweet, recentTweets) {
  // Skip if not in strict mode
  if (!STRICT_ORIGINALITY) return false;
  
  const prompt = `Analyze if this new tweet is too similar to recent tweets.

New tweet:
"${newTweet}"

Recent tweets:
${recentTweets.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Check for:
1. Same structure (statement + stats + call-to-action)
2. Repeated phrases like "with a TVL of" or "APY of 30%"
3. Similar opening or closing phrases
4. Same style of presenting statistics
5. Identical sentiment or energy
6. Formulaic patterns
7. Generic marketing language

The goal is to have diverse, interesting tweets that don't feel bot-generated.

Respond with only "YES" if too similar/formulaic, or "NO" if sufficiently different and original.`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 10,
      temperature: 0.3
    });
    
    const result = resp.choices[0].message.content.trim().toUpperCase();
    return result.includes('YES');
  } catch (error) {
    console.error('OpenAI similarity check failed:', error);
    return false;
  }
}

/* ---------------- Tweet builders (COMPLETELY REWRITTEN) ---------------- */
async function generateProtocolTweet(maxAttempts = 5) {
  const recentTweets = await getRecentTweets();
  
  // Track which styles we've tried to avoid repetition
  const triedStyles = new Set();
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const stats = await getProtocolStats();
    
    if (!stats || stats.tvl === '0') {
      console.warn('Skipping protocol tweet due to invalid stats');
      return null;
    }

    // Filter out topics on cooldown
    const availableTopics = PROTOCOL_TOPICS.filter(t => !isTopicOnCooldown(t));
    if (availableTopics.length === 0) {
      // All topics on cooldown, use a random one anyway
      availableTopics.push(PROTOCOL_TOPICS[Math.floor(Math.random() * PROTOCOL_TOPICS.length)]);
    }
    
    const topic = availableTopics[Math.floor(Math.random() * availableTopics.length)];
    markTopicUsed(topic);

    // Choose different tweet styles
    const styles = [
      'educational',
      'comparison', 
      'question',
      'announcement',
      'thread_starter',
      'stat_highlight',
      'feature_focus',
      'user_story',
      'myth_buster',
      'tip',
      'observation',
      'analogy'
    ].filter(s => !triedStyles.has(s));
    
    if (styles.length === 0) {
      styles.push('educational'); // fallback
    }
    
    const style = styles[Math.floor(Math.random() * styles.length)];
    triedStyles.add(style);
    
    // Randomly decide whether to include stats (not every tweet needs them!)
    const includeStats = Math.random() < 0.3; // Only 30% of tweets include stats
    
    const gitbookContent = await fetchGitBookContent();
    const docsContext = gitbookContent || getDocumentationContext().keyFacts.join('\n');
    
    const statsContext = includeStats 
      ? `\nCurrent stats to potentially weave in naturally (DO NOT always use the format "with TVL of X and APY of Y"): 
         TVL ${stats.tvl}, APY ${stats.apy}%, AERO locked ${stats.aeroLocked}, iAERO/AERO peg ${stats.iAeroPeg}`
      : '\nDo not include specific stats in this tweet.';

    const recentContext = recentTweets.length > 0 
      ? `\n\nThese recent tweets exist - make sure yours is COMPLETELY different in structure, tone, and approach:\n${recentTweets.slice(0, 8).join('\n---\n')}`
      : '';

    const styleGuides = {
      educational: 'Teach something specific. Start with "Did you know" or "Fun fact" or "TIL".',
      comparison: 'Compare iAERO to traditional locking without using stats. Focus on user experience.',
      question: 'Ask an engaging question that makes people think. No call to action.',
      announcement: 'Make it sound like news or an update. Use active voice.',
      thread_starter: 'Write as if starting a thread. End with "A thread 🧵" or "Let me explain 👇"',
      stat_highlight: 'Lead with ONE impressive number, tell a story about what it means.',
      feature_focus: 'Deep dive into ONE specific feature. Be technical but accessible.',
      user_story: 'Write from a user perspective. "Just realized..." or "The moment when..."',
      myth_buster: 'Debunk a misconception. "Myth:" followed by "Reality:"',
      tip: 'Give a specific tip for using iAERO better. "Pro tip:" or "Quick tip:"',
      observation: 'Share an interesting observation about DeFi or the protocol. Be thoughtful.',
      analogy: 'Use a creative analogy to explain iAERO. Make it memorable.'
    };

    const prompt = `Based on this documentation about iAERO Protocol:
${docsContext}

Create a ${style} style tweet about: ${topic}

Style guide: ${styleGuides[style] || 'Be creative and original.'}
${statsContext}
${recentContext}

CRITICAL REQUIREMENTS:
- Under 280 characters
- MUST be completely different from the recent tweets above
- FORBIDDEN phrases: "with a TVL of", "and APY of", "don't miss this opportunity", "join us today", "dive into", "enhance your", "ready to"
- Avoid the structure: [generic statement] + [stats] + [call to action]
- If including stats, weave them naturally into the narrative, don't list them
- Use varied emoji (not always 🚀💎)
- Maximum 1 hashtag (and vary them - not always #iAERO)
- Be specific, not generic marketing speak
- Sound like a human crypto enthusiast, not a corporate bot
- Have personality and opinion

Write in ${style} style specifically. Be creative and original.`;

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 100,
        temperature: 0.95 + (attempt * 0.03), // Higher base temperature
        presence_penalty: 0.7, // Penalize repetition more
        frequency_penalty: 0.7  // Encourage variety more
      });
      
      const generatedTweet = resp.choices[0].message.content.trim();
      
      // Check against hash history first
      const tweetHash = hashTweet(generatedTweet);
      if (postedHashes.has(tweetHash)) {
        console.log(`Tweet hash already exists (attempt ${attempt + 1}), regenerating...`);
        continue;
      }
      
      // Enhanced similarity check
      const isSimilar = await isTwitterSimilar(generatedTweet, recentTweets, 0.35);
      
      // Optional OpenAI check based on STRICT_ORIGINALITY env var
      const failsDeepCheck = STRICT_ORIGINALITY && !isSimilar && 
                             await checkWithOpenAI(generatedTweet, recentTweets.slice(0, 10));
      
      if (!isSimilar && !failsDeepCheck) {
        console.log(`Generated original ${style} tweet on attempt ${attempt + 1}`);
        return generatedTweet;
      }
      
      console.log(`Tweet too similar (${style} style, attempt ${attempt + 1}), trying different style...`);
      
    } catch (error) {
      console.error('OpenAI error (protocol tweet):', error);
      break;
    }
  }
  
  // More diverse fallbacks without stats repetition
  const fallbacks = [
    `Did you know? Every iAERO holder owns a piece of permanently locked veAERO. The lock never expires, but your tokens stay liquid. Best of both worlds.`,
    `Thread: Why permanent locks beat 4-year locks 🧵\n\n1. No re-locking every cycle\n2. Your tokens stay liquid\n3. Same voting power\n4. Exit anytime\n\nThat's iAERO.`,
    `Fun fact: iAERO holders have been earning fees since day 1, while 4-year lockers are still waiting for their first unlock. Time in market > timing market.`,
    `The math is simple: 0.95 iAERO per AERO locked. That 5% fee? Funds the protocol that keeps your tokens liquid forever. Fair trade if you ask me.`,
    `Question for AERO lockers: What happens if you need liquidity before 2028?\n\niAERO users: "What do you mean? We can sell anytime."`,
    `Myth: You need to lock tokens to earn maximum rewards\n\nReality: iAERO earns the same rewards with zero lock time. Permanent lock, liquid token.`,
    `Pro tip: You can use stiAERO as collateral while still earning staking rewards. Double your capital efficiency. Not financial advice, just protocol facts.`,
    `Weekly reminder that your AERO could be earning fees RIGHT NOW instead of sitting in a 4-year waiting room. Just saying.`,
    `The moment when you realize iAERO gives you veAERO voting power without the veAERO prison sentence >>>`,
    `Observation: Every week, more AERO flows into permanent locks via iAERO. Every week, traditional lockers wait for 2028. See the pattern?`,
    `Think of iAERO like a backstage pass that never expires. You get all the VIP benefits but can leave the concert whenever you want.`,
    `LIQ tokenomics update: Still halving every 5M tokens. Still rewarding stakers. Still making traditional emissions look outdated.`
  ];
  
  // Try fallbacks that aren't in hash history
  for (const fallback of fallbacks.sort(() => Math.random() - 0.5)) {
    const hash = hashTweet(fallback);
    if (!postedHashes.has(hash) && !await isTwitterSimilar(fallback, recentTweets, 0.3)) {
      console.log('Using creative fallback tweet');
      return fallback;
    }
  }
  
  console.error('Could not generate unique tweet');
  return null;
}

async function generateShitpost(maxAttempts = 4) {
  const recentTweets = await getRecentTweets();
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const topic = SHITPOST_TOPICS[Math.floor(Math.random() * SHITPOST_TOPICS.length)];

    // Include recent tweets context
    const recentContext = recentTweets.length > 0
      ? `\n\nAVOID repeating themes or jokes from these recent tweets:\n${recentTweets.slice(0, 5).join('\n')}`
      : '';

    const shitpostStyles = [
      'meme_format',
      'crypto_slang_heavy',
      'fake_news_headline',
      'hot_take',
      'relatable_pain',
      'chad_vs_virgin',
      'year_2028_joke',
      'wife_changing_money'
    ];
    
    const style = shitpostStyles[Math.floor(Math.random() * shitpostStyles.length)];

    const prompt = `Create a witty, crypto-native shitpost about ${topic}.

Style: ${style}

Context about iAERO (use subtly if relevant):
- Permanent locks with liquid tokens
- No unlock periods unlike traditional ve(3,3)
- On Base network with low fees
- 80% protocol fee distribution
${recentContext}

Requirements:
- Be genuinely funny and relatable to crypto Twitter
- Use crypto slang naturally (gm, ser, anon, ngmi, wagmi, etc.)
- Subtly relate to liquid staking or iAERO if possible but don't force it
- Keep under 280 characters
- Use emojis creatively
- Max 1 hashtag (if any)
- Don't be overly promotional
- Must be original and different from recent tweets
- Have personality and edge

Style "${style}" specifically means:
${style === 'meme_format' ? 'Use a popular meme format like "Nobody: ... Me: ..."' : ''}
${style === 'crypto_slang_heavy' ? 'Go heavy on crypto Twitter slang and inside jokes' : ''}
${style === 'fake_news_headline' ? 'Write like a breaking news headline but make it absurd' : ''}
${style === 'hot_take' ? 'Share a spicy opinion that will get engagement' : ''}
${style === 'relatable_pain' ? 'Talk about a painful crypto experience everyone relates to' : ''}
${style === 'chad_vs_virgin' ? 'Compare chad behavior vs virgin behavior in DeFi' : ''}
${style === 'year_2028_joke' ? 'Make a joke about the year 2028 when locks expire' : ''}
${style === 'wife_changing_money' ? 'Make a wife-changing wealth joke' : ''}`;

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 100,
        temperature: 0.95 + (attempt * 0.03), // Even more creative for shitposts
        presence_penalty: 0.5,
        frequency_penalty: 0.5
      });
      
      const generatedTweet = resp.choices[0].message.content;
      
      // Check hash
      const tweetHash = hashTweet(generatedTweet);
      if (postedHashes.has(tweetHash)) {
        console.log(`Shitpost hash already exists (attempt ${attempt + 1}), regenerating...`);
        continue;
      }
      
      // Check similarity (lower threshold for shitposts since they should be more varied)
      const isSimilar = await isTwitterSimilar(generatedTweet, recentTweets, 0.3);
      
      if (!isSimilar) {
        console.log(`Generated original shitpost (${style}) on attempt ${attempt + 1}`);
        return generatedTweet;
      }
      
      console.log(`Shitpost too similar on attempt ${attempt + 1}, regenerating...`);
      
    } catch (error) {
      console.error('OpenAI error (shitpost):', error);
      break;
    }
  }
  
  // Diverse fallback shitposts
  const fallbacks = [
    "Nobody:\nAbsolutely nobody:\nMe checking if my 4-year lock has expired yet: 🤡\n\n(this post made by iAERO gang)",
    "Breaking: Area man discovers one weird trick to avoid 4-year token lockups. ve(3,3) protocols hate him! Click here to... just use iAERO lol 🗞️",
    "gm to everyone except those still doing 4 year locks in 2025\n\npermanent lock + liquid token or ngmi, there is no in between 💀",
    "Wife: why are his tokens free and yours are locked until 2028?\nMe: well you see there's this voting escrow mechanis-\nWife: *already left with iAERO chad*",
    "Year 2028:\n- Flying cars ❌\n- Mars colony ❌\n- Your tokens finally unlocked ✅\n- iAERO holders already 10x'd and retired ✅",
    "Therapist: Liquid permanent locks aren't real, they can't hurt you\n\niAERO: *exists*\n\nTraditional ve(3,3): 😰😰😰",
    "POV: You're explaining why locking for 4 years is actually good while the iAERO holder is already compounding their third yield farm 🌾",
    "Some of y'all never watched your locked tokens during a 90% dump and couldn't do anything about it and it shows 📉",
    "Imagine having to ask your tokens for permission to sell. Couldn't be me.\n\n- This post by liquid staking gang",
    "Sir, this is a Wendy's and your tokens are still locked for another 3.5 years",
    "Chad iAERO: trades whenever, earns max rewards, uses as collateral\nVirgin 4yr lock: checks unlock date daily, cries, waits",
    "Hot take: If your staking strategy requires a calendar reminder for 2028, you're doing it wrong 🗓️❌"
  ];
  
  // Try to find a diverse fallback not in history
  for (const fallback of fallbacks.sort(() => Math.random() - 0.5)) {
    const hash = hashTweet(fallback);
    if (!postedHashes.has(hash) && !await isTwitterSimilar(fallback, recentTweets, 0.35)) {
      console.log('Using fallback shitpost after generation failed');
      return fallback;
    }
  }
  
  console.error('Could not generate unique shitpost, skipping');
  return null;
}

/* ---------------- Posting loop with retry logic ---------------- */
async function postTweet(retries = 2) {
  let lastError = null;
  
  for (let i = 0; i <= retries; i++) {
    try {
      const isProtocolTweet = Math.random() < 0.7; // 70% protocol, 30% shitpost
      let tweetContent = isProtocolTweet ? await generateProtocolTweet() : await generateShitpost();

      // Skip if no content generated (e.g., due to bad stats or similarity)
      if (!tweetContent) {
        console.log('No tweet content generated, skipping...');
        return null;
      }

      // Check hash one more time before posting
      const tweetHash = hashTweet(tweetContent);
      if (postedHashes.has(tweetHash)) {
        console.log('Tweet hash collision detected before posting, regenerating...');
        continue;
      }

      // Safely trim tweet length
      tweetContent = safeTrimTweet(tweetContent, 280);

      console.log(`[${new Date().toISOString()}] Posting tweet:`, tweetContent);

      const tweet = await twitterClient.v2.tweet(tweetContent);
      console.log('Tweet posted successfully:', tweet.data.id);
      
      // Add to hash history
      postedHashes.add(tweetHash);
      await saveHashes();
      
      return tweet;
    } catch (error) {
      lastError = error;
      console.error(`Failed to post tweet (attempt ${i + 1}/${retries + 1}):`, error);
      
      if (error?.code === 429) {
        console.log('Rate limited; will retry later');
        break;
      }
      
      // Wait before retry with exponential backoff
      if (i < retries) {
        const waitTime = Math.min(1000 * Math.pow(2, i), 10000); // Max 10s
        console.log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(r => setTimeout(r, waitTime));
      }
    }
  }
  
  console.error('All post attempts failed:', lastError);
  return null;
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
  console.log('🤖 iAERO Twitter Bot starting (Production Version)...');
  console.log('Environment:', {
    platform: process.env.RAILWAY_ENVIRONMENT || 'local',
    node: process.version,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
    strictOriginality: STRICT_ORIGINALITY ? 'enabled' : 'disabled'
  });
  console.log('Configuration:', {
    hasTwitterCreds: !!process.env.TWITTER_API_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    vaultAddress: process.env.VAULT_ADDRESS || '0x877398Aea8B5cCB0D482705c2D88dF768c953957',
    rpcUrl: process.env.RPC_URL ? 'custom' : 'default Base RPC'
  });

  // Load hash history
  await loadHashes();

  // Warm up the caches
  console.log('Initializing stats cache...');
  const testStats = await getProtocolStats(true); // force refresh
  console.log('Initial stats:', testStats);
  
  // Prefetch GitBook content
  await fetchGitBookContent();
  
  // Prefetch recent tweets (but don't fail startup if it errors)
  try {
    console.log('Loading recent tweet history...');
    await getRecentTweets();
  } catch (error) {
    console.error('Could not load tweet history on startup:', error?.message);
    console.log('Bot will continue without tweet history for now');
  }

  // First tweet on startup (only if we have valid stats)
  if (testStats && testStats.tvl !== '0') {
    // Add small delay if we were rate limited
    if (!recentTweetsCache.tweets || recentTweetsCache.tweets.length === 0) {
      console.log('Waiting 30s before first tweet due to rate limit...');
      await new Promise(r => setTimeout(r, 30000));
    }
    await postTweet();
  } else {
    console.log('Skipping initial tweet due to invalid stats');
  }

  // Schedule recurring tweets
  scheduleNextTweet();

  // Daily stats at 14:00 UTC (keep this formulaic since it's meant to be consistent)
  cron.schedule('0 14 * * *', async () => {
    console.log('Posting daily stats tweet…');
    const stats = await getProtocolStats(true); // force refresh for daily stats
    if (stats && stats.tvl !== '0') {
      let statsTweet =
`📊 iAERO Daily Stats
💰 TVL: ${stats.tvl}
📈 APY: ${stats.apy}%
🔒 AERO Locked: ${stats.aeroLocked}
💎 iAERO Minted: ${stats.totalStaked}
🪙 LIQ Minted: ${stats.liqMinted}

Prices:
• AERO: $${stats.aeroPrice}
• LIQ: $${stats.liqPrice}
• iAERO/AERO: ${stats.iAeroPeg}

Lock. Stake. Earn. Stay liquid.`;

      // Ensure it fits
      statsTweet = safeTrimTweet(statsTweet, 280);

      try {
        await twitterClient.v2.tweet(statsTweet);
        console.log('Daily stats tweet posted');
      } catch (error) {
        console.error('Failed to post daily stats:', error);
      }
    }
  });

  // Refresh stats cache every 5 minutes
  setInterval(async () => {
    console.log('Refreshing stats cache...');
    try {
      await getProtocolStats(true);
    } catch (error) {
      console.error('Stats refresh failed:', error?.message);
    }
  }, 5 * 60 * 1000);

  // Save hashes periodically (every 30 mins)
  setInterval(async () => {
    await saveHashes();
    console.log('Saved tweet hashes to disk');
  }, 30 * 60 * 1000);
  
  // Memory monitoring for Railway (every 30 minutes)
  setInterval(() => {
    const usage = process.memoryUsage();
    console.log('Memory usage:', {
      rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
      heap: `${Math.round(usage.heapUsed / 1024 / 1024)}MB / ${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
      external: `${Math.round(usage.external / 1024 / 1024)}MB`,
      hashCount: postedHashes.size,
      topicCooldowns: topicCooldowns.size
    });
  }, 30 * 60 * 1000);
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  // Don't exit process - let it recover
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Critical error - exit and let Railway restart
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, saving state and shutting down gracefully…');
  await saveHashes();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, saving state and shutting down gracefully…');
  await saveHashes();
  process.exit(0);
});

startBot().catch(err => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
