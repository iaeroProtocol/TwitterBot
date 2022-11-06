// twitter-bot.mjs — Production version with GPT-5 wrapper, hash dedupe, and robustness
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

// ---------- ESM paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- Health check (Railway) ----------
const app  = express();
const PORT = process.env.PORT || 3001;

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});
app.listen(PORT, () => console.log(`Health check server on :${PORT}`));

// ---------- Clients ----------
const twitterClient = new TwitterApi({
  appKey:       process.env.TWITTER_API_KEY,
  appSecret:    process.env.TWITTER_API_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEBUG_STATS        = process.env.DEBUG_STATS === '1';
const OPENAI_ENABLED     = !!process.env.OPENAI_API_KEY;
const OPENAI_MODEL       = process.env.OPENAI_MODEL || 'gpt-5-mini';
const isGpt5Family       = OPENAI_MODEL.startsWith('gpt-5');
const STRICT_ORIGINALITY = OPENAI_ENABLED && process.env.STRICT_ORIGINALITY === '1';

// ---------- OpenAI (GPT-5 safe) wrapper ----------
/**
 * chatOnce:
 *  - For GPT-5: uses max_completion_tokens; disallows temperature/penalties.
 *  - For legacy models (if ever used): can accept legacyTuning.
 */
async function chatOnce({ prompt, max = 500, legacyTuning }) {
  const base = { model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }] };
  if (isGpt5Family) {
    return openai.chat.completions.create({ ...base, max_completion_tokens: max });
  }
  const { temperature = 0.9, presence_penalty = 0.6, frequency_penalty = 0.6 } = legacyTuning || {};
  return openai.chat.completions.create({
    ...base,
    max_tokens: max,
    temperature,
    presence_penalty,
    frequency_penalty
  });
}

// ---------- Chain provider ----------
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org');

// ---------- Stats cache ----------
let statsCache = { data: null, timestamp: 0, ttl: 5 * 60 * 1000 };

// ---------- Hash-based dedupe ----------
const HASH_FILE = path.join(__dirname, 'tweet-hashes.json');
let postedHashes = new Set();

