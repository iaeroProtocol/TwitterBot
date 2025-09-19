// twitter-bot.mjs — Fixed with connection reuse and caching
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

// Create a persistent provider instance
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org');

// Cache for stats with TTL
let statsCache = {
  data: null,
  timestamp: 0,
  ttl: 5 * 60 * 1000 // 5 minute cache
};

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

/* ---------------- Tweet History & Similarity ---------------- */
let recentTweetsCache = {
  tweets: [],
  timestamp: 0,
  ttl: 30 * 60 * 1000 // 30 minute cache (increased from 10)
};

async function getRecentTweets(count = 20) {
  // Return cached tweets if still valid
  if (recentTweetsCache.tweets.length > 0 && 
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
        // If rate limited, just return empty array for now
        if (meError?.code === 429 || meError?.status === 429) {
          console.log('Rate limited on getting user ID, will retry later');
          // Don't update cache timestamp so we retry next time
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
    
    const tweetTexts = [];
    if (tweets && tweets.data) {
      for (const tweet of tweets.data.data || tweets.data || []) {
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

// Simple similarity check using Jaccard index for word overlap
function calculateSimilarity(text1, text2) {
  // Convert to lowercase and extract words
  const words1 = new Set(text1.toLowerCase().match(/\b\w+\b/g) || []);
  const words2 = new Set(text2.toLowerCase().match(/\b\w+\b/g) || []);
  
  // Skip very short texts
  if (words1.size < 3 || words2.size < 3) return 0;
  
  // Calculate Jaccard similarity
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size;
}

async function isTwitterSimilar(newTweet, recentTweets, threshold = 0.5) {
  // Clean the new tweet for comparison
  const cleanNewTweet = newTweet
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/#/g, '')
    .trim();
  
  for (const recentTweet of recentTweets) {
    const similarity = calculateSimilarity(cleanNewTweet, recentTweet);
    if (similarity > threshold) {
      console.log(`Tweet too similar (${(similarity * 100).toFixed(1)}% match) to recent tweet`);
      return true;
    }
  }
  
  return false;
}

async function checkWithOpenAI(newTweet, recentTweets) {
  // Use OpenAI for more sophisticated similarity check
  const prompt = `Analyze if this new tweet is too similar to recent tweets.

New tweet:
"${newTweet}"

Recent tweets:
${recentTweets.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Is the new tweet too similar in meaning, structure, or key phrases to any recent tweets? Consider:
- Similar jokes or memes
- Repeated key phrases or concepts  
- Same statistics or facts presented similarly
- Identical tweet structure or format

Respond with only "YES" if too similar, or "NO" if sufficiently different.`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 10,
      temperature: 0.3
    });
    
    const result = resp.choices[0].message.content.trim().toUpperCase();
    return result.includes('YES');
  } catch (error) {
    console.error('OpenAI similarity check failed:', error);
    // Fall back to simple similarity check
    return false;
  }
}

/* ---------------- Tweet builders with originality checks ---------------- */
async function generateProtocolTweet(maxAttempts = 3) {
  // Get recent tweets for comparison
  const recentTweets = await getRecentTweets();
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const topic = PROTOCOL_TOPICS[Math.floor(Math.random() * PROTOCOL_TOPICS.length)];
    
    // Use cached stats to avoid multiple RPC calls
    const stats = await getProtocolStats();
    
    // Don't tweet if we don't have valid stats
    if (!stats || stats.tvl === '0') {
      console.warn('Skipping protocol tweet due to invalid stats');
      return null;
    }

    const gitbookContent = await fetchGitBookContent();
    const docsContext = gitbookContent || getDocumentationContext().keyFacts.join('\n');

    // Include recent tweets context to help avoid repetition
    const recentContext = recentTweets.length > 0 
      ? `\n\nAVOID creating content similar to these recent tweets:\n${recentTweets.slice(0, 5).join('\n')}`
      : '';

    const prompt = `Based on this documentation about iAERO Protocol:
${docsContext}

Create a tweet about: ${topic}

Current stats: TVL ${stats.tvl}, APY ${stats.apy}%
${recentContext}

Requirements:
- Under 280 characters
- Factually accurate based on the docs
- Include 1-2 emojis
- Include 1-2 hashtags
- Must be original and different from recent tweets
- Vary the structure and style from previous posts`;

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 100,
        temperature: 0.85 + (attempt * 0.05) // Increase creativity on retries
      });
      
      const generatedTweet = resp.choices[0].message.content;
      
      // Check similarity
      const isSimilar = await isTwitterSimilar(generatedTweet, recentTweets, 0.4);
      
      // For important tweets, do additional OpenAI check
      const needsDeepCheck = !isSimilar && recentTweets.length > 5 && Math.random() < 0.5;
      const failsDeepCheck = needsDeepCheck && await checkWithOpenAI(generatedTweet, recentTweets.slice(0, 10));
      
      if (!isSimilar && !failsDeepCheck) {
        console.log(`Generated original tweet on attempt ${attempt + 1}`);
        return generatedTweet;
      }
      
      console.log(`Tweet too similar on attempt ${attempt + 1}, regenerating...`);
      
    } catch (error) {
      console.error('OpenAI error (protocol tweet):', error);
      break;
    }
  }
  
  // Fallback tweets (ensure these are diverse)
  const fallbacks = [
    `🚀 Lock AERO permanently, get 0.95 iAERO. Trade anytime while earning 80% of protocol fees. No unlock periods on Base. TVL: ${stats?.tvl || '0'}`,
    `💎 iAERO: Permanent lock, liquid token. Earn 80% protocol fees + LIQ rewards. Always tradeable. ${stats?.apy || '30'}% APY`,
    `📊 Why lock for 4 years? iAERO gives permanent lock + liquid tokens. Trade, earn, use as collateral. DeFi evolved.`,
    `⚡ Base network + liquid staking = iAERO. Skip the 4-year wait, stay liquid forever. TVL growing to ${stats?.tvl || '0'}`,
    `🔄 Your AERO working 24/7: Permanent lock ✓ Liquid iAERO ✓ 80% fee share ✓ No unlocking drama ✓`,
    `🌊 Liquidity matters. iAERO holders can exit anytime while earning max rewards. The future of ve(3,3) is here.`
  ];
  
  // Try to find a fallback that's not too similar
  for (const fallback of fallbacks.sort(() => Math.random() - 0.5)) {
    if (!await isTwitterSimilar(fallback, recentTweets, 0.5)) {
      console.log('Using fallback tweet after generation failed');
      return fallback;
    }
  }
  
  // Ultimate fallback: create a simple stats tweet that's always unique
  console.warn('All fallbacks too similar, generating basic stats tweet');
  const currentTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const randomEmoji = ['🚀', '💎', '🔥', '⚡', '🌊'][Math.floor(Math.random() * 5)];
  
  if (stats && stats.tvl !== '0') {
    return `${randomEmoji} iAERO Protocol Update at ${currentTime}: TVL ${stats.tvl} | APY ${stats.apy}% | Trade liquid while earning max rewards on Base. No 4-year locks needed.`;
  }
  
  // Absolutely last resort - skip this tweet
  console.error('Cannot generate unique tweet, returning null to skip');
  return null;
}