async function loadHashes() {
  try {
    const data = await fs.readFile(HASH_FILE, 'utf8');
    postedHashes = new Set(JSON.parse(data));
    console.log(`Loaded ${postedHashes.size} hash(es)`);
  } catch {
    console.log('No existing hash file; starting fresh');
    postedHashes = new Set();
  }
}
async function saveHashes() {
  try {
    const toSave = [...postedHashes].slice(-500);
    await fs.writeFile(HASH_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save hashes:', err?.message || err);
  }
}
function hashTweet(content) {
  const normalized = (content || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ---------- Topic cooldowns ----------
const topicCooldowns = new Map();
const TOPIC_COOLDOWN_DAYS = 2;

function isTopicOnCooldown(topic) {
  const t = topicCooldowns.get(topic);
  if (!t) return false;
  return ((Date.now() - t) / (1000 * 60 * 60 * 24)) < TOPIC_COOLDOWN_DAYS;
}
function markTopicUsed(topic) {
  topicCooldowns.set(topic, Date.now());
}

// ---------- Topics ----------
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
  "Market volatility","DeFi yields","Airdrop farming","Gas fees","Crypto Twitter drama",
  "Bull/bear market memes","Liquidity mining","Protocol wars on Base",
  "Whale movements","CEX vs DEX debate"
];

// ---------- Minimal ABIs ----------
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

// ---------- Helpers ----------
function compactUSDorToken(n) {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return n.toFixed(0);
}
function safeTrimTweet(tweet, maxLength = 280) {
  const chars = [...(tweet || '')];
  if (chars.length <= maxLength) return tweet || '';
  return chars.slice(0, maxLength - 1).join('') + '…';
}

async function readPair(pairAddr) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const token1 = (await pair.token1()).toLowerCase();
  const [reserve0, reserve1] = await pair.getReserves();
  return { token0, token1, reserve0, reserve1 };
}
async function resolveCoreTokens(cfg) {
  const usdc = cfg.USDC.toLowerCase();
  const aeroPair = await readPair(cfg.AERO_USDC_POOL);
  const AERO = (aeroPair.token0 === usdc) ? aeroPair.token1 : aeroPair.token0;
  const liqPair = await readPair(cfg.LIQ_USDC_POOL);
  const LIQ  = (liqPair.token0 === usdc)  ? liqPair.token1  : liqPair.token0;
  const iaeroPair = await readPair(cfg.IAERO_AERO_POOL);
  const IAERO = (iaeroPair.token0 === AERO) ? iaeroPair.token1 : iaeroPair.token0;

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
  await putDecimals(AERO); await putDecimals(LIQ);
  await putDecimals(IAERO); await putDecimals(usdc);

  return { tokens: { AERO, LIQ, IAERO, USDC: usdc }, decimals: decMap };
}
async function pairPrice(pairAddr, baseAddr, quoteAddr, decMap) {
  const info   = await readPair(pairAddr);
  const base   = baseAddr.toLowerCase();
  const quote  = quoteAddr.toLowerCase();
  if (base !== info.token0 && base !== info.token1)  throw new Error('base not in pair');
  if (quote !== info.token0 && quote !== info.token1) throw new Error('quote not in pair');

  const baseReserve  = (base === info.token0)  ? info.reserve0 : info.reserve1;
  const quoteReserve = (quote === info.token0) ? info.reserve0 : info.reserve1;
  const baseDec  = decMap.get(base)  ?? 18;
  const quoteDec = decMap.get(quote) ?? 18;

  const baseFloat  = parseFloat(ethers.formatUnits(baseReserve, baseDec));
  const quoteFloat = parseFloat(ethers.formatUnits(quoteReserve, quoteDec));
  if (baseFloat === 0) throw new Error('zero base reserve');
  return quoteFloat / baseFloat;
}

// ---------- Docs context ----------
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
      stakingLockPeriod: "7 days (LIQ unstaking)",
      conversionRatio: "0.95 iAERO per 1 AERO"
    }
  };
}

// ---------- GitBook cache ----------
let gitBookCache = null;
async function fetchGitBookContent() {
  if (gitBookCache) return gitBookCache;
  const baseUrl = 'https://docs.iaero.finance';
  const pages   = [
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
      const r = await fetch(`${baseUrl}${page}`);
      if (!r.ok) continue;
      const html = await r.text();
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
      if (text) texts.push(text);
    }
    gitBookCache = texts.join('\n\n');
    return gitBookCache;
  } catch (err) {
    console.error('Failed to fetch GitBook:', err?.message || err);
    return null;
  }
}