async function generateShitpost(maxAttempts = 3) {
  // Get recent tweets for comparison
  const recentTweets = await getRecentTweets();
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const topic = SHITPOST_TOPICS[Math.floor(Math.random() * SHITPOST_TOPICS.length)];

    // Include recent tweets context
    const recentContext = recentTweets.length > 0
      ? `\n\nAVOID repeating themes or jokes from these recent tweets:\n${recentTweets.slice(0, 5).join('\n')}`
      : '';

    const prompt = `Create a witty, crypto-native tweet about ${topic}.

Context about iAERO (use subtly if relevant):
- Permanent locks with liquid tokens
- No unlock periods unlike traditional ve(3,3)
- On Base network with low fees
- 80% protocol fee distribution
${recentContext}

Requirements:
- Be funny and relatable to crypto Twitter
- Use crypto slang naturally (gm, ser, anon, etc.)
- Subtly relate to liquid staking or iAERO if possible
- Keep under 280 characters
- Use emojis
- Max 1 hashtag
- Don't be overly promotional
- Must be original and different from recent tweets
- Avoid repeating jokes or meme formats`;

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 100,
        temperature: 0.9 + (attempt * 0.03) // Even more creative for shitposts
      });
      
      const generatedTweet = resp.choices[0].message.content;
      
      // Check similarity
      const isSimilar = await isTwitterSimilar(generatedTweet, recentTweets, 0.35); // Lower threshold for shitposts
      
      if (!isSimilar) {
        console.log(`Generated original shitpost on attempt ${attempt + 1}`);
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
    "Watching people check their 4-year lock countdown every day while iAERO holders are out here liquid and vibing 😎 Some choose prison, we choose freedom ser",
    "Gas fees so high on mainnet, even the whales are migrating to Base 🐋 Good thing iAERO lives where transactions don't cost your firstborn",
    "POV: You're explaining to your wife why your AERO is locked until 2028 while the iAERO chad next door is compounding daily 🗿",
    "gm to everyone except those still doing 4 year locks in 2025. Permanent lock + liquid token or ngmi, no in between 💀",
    "Imagine locking tokens and NOT being able to rage quit after a bad proposal passes. Couldn't be iAERO holders 🤝",
    "Wife changing wealth? More like wife changing locks. She asked why my tokens are free while yours are in jail until 2028 🔓",
    "Therapist: 'Liquid permanent locks aren't real, they can't hurt you'\niAERO: *exists*\nTraditional ve(3,3): 😰",
    "Breaking: Local man discovers one weird trick to avoid 4-year token lockups. ve(3,3) protocols hate him! 🚨",
    "The year is 2028. You finally unlock your tokens. iAERO holders have been compounding and trading for 3 years. Pain. 📅",
    "Normalize not waiting until your kids graduate college to access your locked tokens 🎓"
  ];
  
  // Try to find a diverse fallback
  for (const fallback of fallbacks.sort(() => Math.random() - 0.5)) {
    if (!await isTwitterSimilar(fallback, recentTweets, 0.4)) {
      console.log('Using fallback shitpost after generation failed');
      return fallback;
    }
  }
  
  // Ultimate fallback: create a time-based unique shitpost
  console.warn('All shitpost fallbacks too similar, generating time-based post');
  const hour = new Date().getHours();
  const timeBasedPosts = [
    `gm (it's ${hour > 12 ? hour - 12 : hour}${hour >= 12 ? 'pm' : 'am'} somewhere and my AERO is still liquid while yours is locked) 🌅`,
    `Hour ${hour}/24 of reminding you that permanent locks > 4 year jail sentences 🔓`,
    `Daily reminder #${Math.floor(Math.random() * 999)}: iAERO exists and you're still doing 4-year locks for some reason 🤔`,
    `Breaking at ${hour}:00 - Local DeFi user discovers tokens can be permanently locked AND liquid. More at never because it's iAERO 📰`
  ];
  
  const selected = timeBasedPosts[Math.floor(Math.random() * timeBasedPosts.length)];
  
  // Check if even this is too similar
  if (await isTwitterSimilar(selected, recentTweets, 0.3)) {
    console.error('Even time-based post too similar, skipping shitpost');
    return null;
  }
  
  return selected;
}