// ---------- On-chain stats with caching ----------
async function getProtocolStats(forceRefresh = false) {
  if (!forceRefresh && statsCache.data && (Date.now() - statsCache.timestamp) < statsCache.ttl) {
    console.log('Returning cached stats');
    return statsCache.data;
  }

  console.log('Fetching fresh protocol stats...');
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

  const retryCall = async (fn, fallback = 0, maxRetries = 5) => {
    for (let i = 0; i < maxRetries; i++) {
      try { return await fn(); }
      catch (e) {
        if (i < maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, i), 5000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    return fallback;
  };

  let aeroLockedNum = await retryCall(async () => parseFloat(ethers.formatEther(await vault.totalAEROLocked())));
  if (!aeroLockedNum) {
    aeroLockedNum = await retryCall(async () => parseFloat(ethers.formatEther(await vault.getTotalValueLocked())));
  }
  if (!aeroLockedNum) {
    aeroLockedNum = await retryCall(async () => {
      const vs = await vault.vaultStatus();
      return parseFloat(ethers.formatEther(vs[0]));
    });
  }
  console.log('✓ AERO locked:', aeroLockedNum);

  const liqMintedNum  = await retryCall(async () => parseFloat(ethers.formatEther(await vault.totalLIQMinted())));
  const iAeroMintedNum= await retryCall(async () => parseFloat(ethers.formatEther(await vault.totalIAEROMinted())));
  console.log('✓ LIQ minted:',  liqMintedNum);
  console.log('✓ iAERO minted:',iAeroMintedNum);

  let aeroPrice = NaN, liqPrice = NaN, iaeroPeg = NaN;
  try {
    const { tokens, decimals } = await resolveCoreTokens({
      AERO_USDC_POOL, LIQ_USDC_POOL, IAERO_AERO_POOL, USDC: USDC_ADDRESS
    });
    aeroPrice = await retryCall(async () => await pairPrice(AERO_USDC_POOL, tokens.AERO,  tokens.USDC, decimals), 0);
    liqPrice  = await retryCall(async () => await pairPrice(LIQ_USDC_POOL,  tokens.LIQ,   tokens.USDC, decimals), 0);
    iaeroPeg  = await retryCall(async () => await pairPrice(IAERO_AERO_POOL,tokens.IAERO, tokens.AERO, decimals), 1);
    console.log('✓ AERO price:', aeroPrice);
    console.log('✓ LIQ price:',  liqPrice);
    console.log('✓ iAERO peg:',  iaeroPeg);
  } catch (e) {
    console.error('Price fetching failed:', e?.message || e);
  }

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

  statsCache = { data: stats, timestamp: Date.now(), ttl: statsCache.ttl };
  return stats;
}

// ---------- Recent tweets cache ----------
let recentTweetsCache = { tweets: [], timestamp: 0, ttl: 30 * 60 * 1000 };

async function getRecentTweets(count = 20) {
  if (recentTweetsCache.tweets?.length > 0 &&
      (Date.now() - recentTweetsCache.timestamp) < recentTweetsCache.ttl) {
    console.log('Using cached recent tweets');
    return recentTweetsCache.tweets;
  }
  try {
    console.log(`Fetching last ${count} tweets...`);
    let userId = process.env.TWITTER_USER_ID;
    if (!userId) {
      try {
        const me = await twitterClient.v2.me();
        userId = me.data.id;
        console.log('Got Twitter user ID:', userId);
      } catch (meError) {
        console.error('Failed to get user ID:', meError?.message || meError);
        if (meError?.code === 429 || meError?.status === 429) {
          console.log('Rate limited on getting user ID, will retry later');
          return recentTweetsCache.tweets || [];
        }
        return recentTweetsCache.tweets || [];
      }
    }
    const timeline = await twitterClient.v2.userTimeline(userId, {
      max_results: Math.min(count, 100),
      exclude: ['retweets', 'replies'],
      'tweet.fields': ['created_at', 'text']
    });
    const tweetObjs = timeline?.data?.data ?? timeline?.data ?? [];
    const tweetTexts = [];
    for (const t of tweetObjs) {
      const text = t?.text;
      if (!text) continue;
      const clean = text.replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').replace(/#/g, '').trim();
      if (clean.length > 10) tweetTexts.push(clean);
    }
    if (tweetTexts.length > 0) {
      recentTweetsCache = { tweets: tweetTexts, timestamp: Date.now(), ttl: recentTweetsCache.ttl };
      console.log(`Retrieved ${tweetTexts.length} recent tweets`);
    } else {
      console.log('No tweets retrieved, using previous cache if available');
    }
    return tweetTexts.length > 0 ? tweetTexts : (recentTweetsCache.tweets || []);
  } catch (error) {
    console.error('Failed to fetch recent tweets:', error?.message || error);
    if (error?.code === 429 || error?.status === 429) {
      console.log('Rate limited by Twitter API, using cached tweets');
      recentTweetsCache.timestamp = Date.now();
      recentTweetsCache.ttl       = 45 * 60 * 1000; // silence retries for a while
    }
    return recentTweetsCache.tweets || [];
  }
}

// ---------- Similarity checks ----------
function detectStructuralSimilarity(text1, text2) {
  const patterns = [
    /with a tvl of.*?and.*?apy of/i,
    /don't (let|miss) this opportunity/i,
    /join.*?today!/i,
    /dive into.*?with.*?tvl/i,
    /enhance your.*?today/i,
    /ready to.*?\?.*?with.*?tvl/i
  ];
  let match = 0;
  for (const p of patterns) {
    if (p.test(text1) && p.test(text2)) match++;
  }
  return match >= 2;
}
async function isTwitterSimilar(newTweet, recentTweets, threshold = 0.35) {
  const cleanNew = (newTweet || '').replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').replace(/#/g, '').trim().toLowerCase();
  for (const recent of recentTweets || []) {
    if (!recent) continue;
    const cleanOld = recent.toLowerCase();
    if (detectStructuralSimilarity(cleanNew, cleanOld)) {
      console.log('Tweet has similar structure to recent tweet'); return true;
    }
    const words1 = new Set(cleanNew.match(/\b\w+\b/g) || []);
    const words2 = new Set(cleanOld.match(/\b\w+\b/g) || []);
    if (words1.size < 3 || words2.size < 3) continue;
    const inter = new Set([...words1].filter(x => words2.has(x)));
    const uni   = new Set([...words1, ...words2]);
    const sim   = inter.size / uni.size;
    if (sim > threshold) {
      console.log(`Tweet too similar (${(sim * 100).toFixed(1)}% word match)`); return true;
    }
  }
  return false;
}

// Optional deep check (GPT-5 ok via wrapper)
async function checkWithOpenAI(newTweet, recentTweets) {
  if (!STRICT_ORIGINALITY || !OPENAI_ENABLED) return false;
  const prompt = `Analyze if this new tweet is too similar to recent tweets.

New tweet:
"${newTweet}"

Recent tweets:
${(recentTweets || []).map((t,i)=>`${i+1}. "${t}"`).join('\n')}

Check for:
1. Same structure (statement + stats + call-to-action)
2. Repeated phrases like "with a TVL of" or "APY of 30%"
3. Similar opening/closing phrases
4. Same style of presenting statistics
5. Identical sentiment or energy
6. Formulaic patterns
7. Generic marketing language

Respond only "YES" if too similar/formulaic, or "NO" if sufficiently different.`;
  try {
    const resp = await chatOnce({ prompt, max: 10 });
    const content = resp?.choices?.[0]?.message?.content ?? '';
    const verdict = content.trim().toUpperCase();
    return verdict.includes('YES');
  } catch (e) {
    console.error('OpenAI similarity check failed:', e?.message || e);
    return false;
  }
}

// ---------- Builders ----------
async function generateProtocolTweet(maxAttempts = 5) {
  const recentTweets = await getRecentTweets();
  const triedStyles  = new Set();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const stats = await getProtocolStats();
    if (!stats || stats.tvl === '0') { console.warn('Invalid stats; skip'); return null; }

    const availableTopics = PROTOCOL_TOPICS.filter(t => !isTopicOnCooldown(t));
    const topicsPool = availableTopics.length ? availableTopics : PROTOCOL_TOPICS;
    const topic = topicsPool[Math.floor(Math.random()*topicsPool.length)];
    markTopicUsed(topic);

    const styles = [
      'educational','comparison','question','announcement','thread_starter',
      'stat_highlight','feature_focus','user_story','myth_buster','tip','observation','analogy'
    ].filter(s => !triedStyles.has(s));
    const style = (styles.length ? styles : ['educational'])[Math.floor(Math.random()*Math.max(styles.length,1))];
    triedStyles.add(style);

    const includeStats = Math.random() < 0.3;
    const docsContent  = await fetchGitBookContent();
    const docsContext  = docsContent || getDocumentationContext().keyFacts.join('\n');

    const statsContext = includeStats
      ? `\nCurrent stats (weave naturally, never as "with TVL of X and APY of Y"):
TVL ${stats.tvl}, APY ${stats.apy}%, AERO locked ${stats.aeroLocked}, iAERO/AERO ${stats.iAeroPeg}`
      : '\nDo not include specific stats in this tweet.';

    const recentContext = (recentTweets?.length || 0) > 0
      ? `\n\nRecent tweets to avoid copying in structure/tone:\n${recentTweets.slice(0, 8).join('\n---\n')}`
      : '';

    const styleGuides = {
      educational: 'Teach something specific. Start with "Did you know" or "TIL".',
      comparison: 'Compare iAERO to traditional locking without stats. Focus on UX.',
      question: 'Ask an engaging question. No CTA.',
      announcement: 'Sound like news/update. Active voice.',
      thread_starter: 'Write like a thread starter. End with "A thread 🧵" or "Let me explain 👇".',
      stat_highlight: 'Lead with ONE impressive number; tell a story around it.',
      feature_focus: 'Deep dive on ONE feature. Technical but accessible.',
      user_story: 'Write from a user POV. Make it specific.',
      myth_buster: 'Myth vs Reality; be direct.',
      tip: 'One actionable tip. Start with "Pro tip:"',
      observation: 'Thoughtful observation about DeFi/protocol.',
      analogy: 'Creative analogy that makes it memorable.'
    };

    const prompt = `Based on iAERO docs:
${docsContext}

Create a ${style} style tweet about: ${topic}

Style guide: ${styleGuides[style] || 'Be creative and original.'}
${statsContext}
${recentContext}

CRITICAL:
- Under 280 chars
- MUST differ in structure/tone from above recents
- FORBIDDEN: "with a TVL of", "and APY of", "don't miss this opportunity", "join us today", "dive into", "enhance your", "ready to"
- Avoid [generic statement] + [stats] + [CTA]
- If stats included, weave naturally; do not list
- Max 1 hashtag; vary it
- Be specific, not generic marketing
- Sound human; have an opinion`;

    try {
      const resp = await chatOnce({ prompt, max: 500 });
      const raw  = resp?.choices?.[0]?.message?.content ?? '';
      const generated = raw.trim();
      if (!generated) { console.warn('Empty OpenAI content; retrying…'); continue; }

      const tweetHash = hashTweet(generated);
      if (postedHashes.has(tweetHash)) { console.log(`Hash exists (attempt ${attempt+1}); regenerating…`); continue; }

      const isSimilar = await isTwitterSimilar(generated, recentTweets, 0.35);
      const failsDeep = STRICT_ORIGINALITY && !isSimilar && await checkWithOpenAI(generated, recentTweets.slice(0,10));

      if (!isSimilar && !failsDeep) {
        console.log(`Generated ${style} tweet on attempt ${attempt + 1}`);
        return generated;
      }
      console.log(`Too similar (${style}, attempt ${attempt+1}); retrying…`);
    } catch (error) {
      console.error('OpenAI error (protocol tweet):', error?.message || error);
      break;
    }
  }

  // Fallbacks
  const fallbacks = [
    `Did you know? Every iAERO holder owns a piece of permanently locked veAERO. The lock never expires, but your tokens stay liquid. Best of both worlds.`,
    `Thread: Why permanent locks beat 4-year locks 🧵\n\n1) No re-lock cycles\n2) Tokens stay liquid\n3) Same voting power\n4) Exit anytime\n\nThat’s iAERO.`,
    `Fun fact: iAERO stakers earn fees while 4-year lockers wait for unlocks. Time in market > timing market.`,
    `0.95 iAERO per AERO locked. That 5% funds the liquid wrapper you can exit anytime. Fair trade.`,
    `Question for lockers: What if you need liquidity before 2028?\n\niAERO: “We can sell anytime.”`,
    `Myth: You must lock for max rewards.\nReality: iAERO earns the same with zero unlock date.`
  ];
  for (const fb of fallbacks.sort(() => Math.random() - 0.5)) {
    const h = hashTweet(fb);
    if (!postedHashes.has(h) && !(await isTwitterSimilar(fb, recentTweets, 0.3))) {
      console.log('Using creative fallback tweet'); return fb;
    }
  }
  console.error('Could not generate unique tweet');
  return null;
}

async function generateShitpost(maxAttempts = 4) {
  const recentTweets = await getRecentTweets();
  const styles = ['meme_format','crypto_slang_heavy','fake_news_headline','hot_take','relatable_pain','chad_vs_virgin','year_2028_joke','wife_changing_money'];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const topic = SHITPOST_TOPICS[Math.floor(Math.random() * SHITPOST_TOPICS.length)];
    const style = styles[Math.floor(Math.random() * styles.length)];

    const recentContext = (recentTweets?.length || 0) > 0
      ? `\n\nAvoid repeating themes/jokes from these:\n${recentTweets.slice(0, 5).join('\n')}` : '';

    const prompt = `Create a witty, crypto-native tweet about ${topic}.

Style: ${style}

Context (use subtly if relevant):
- Permanent locks with liquid tokens
- No 4-year unlock waiting
- Base network, low fees
- 80% fee distribution to stakers
${recentContext}

Requirements:
- Under 280 chars
- Funny/relatable crypto slang (gm, ser, anon, ngmi, wagmi)
- Subtle iAERO tie-in if relevant
- Max 1 hashtag
- Must be original and different from recent tweets
- Avoid generic promo`;

    try {
      const resp = await chatOnce({ prompt, max: 500 });
      const raw  = resp?.choices?.[0]?.message?.content ?? '';
      const generated = raw.trim();
      if (!generated) { console.warn('Empty OpenAI content; retrying…'); continue; }

      const tweetHash = hashTweet(generated);
      if (postedHashes.has(tweetHash)) { console.log(`Shitpost hash exists (attempt ${attempt+1}); regenerating…`); continue; }

      const isSimilar = await isTwitterSimilar(generated, recentTweets, 0.30);
      if (!isSimilar) {
        console.log(`Generated original shitpost (${style}) on attempt ${attempt+1}`);
        return generated;
      }
      console.log(`Shitpost too similar (attempt ${attempt+1}); regenerating…`);
    } catch (error) {
      console.error('OpenAI error (shitpost):', error?.message || error);
      break;
    }
  }

  // Diverse fallback shitposts
  const fallbacks = [
    "Nobody:\nAbsolutely nobody:\nMe checking if my 4-year lock has expired yet: 🤡\n\n(this post made by iAERO gang)",
    "Breaking: Area man discovers one weird trick to avoid 4-year lockups. ve(3,3) protocols hate him! 🗞️",
    "gm to everyone except those still doing 4 year locks in 2025. Permanent lock + liquid token or ngmi 💀",
    "Wife: why are his tokens free and yours locked till 2028?\nMe: there's this escrow—\nWife: *leaves with iAERO chad*",
    "Year 2028: tokens unlock. iAERO holders: already traded, earned, collateralized. 📅",
    "Therapist: Liquid permanent locks aren’t real.\niAERO: *exists*\nTraditional ve(3,3): 😰"
  ];
  for (const fb of fallbacks.sort(() => Math.random() - 0.5)) {
    const h = hashTweet(fb);
    if (!postedHashes.has(h) && !(await isTwitterSimilar(fb, recentTweets, 0.35))) {
      console.log('Using fallback shitpost'); return fb;
    }
  }
  console.error('Could not generate unique shitpost; skipping');
  return null;
}

// ---------- Posting loop ----------
async function postTweet(retries = 2) {
  let lastError = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const isProtocolTweet = Math.random() < 0.7;
      let content = isProtocolTweet ? await generateProtocolTweet() : await generateShitpost();

      if (!content) { console.log('No tweet content generated; skip this cycle'); return null; }

      const tweetHash = hashTweet(content);
      if (postedHashes.has(tweetHash)) { console.log('Hash collision pre-post; regenerating…'); continue; }

      content = safeTrimTweet(content, 280);
      console.log(`[${new Date().toISOString()}] Posting tweet:`, content);

      const tweet = await twitterClient.v2.tweet(content);
      console.log('Tweet posted successfully:', tweet?.data?.id);
      postedHashes.add(tweetHash);
      await saveHashes();
      return tweet;
    } catch (error) {
      lastError = error;
      console.error(`Failed to post tweet (attempt ${i + 1}/${retries + 1}):`, error?.message || error);
      if (error?.code === 429) { console.log('Rate limited; will retry later'); break; }
      if (i < retries) {
        const wait = Math.min(1000 * Math.pow(2, i), 10000);
        console.log(`Waiting ${wait}ms before retry…`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  console.error('All post attempts failed:', lastError?.message || lastError);
  return null;
}

function getRandomIntervalMinutes() {
  return Math.floor(Math.random() * (360 - 240 + 1) + 240); // 4–6 hours
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

// ---------- Bootstrap ----------
async function startBot() {
  console.log('🤖 iAERO Twitter Bot starting (Production Version)…');
  console.log('Environment:', {
    platform: process.env.RAILWAY_ENVIRONMENT || 'local',
    node:     process.version,
    memory:   `${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB / ${Math.round(process.memoryUsage().heapTotal/1024/1024)}MB`,
    strictOriginality: STRICT_ORIGINALITY ? 'enabled' : 'disabled'
  });
  console.log('Config:', {
    hasTwitterCreds: !!process.env.TWITTER_API_KEY,
    hasOpenAI:       OPENAI_ENABLED,
    model:           OPENAI_MODEL,
    vaultAddress:    process.env.VAULT_ADDRESS || '0x877398Aea8B5cCB0D482705c2D88dF768c953957',
    rpcUrl:          process.env.RPC_URL ? 'custom' : 'default Base RPC'
  });

  await loadHashes();

  console.log('Initializing stats cache…');
  const testStats = await getProtocolStats(true);
  console.log('Initial stats:', testStats);

  await fetchGitBookContent();

  try {
    console.log('Loading recent tweet history…');
    await getRecentTweets();
  } catch (e) {
    console.error('Could not load tweet history on startup:', e?.message || e);
  }

  if (testStats && testStats.tvl !== '0') {
    if (!recentTweetsCache.tweets || recentTweetsCache.tweets.length === 0) {
      const jitter = 5 + Math.floor(Math.random()*10); // 5–15 min
      console.log(`Rate limited or empty cache; waiting ${jitter} minutes before first tweet…`);
      await new Promise(r => setTimeout(r, jitter * 60 * 1000));
      try { await getRecentTweets(); } catch {}
    }
    await postTweet();
  } else {
    console.log('Skipping initial tweet due to invalid stats');
  }

  console.log('Registering recurring tweet scheduler…');
  scheduleNextTweet();
  console.log('Scheduler registered.');

  // Daily stats at 14:00 UTC
  cron.schedule('0 14 * * *', async () => {
    console.log('Posting daily stats tweet…');
    const stats = await getProtocolStats(true);
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
      statsTweet = safeTrimTweet(statsTweet, 280);
      try {
        const tw = await twitterClient.v2.tweet(statsTweet);
        console.log('Daily stats tweet posted:', tw?.data?.id);
        postedHashes.add(hashTweet(statsTweet));
        await saveHashes();
      } catch (err) {
        console.error('Failed to post daily stats:', err?.message || err);
      }
    }
  });

  // Stats refresh
  setInterval(async () => {
    console.log('Refreshing stats cache…');
    try { await getProtocolStats(true); } catch (e) { console.error('Stats refresh failed:', e?.message || e); }
  }, 5 * 60 * 1000);

  // Hash save + memory
  setInterval(async () => {
    await saveHashes();
    const usage = process.memoryUsage();
    console.log('Memory usage:', {
      rss: `${Math.round(usage.rss/1024/1024)}MB`,
      heap: `${Math.round(usage.heapUsed/1024/1024)}MB / ${Math.round(usage.heapTotal/1024/1024)}MB`,
      external: `${Math.round(usage.external/1024/1024)}MB`,
      hashCount: postedHashes.size,
      topicCooldowns: topicCooldowns.size
    });
  }, 30 * 60 * 1000);
}

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', async err => {
  console.error('Uncaught exception:', err);
  await saveHashes();
  process.exit(1);
});
process.on('SIGTERM', async () => {
  console.log('SIGTERM: saving state, shutting down gracefully…');
  await saveHashes();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('SIGINT: saving state, shutting down gracefully…');
  await saveHashes();
  process.exit(0);
});

startBot().catch(async err => {
  console.error('Failed to start bot:', err);
  await saveHashes();
  process.exit(1);
});