/* ---------------- Posting loop ---------------- */
async function postTweet() {
  try {
    const isProtocolTweet = Math.random() < 0.75;
    let tweetContent = isProtocolTweet ? await generateProtocolTweet() : await generateShitpost();

    // Skip if no content generated (e.g., due to bad stats)
    if (!tweetContent) {
      console.log('No tweet content generated, skipping...');
      return;
    }

    console.log(`[${new Date().toISOString()}] Posting tweet:`, tweetContent);

    if (tweetContent.length > 280) {
      console.warn('Tweet too long, truncating…');
      tweetContent = tweetContent.slice(0, 277) + '...';
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
  console.log('Environment:', {
    platform: process.env.RAILWAY_ENVIRONMENT || 'local',
    node: process.version,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`
  });
  console.log('Configuration:', {
    hasTwitterCreds: !!process.env.TWITTER_API_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    vaultAddress: process.env.VAULT_ADDRESS || '0x877398Aea8B5cCB0D482705c2D88dF768c953957',
    rpcUrl: process.env.RPC_URL ? 'custom' : 'default Base RPC'
  });

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
    if (recentTweetsCache.tweets.length === 0) {
      console.log('Waiting 30s before first tweet due to rate limit...');
      await new Promise(r => setTimeout(r, 30000));
    }
    await postTweet();
  } else {
    console.log('Skipping initial tweet due to invalid stats');
  }

  // Schedule recurring tweets
  scheduleNextTweet();

  // Daily stats at 14:00 UTC
  cron.schedule('0 14 * * *', async () => {
    console.log('Posting daily stats tweet…');
    const stats = await getProtocolStats(true); // force refresh for daily stats
    if (stats && stats.tvl !== '0') {
      const statsTweet =
`📊 iAERO Daily Stats
💰 TVL: ${stats.tvl}
📈 APY: ${stats.apy}%
🔒 AERO Locked: ${stats.aeroLocked}
💎 iAERO Minted: ${stats.totalStaked}
🪙 LIQ Minted: ${stats.liqMinted}

Prices:
- AERO: ${stats.aeroPrice}
- LIQ: ${stats.liqPrice}
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

  // Refresh stats cache every 5 minutes
  setInterval(async () => {
    console.log('Refreshing stats cache...');
    try {
      await getProtocolStats(true);
    } catch (error) {
      console.error('Stats refresh failed:', error?.message);
    }
  }, 5 * 60 * 1000);
  
  // Memory monitoring for Railway (every 30 minutes)
  setInterval(() => {
    const usage = process.memoryUsage();
    console.log('Memory usage:', {
      rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
      heap: `${Math.round(usage.heapUsed / 1024 / 1024)}MB / ${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
      external: `${Math.round(usage.external / 1024 / 1024)}MB`
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

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully…');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully…');
  process.exit(0);
});

startBot().catch(err => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
