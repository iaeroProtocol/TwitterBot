// twitter-bot.mjs — Production: persistent dedupe, rate-limit safe, GPT-5 Responses API, no manual fallbacks
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

/* ============================== ESM paths =============================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ============================== Healthcheck ============================= */
const app  = express();
const PORT = process.env.PORT || 8080;
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));
app.listen(PORT, () => console.log(`Health check server on :${PORT}`));

/* ============================== Clients ================================= */
const twitterClient = new TwitterApi({
  appKey:       process.env.TWITTER_API_KEY,
  appSecret:    process.env.TWITTER_API_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TWEETS_ENABLED = process.env.TWEETS_ENABLED !== '0';
const OPENAI_ENABLED     = !!process.env.OPENAI_API_KEY;
const OPENAI_MODEL       = process.env.OPENAI_MODEL || 'gpt-5-mini';
const STRICT_ORIGINALITY = OPENAI_ENABLED && process.env.STRICT_ORIGINALITY === '1';
const DEBUG_STATS        = process.env.DEBUG_STATS === '1';

/* ============================== OpenAI (Responses API) ================== */
// Robust extractor for the Responses API
function extractResponsesText(resp) {
  if (typeof resp?.output_text === 'string' && resp.output_text.trim().length) {
    return resp.output_text;
  }
  const out = [];
  const outputs = resp?.output ?? [];
  for (const item of outputs) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === 'output_text' && typeof c?.text === 'string') {
        out.push(c.text);
      }
    }
  }
  return out.join('').trim();
}

// Unified helper: Responses API (recommended for GPT-5). Falls back to Chat Completions only if Responses fails.
async function chatOnce({ prompt, max = 500, instructions, messages, reasoningEffort = 'low' }) {
  const model = OPENAI_MODEL;

  // Use Responses API (preferred)
  try {
    const payload = {
      model,
      reasoning: { effort: reasoningEffort },          // harmless for non-reasoning models too
      ...(instructions ? { instructions } : {}),
      ...(messages ? { input: messages } : { input: prompt }),
      max_output_tokens: max                           // Responses API token cap
    };
    const resp = await openai.responses.create(payload);
    return { _raw: resp, text: extractResponsesText(resp) };
  } catch (e) {
    // Optional compatibility fallback for non-GPT-5 models if configured
    try {
      const resp = await openai.chat.completions.create({
        model,
        messages: messages || [{ role: 'user', content: prompt }],
        max_completion_tokens: max
      });
      const txt = resp?.choices?.[0]?.message?.content;
      return { _raw: resp, text: (typeof txt === 'string' ? txt : Array.isArray(txt) ? txt.join('') : '') || '' };
    } catch (e2) {
      throw e;
    }
  }
}

/* ============================== Chain provider ========================== */
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org');

/* ============================== Stats cache ============================= */
let statsCache = { data: null, timestamp: 0, ttl: 5 * 60 * 1000 };

/* ============================== Data dir & persistence ================== */
let DATA_DIR = null;
let HASH_FILE = null;
let TWEET_LOG_FILE = null;

async function initDataFiles() {
  const candidates = [
    process.env.DATA_DIR,
    '/data', '/var/data', '/mnt/data',
    path.join(__dirname, 'data')
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const t = path.join(dir, '.rwtest');
      await fs.writeFile(t, 'ok'); await fs.unlink(t);
      DATA_DIR = dir; break;
    } catch {}
  }
  if (!DATA_DIR) DATA_DIR = path.join(__dirname, 'data');
  await fs.mkdir(DATA_DIR, { recursive: true });

  HASH_FILE = path.join(DATA_DIR, 'tweet-hashes.json');
  TWEET_LOG_FILE = path.join(DATA_DIR, 'tweet-log.json');
  console.log('Data directory set to:', DATA_DIR);
}

/* ============================== Hash dedupe ============================= */
let postedHashes = new Set();

function hashTweet(content) {
  const normalized = (content || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
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
  } catch (e) {
    console.error('Failed to save hashes:', e?.message || e);
  }
}

/* ============================== Local tweet log ========================= */
let tweetLog = [];

async function loadTweetLog() {
  try {
    const data = await fs.readFile(TWEET_LOG_FILE, 'utf8');
    const arr = JSON.parse(data);
    tweetLog = Array.isArray(arr) ? arr.filter(t => typeof t === 'string') : [];
    console.log(`Loaded tweet log with ${tweetLog.length} entries`);
  } catch {
    console.log('No existing tweet log; starting fresh');
    tweetLog = [];
  }
}
async function saveTweetLog() {
  try {
    const last500 = tweetLog.slice(-500);
    await fs.writeFile(TWEET_LOG_FILE, JSON.stringify(last500, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save tweet log:', e?.message || e);
  }
}

// ---------- Similarity helpers (history-wide) ----------
function normalizeForSim(s) {
  return (s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')  // strip urls
    .replace(/@\w+/g, '')            // strip mentions
    .replace(/#(\w+)/g, '$1')        // drop #
    .replace(/\d+(\.\d+)?/g, '0')    // neuter numbers so 811K vs 823K don't evade
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // drop emoji/punct (keep letters/numbers)
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return normalizeForSim(s).split(' ').filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni   = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

function bigrams(arr) {
  const out = [];
  for (let i = 0; i < arr.length - 1; i++) out.push(arr[i] + ' ' + arr[i+1]);
  return out;
}

// Tiny SimHash over unigrams+bigrams
function simhash(s) {
  const t = tokens(s);
  const feats = [...t, ...bigrams(t)];
  const bits = 32; // lightweight; enough for near-dup catch
  const v = new Array(bits).fill(0);
  for (const f of feats) {
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < f.length; i++) {
      h ^= f.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    for (let b = 0; b < bits; b++) {
      v[b] += (h & (1 << b)) ? 1 : -1;
    }
  }
  let out = 0;
  for (let b = 0; b < bits; b++) if (v[b] > 0) out |= (1 << b);
  return out >>> 0;
}
function hamming32(a, b) {
  let x = a ^ b, c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

// History-wide check: last N posts from local tweetLog
function tooSimilarToHistory(newText, { maxLookback = 120, wordThresh = 0.82, bigramThresh = 0.72, simhashHD = 6 } = {}) {
  const history = tweetLog.slice(-maxLookback);
  if (history.length === 0) return false;

  const newTok  = tokens(newText);
  const newBi   = bigrams(newTok);
  const newHash = simhash(newText);

  for (const oldText of history) {
    const oldTok = tokens(oldText);
    const oldBi  = bigrams(oldTok);

    const j1 = jaccard(newTok, oldTok);
    if (j1 >= wordThresh) return true;

    const j2 = jaccard(newBi, oldBi);
    if (j2 >= bigramThresh) return true;

    const hd = hamming32(newHash, simhash(oldText));
    if (hd <= simhashHD) return true;
  }
  return false;
}


/* ============================== Topics & helpers ======================== */
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

const topicCooldowns = new Map();
const TOPIC_COOLDOWN_DAYS = 2;
function isTopicOnCooldown(topic){ const t = topicCooldowns.get(topic); return t ? ((Date.now()-t)/(1000*60*60*24)) < TOPIC_COOLDOWN_DAYS : false; }
function markTopicUsed(topic){ topicCooldowns.set(topic, Date.now()); }

function compactUSDorToken(n){ if(!isFinite(n)||n<=0) return '0'; if(n>=1_000_000) return (n/1_000_000).toFixed(2)+'M'; if(n>=1_000) return (n/1_000).toFixed(0)+'K'; return n.toFixed(0); }
function safeTrimTweet(t, max=500){ const s=[...(t||'')]; return s.length<=max ? (t||'') : s.slice(0,max-1).join('')+'…'; }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

/* ============================== On-chain stats ========================== */
async function readPair(pairAddr) {
  const PAIR_ABI = [
    'function getReserves() view returns (uint256,uint256,uint256)',
    'function token0() view returns (address)',
    'function token1() view returns (address)'
  ];
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const token1 = (await pair.token1()).toLowerCase();
  const [reserve0, reserve1] = await pair.getReserves();
  return { token0, token1, reserve0, reserve1 };
}
async function resolveCoreTokens(cfg) {
  const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
  const usdc = cfg.USDC.toLowerCase();
  const aeroPair = await readPair(cfg.AERO_USDC_POOL);
  const AERO = (aeroPair.token0 === usdc) ? aeroPair.token1 : aeroPair.token0;
  const liqPair = await readPair(cfg.LIQ_USDC_POOL);
  const LIQ  = (liqPair.token0 === usdc)  ? liqPair.token1  : liqPair.token0;
  const iaeroPair = await readPair(cfg.IAERO_AERO_POOL);
  const IAERO = (iaeroPair.token0 === AERO) ? iaeroPair.token1 : iaeroPair.token0;

  const decMap = new Map();
  async function putDecimals(addr) {
    try { const c = new ethers.Contract(addr, ERC20_DECIMALS_ABI, provider); const d = await c.decimals(); decMap.set(addr.toLowerCase(), Number(d)); }
    catch { decMap.set(addr.toLowerCase(), 18); }
  }
  await putDecimals(AERO); await putDecimals(LIQ); await putDecimals(IAERO); await putDecimals(usdc);
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
function docsContext() {
  return [
    "iAERO is a liquid staking protocol on Base network",
    "Users lock AERO permanently and receive liquid iAERO tokens at 0.95:1 ratio",
    "Stakers of iAERO earn 80% of all protocol fees; treasury 20%",
    "LIQ token has a halving emission schedule every 5M tokens",
    "stiAERO (staked iAERO) can be used as collateral for borrowing",
    "Protocol owns permanently locked veAERO NFTs; tokens remain liquid via iAERO",
    "Peg stability relies on arbitrage between iAERO and AERO",
  ].join('\n');
}
let gitBookCache = null;
async function fetchGitBookContent() {
  if (gitBookCache) return gitBookCache;
  try {
    const baseUrl = 'https://docs.iaero.finance';
    const pages = [
      '/introduction/what-is-iaero',
      '/getting-started/key-concepts-and-how-to',
      '/getting-started/what-is-stiaero',
      '/getting-started/the-magic-of-iaero',
      '/tokenomics/iaero-token',
      '/tokenomics/liq-token'
    ];
    const texts = [];
    for (const p of pages) {
      const r = await fetch(`${baseUrl}${p}`);
      if (!r.ok) continue;
      const html = await r.text();
      const txt = html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,2000);
      if (txt) texts.push(txt);
    }
    gitBookCache = texts.join('\n\n'); return gitBookCache;
  } catch (e) {
    console.error('Failed to fetch GitBook:', e?.message || e);
    return null;
  }
}

/* ============================== Live APY from GitHub ==================== */
const ESTIMATED_REWARDS_URL = 'https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/estimated_rewards_usd.json';

async function fetchLiveAPY() {
  try {
    const res = await fetch(ESTIMATED_REWARDS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    const apy = data?.apyPct;
    
    if (typeof apy !== 'number' || !isFinite(apy)) {
      console.warn('Invalid APY value in estimated_rewards_usd.json');
      return '0.00';
    }
    
    console.log('✓ Live APY fetched:', apy.toFixed(2) + '%');
    return apy.toFixed(2);
  } catch (e) {
    console.error('Failed to fetch live APY:', e?.message || e);
    return '0.00';
  }
}

async function getProtocolStats(force = false) {
  if (!force && statsCache.data && (Date.now()-statsCache.timestamp) < statsCache.ttl) {
    if (DEBUG_STATS) console.log('Returning cached stats');
    return statsCache.data;
  }
  console.log('Fetching fresh protocol stats...');
  const VAULT_ADDRESS   = process.env.VAULT_ADDRESS   || '0x180DAB53968e599Dd43CF431E27CB01AA5C37909';
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

  const retry = async (fn, fallback=0, tries=5) => {
    for (let i=0;i<tries;i++){
      try { return await fn(); }
      catch {
        if (i<tries-1) await new Promise(r=>setTimeout(r, Math.min(1000*(2**i), 5000)));
      }
    }
    return fallback;
  };

  let aeroLocked = await retry(async()=>parseFloat(ethers.formatEther(await vault.totalAEROLocked())));
  if (!aeroLocked) aeroLocked = await retry(async()=>parseFloat(ethers.formatEther(await vault.getTotalValueLocked())));
  if (!aeroLocked) aeroLocked = await retry(async()=>{ const vs = await vault.vaultStatus(); return parseFloat(ethers.formatEther(vs[0])); });
  console.log('✓ AERO locked:', aeroLocked);

  const liqMinted   = await retry(async()=>parseFloat(ethers.formatEther(await vault.totalLIQMinted())));
  const iaeroMinted = await retry(async()=>parseFloat(ethers.formatEther(await vault.totalIAEROMinted())));
  console.log('✓ LIQ minted:',  liqMinted);
  console.log('✓ iAERO minted:',iaeroMinted);

  let aeroPrice=NaN, liqPrice=NaN, iaeroPeg=NaN;
  try {
    const { tokens, decimals } = await resolveCoreTokens({ AERO_USDC_POOL, LIQ_USDC_POOL, IAERO_AERO_POOL, USDC: USDC_ADDRESS });
    aeroPrice = await retry(async()=>await pairPrice(AERO_USDC_POOL, tokens.AERO, tokens.USDC, decimals), 0);
    liqPrice  = await retry(async()=>await pairPrice(LIQ_USDC_POOL,  tokens.LIQ,  tokens.USDC, decimals), 0);
    iaeroPeg  = await retry(async()=>await pairPrice(IAERO_AERO_POOL,tokens.IAERO,tokens.AERO, decimals), 1);
    console.log('✓ AERO price:', aeroPrice);
    console.log('✓ LIQ price:',  liqPrice);
    console.log('✓ iAERO peg:',  iaeroPeg);
  } catch(e){ console.error('Price fetching failed:', e?.message || e); }

  const tvlFloat = (isFinite(aeroPrice) && aeroLocked>0) ? aeroLocked*aeroPrice : 0;
  console.log('=== PROTOCOL STATS ===');
  console.log('AERO Locked:', aeroLocked);
  console.log('AERO Price:', aeroPrice);
  console.log('TVL:', tvlFloat);
  console.log('iAERO Minted:', iaeroMinted);
  console.log('LIQ Minted:', liqMinted);
  console.log('====================');

  const liveAPY = await fetchLiveAPY();

  const stats = {
    tvl:         compactUSDorToken(tvlFloat),
    apy:         liveAPY,
    totalStaked: compactUSDorToken(iaeroMinted),
    liqPrice:    isFinite(liqPrice)  ? liqPrice.toFixed(4)  : '0.0000',
    aeroLocked:  compactUSDorToken(aeroLocked),
    aeroPrice:   isFinite(aeroPrice) ? aeroPrice.toFixed(4) : '0.0000',
    iAeroPeg:    isFinite(iaeroPeg)  ? iaeroPeg.toFixed(4)  : '1.0000',
    liqMinted:   compactUSDorToken(liqMinted)
  };
  statsCache = { data: stats, timestamp: Date.now(), ttl: statsCache.ttl };
  return stats;
}

/* ============================== Timeline & similarity =================== */
let recentTweetsCache = { tweets: [], timestamp: 0, ttl: 30 * 60 * 1000 };
let primeRetryMs = 15 * 60 * 1000; // backoff after 429

async function fetchMyTweetsRaw(count = 80) {
  try {
    let userId = process.env.TWITTER_USER_ID;
    if (!userId) {
      const me = await twitterClient.v2.me();
      userId = me.data.id;
      console.log('Got Twitter user ID:', userId);
    }
    // Single page to avoid 429
    const paginator = await twitterClient.v2.userTimeline(userId, {
      max_results: Math.min(100, Math.max(20, count)),
      exclude: ['retweets', 'replies'],
      'tweet.fields': ['created_at','text']
    });
    const texts = (paginator?.tweets || []).map(t=>t?.text).filter(Boolean);
    console.log(`Fetched ${texts.length} raw tweet(s) from timeline`);
    return texts;
  } catch (e) {
    console.error('fetchMyTweetsRaw failed:', e?.message || e);
    if (e?.code === 429 || e?.status === 429) {
      recentTweetsCache.timestamp = Date.now();
      recentTweetsCache.ttl = Math.min(4*60*60*1000, primeRetryMs);
      setTimeout(()=>primePostedHashesFromTimeline(80), primeRetryMs);
      primeRetryMs = Math.min(primeRetryMs*2, 4*60*60*1000);
    }
    return [];
  }
}

async function getRecentTweets(count = 50) {
  if (recentTweetsCache.tweets?.length>0 && (Date.now()-recentTweetsCache.timestamp)<recentTweetsCache.ttl) {
    if (DEBUG_STATS) console.log('Using cached recent tweets');
    return recentTweetsCache.tweets;
  }
  const raw = await fetchMyTweetsRaw(count);
  let cleaned = raw.map(t => t.replace(/https?:\/\/\S+/g,'').replace(/@\w+/g,'').replace(/#(\w+)/g,'$1').replace(/\s+/g,' ').trim())
                   .filter(t => t.length>10);
  if (cleaned.length===0 && tweetLog.length>0) {
    const src = tweetLog.slice(-count);
    cleaned = src.map(t => t.replace(/https?:\/\/\S+/g,'').replace(/@\w+/g,'').replace(/#(\w+)/g,'$1').replace(/\s+/g,' ').trim())
                 .filter(t => t.length>10);
    console.log(`Using ${cleaned.length} entries from local tweet log for similarity checks`);
  }
  if (cleaned.length>0) {
    recentTweetsCache = { tweets: cleaned, timestamp: Date.now(), ttl: recentTweetsCache.ttl };
    console.log(`Cached ${cleaned.length} cleaned tweet(s) for similarity checks`);
  } else {
    console.log('No recent tweets available for similarity; cache remains as-is');
  }
  return cleaned;
}

async function primePostedHashesFromTimeline(seedCount=80) {
  try {
    const raw = await fetchMyTweetsRaw(seedCount);
    let added = 0;
    if (raw.length>0) {
      for (const t of raw.reverse()) {
        const finalText = safeTrimTweet(t, 280);
        const h = hashTweet(finalText);
        if (!postedHashes.has(h)) { postedHashes.add(h); added++; }
      }
      if (added>0) await saveHashes();
      console.log(`Primed ${added} hash(es) from Twitter timeline`);
      primeRetryMs = 15 * 60 * 1000;
      return;
    }
    // Fallback to local log
    if (tweetLog.length>0) {
      for (const t of tweetLog.slice(-seedCount)) {
        const finalText = safeTrimTweet(t, 280);
        const h = hashTweet(finalText);
        if (!postedHashes.has(h)) { postedHashes.add(h); added++; }
      }
      if (added>0) await saveHashes();
      console.log(`Primed ${added} hash(es) from local tweet log`);
    } else {
      console.log('Priming found nothing (no Twitter access, no local log yet)');
    }
  } catch(e){ console.error('Failed to prime posted hashes:', e?.message || e); }
}

function detectStructuralSimilarity(a,b){
  const patterns = [
    /with a tvl of.*?and.*?apy of/i,
    /don't (let|miss) this opportunity/i,
    /join.*?today!/i,
    /dive into.*?with.*?tvl/i,
    /enhance your.*?today/i,
    /ready to.*?\?.*?with.*?tvl/i
  ];
  let m=0; for (const p of patterns) if (p.test(a)&&p.test(b)) m++;
  return m>=2;
}
async function isTwitterSimilar(newTweet, recentTweets, threshold=0.35){
  const cleanNew = (newTweet||'').replace(/https?:\/\/\S+/g,'').replace(/@\w+/g,'').replace(/#/g,'').trim().toLowerCase();
  for (const recent of recentTweets||[]) {
    if (!recent) continue;
    const cleanOld = recent.toLowerCase();
    if (detectStructuralSimilarity(cleanNew, cleanOld)) return true;
    const w1 = new Set(cleanNew.match(/\b\w+\b/g) || []), w2 = new Set(cleanOld.match(/\b\w+\b/g) || []);
    if (w1.size<3 || w2.size<3) continue;
    const inter = new Set([...w1].filter(x=>w2.has(x)));
    const uni   = new Set([...w1, ...w2]);
    const sim   = inter.size / uni.size;
    if (sim > threshold) return true;
  }
  return false;
}
async function checkWithOpenAI(newTweet, recentTweets) {
  if (!STRICT_ORIGINALITY || !OPENAI_ENABLED) return false;
  const prompt = `Is this new tweet too similar/formulaic vs the recents?

New:
"${newTweet}"

Recents:
${(recentTweets||[]).map((t,i)=>`${i+1}. "${t}"`).join('\n')}

Reply "YES" if too similar, otherwise "NO".`;
  try {
    const { text } = await chatOnce({ prompt, max: 50 });
    const verdict = (text || '').trim().toUpperCase();
    return verdict.includes('YES');
  } catch { return false; }
}

/* ============================== Local unique generator ================== */
function localUniqueTweet({ topic, mode='protocol' }) {
  const templates = mode==='protocol'
    ? [
        `Did you know: ${topic}. Liquidity without waiting.`,
        `${topic}. Keep voting power, keep optionality.`,
        `${topic}. Liquid wrapper solves the unlock problem.`,
        `${topic}. Design > promises.`,
        `${topic}. Compounding works better when you can exit.`
      ]
    : [
        `gm ser — ${topic} is back on the menu. Manage risk.`,
        `${topic} again? touch grass, then rebalance.`,
        `hot take: ${topic} needs fewer slogans, more product.`,
        `anon, ${topic} alpha isn’t on the timeline.`,
        `${topic}. ngmi if you ignore the fees.`
      ];
  for (let i=0;i<24;i++){
    const t = safeTrimTweet(pick(templates), 500);
    const h = hashTweet(t);
    if (!postedHashes.has(h) && !tweetLog.includes(t)) return t;
  }
  const base = safeTrimTweet(pick(templates), 500);
  return `${base} ·.`; // tiny salt to force new hash
}

/* ============================== Builders ================================ */
async function generateProtocolTweet(maxAttempts=5) {
  const recentTweets = await getRecentTweets();
  const tried = new Set();

  for (let attempt=0; attempt<maxAttempts; attempt++) {
    const stats = await getProtocolStats();
    if (!stats || stats.tvl === '0') { console.warn('Invalid stats; skip'); return null; }

    const topicsAvail = PROTOCOL_TOPICS.filter(t=>!isTopicOnCooldown(t));
    const topic = (topicsAvail.length ? topicsAvail : PROTOCOL_TOPICS)[Math.floor(Math.random()* (topicsAvail.length||PROTOCOL_TOPICS.length))];
    markTopicUsed(topic);

    const styles = ['educational','comparison','question','announcement','thread_starter','stat_highlight','feature_focus','user_story','myth_buster','tip','observation','analogy']
      .filter(s=>!tried.has(s));
    const style = (styles.length?styles:['educational'])[Math.floor(Math.random()*Math.max(styles.length,1))];
    tried.add(style);

    const includeStats = Math.random()<0.3;
    const docs = await fetchGitBookContent();
    const docsCtx = docs || docsContext();

    const statsCtx = includeStats
      ? `\nCurrent stats (weave naturally; no "with TVL of X and APY of Y"):
TVL ${stats.tvl}, APY ${stats.apy}%, AERO locked ${stats.aeroLocked}, iAERO/AERO ${stats.iAeroPeg}`
      : '\nDo not include specific stats in this tweet.';

    const recentCtx = (recentTweets?.length||0)>0
      ? `\n\nRecent tweets to avoid copying:\n${recentTweets.slice(0, 8).join('\n---\n')}`
      : '';

    const prompt = `Based on iAERO docs:
${docsCtx}

Create a ${style} tweet about: ${topic}
Guidance: Be specific, no [generic + stats + CTA].
Forbidden: "with a TVL of", "and APY of", "don't miss this opportunity", "join us today", "dive into", "enhance your", "ready to".
Max one hashtag, optional.
${statsCtx}
${recentCtx}
Under 280 chars.`;

    let generated = '';
    try {
      const { text } = await chatOnce({ prompt, max: 500 });
      generated = (text || '').trim();
    } catch (e) {
      console.error('OpenAI error (protocol tweet):', e?.message || e);
    }
    if (!generated) {
      console.warn('OpenAI empty; using local generator');
      generated = localUniqueTweet({ topic, mode:'protocol' });
    }

    generated = safeTrimTweet(generated, 500);
    const h = hashTweet(generated);
    if (postedHashes.has(h)) { console.log(`Hash exists (attempt ${attempt+1}); regenerating…`); continue; }

    const tooSimilar = await isTwitterSimilar(generated, recentTweets, 0.35)
      || (STRICT_ORIGINALITY && await checkWithOpenAI(generated, recentTweets.slice(0,10)));

    if (!tooSimilar) {
      // History-wide guard (ignores number/emoji tweaks)
      if (tooSimilarToHistory(generated)) {
        console.log('Rejected by history-wide similarity; regenerating…');
        continue;
      }
      console.log(`Generated ${style} tweet on attempt ${attempt+1}`);
      return generated;
    }
    console.log(`Too similar (${style}, attempt ${attempt+1}); regenerating…`);
    

  }

  const forced = localUniqueTweet({ topic: pick(PROTOCOL_TOPICS), mode:'protocol' });
  console.log('Using forced-unique local protocol tweet');
  return forced;
}

async function generateShitpost(maxAttempts=4) {
  const recentTweets = await getRecentTweets();
  const styles = ['meme_format','crypto_slang_heavy','fake_news_headline','hot_take','relatable_pain','chad_vs_virgin','year_2028_joke','wife_changing_money'];

  for (let attempt=0; attempt<maxAttempts; attempt++) {
    const topic = pick(SHITPOST_TOPICS);
    const style = pick(styles);

    const recentCtx = (recentTweets?.length||0)>0
      ? `\n\nAvoid repeating themes/jokes from these:\n${recentTweets.slice(0, 5).join('\n')}` : '';

    const prompt = `Create a witty, crypto-native tweet about ${topic}.
Style: ${style}
Context hints (optional): liquid permanent locks; Base network; staker fee share.
Rules: <280 chars, max 1 hashtag, no generic promo.
${recentCtx}`;

    let generated = '';
    try {
      const { text } = await chatOnce({ prompt, max: 200 });
      generated = (text || '').trim();
    } catch (e) {
      console.error('OpenAI error (shitpost):', e?.message || e);
    }
    if (!generated) {
      console.warn('OpenAI empty; using local generator (shitpost)');
      generated = localUniqueTweet({ topic, mode:'shitpost' });
    }

    generated = safeTrimTweet(generated, 280);
    const h = hashTweet(generated);
    if (postedHashes.has(h)) { console.log(`Shitpost hash exists (attempt ${attempt+1}); regenerating…`); continue; }

    const similar = await isTwitterSimilar(generated, recentTweets, 0.30);
    if (!similar) {
      if (tooSimilarToHistory(generated)) {
      console.log('Rejected by history-wide similarity; regenerating…');
      continue;
      }
    console.log(`Generated original shitpost (${style}) on attempt ${attempt+1}`);
    return generated;
    }
    console.log(`Shitpost too similar (attempt ${attempt+1}); regenerating…`);


  }

  const forced = localUniqueTweet({ topic: pick(SHITPOST_TOPICS), mode:'shitpost' });
  console.log('Using forced-unique local shitpost');
  return forced;
}

/* ============================== Posting & schedule ====================== */
function isDuplicateTweetError(err) {
  const msg = (err?.data?.detail || err?.data?.title || err?.message || '').toLowerCase();
  const codes = new Set((err?.data?.errors || []).map(e=>e?.code));
  return err?.code===403 || err?.status===403 || msg.includes('duplicate') || msg.includes('already posted') || codes.has?.(186) || codes.has?.(187);
}

async function postTweet(retries=2) {
  if (!TWEETS_ENABLED) {
    console.log('Regular tweets disabled (TWEETS_ENABLED=0); skipping');
    return null;
  }
  let lastError=null;
  for (let i=0;i<=retries;i++){
    let content=null;
    try{
      const isProtocol = Math.random() < 0.7;
      content = isProtocol ? await generateProtocolTweet() : await generateShitpost();
      if (!content) { console.log('No tweet content generated; skip'); return null; }

      content = safeTrimTweet(content, 280); // TRIM FIRST

      // FINAL guard against near-duplicate history (even if a generator slips)
      if (tooSimilarToHistory(content)) {
        console.log('Pre-post history similarity block; regenerating content…');
        // Try once more: regenerate once, then if still too similar, skip this cycle
        const retry = isProtocol ? await generateProtocolTweet() : await generateShitpost();
        if (!retry) return null;
        const trimmed = safeTrimTweet(retry, 280);
        if (tooSimilarToHistory(trimmed)) {
          console.log('Retry also similar to history; skipping this cycle');
          return null;
        }
        content = trimmed;
}

      const h = hashTweet(content);
      if (postedHashes.has(h)) { console.log('Hash collision pre-post; regenerating…'); continue; }

      console.log(`[${new Date().toISOString()}] Posting tweet:`, content);
      const tw = await twitterClient.v2.tweet(content);
      console.log('Tweet posted successfully:', tw?.data?.id);

      postedHashes.add(h);
      tweetLog.push(content);
      if (tweetLog.length>500) tweetLog = tweetLog.slice(-500);
      await Promise.all([saveHashes(), saveTweetLog()]);

      return tw;
    } catch(e){
      lastError=e;
      console.error(`Failed to post tweet (attempt ${i+1}/${retries+1}):`, e?.message || e);
      if (content && isDuplicateTweetError(e)) {
        const h = hashTweet(safeTrimTweet(content, 280));
        if (!postedHashes.has(h)) {
          console.log('Marking duplicate tweet hash to avoid future attempts');
          postedHashes.add(h);
          await saveHashes();
        }
      }
      if (e?.code===429 || e?.status===429) { console.log('Rate limited; stopping retries'); break; }
      if (i<retries){
        const wait = Math.min(1000*(2**i), 10000);
        console.log(`Waiting ${wait}ms before retry…`);
        await new Promise(r=>setTimeout(r, wait));
      }
    }
  }
  console.error('All post attempts failed:', lastError?.message || lastError);
  return null;
}

function getRandomIntervalMinutes(){
  const min = Number(process.env.TWEET_MIN_MINUTES || 720);
  const max = Number(process.env.TWEET_MAX_MINUTES || 1440);
  return Math.floor(Math.random()*(max-min+1)+min);
}
function scheduleNextTweet(){
  const minutes = getRandomIntervalMinutes();
  const ms = minutes*60*1000;
  console.log(`Next tweet in ${minutes} minutes (${(minutes/60).toFixed(1)} hours)`);
  setTimeout(async()=>{
    await postTweet();
    scheduleNextTweet();
  }, ms);
}

/* ============================== Bootstrap =============================== */
async function startBot(){
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
    tweetsEnabled:   TWEETS_ENABLED,
    vaultAddress:    process.env.VAULT_ADDRESS || '0x877398Aea8B5cCB0D482705c2D88dF768c953957',
    rpcUrl:          process.env.RPC_URL ? 'custom' : 'default Base RPC'
  });

  await initDataFiles();
  await loadHashes();
  await loadTweetLog();
  await primePostedHashesFromTimeline(80);

  console.log('Initializing stats cache…');
  const testStats = await getProtocolStats(true);
  console.log('Initial stats:', testStats);

  await fetchGitBookContent();

  try { console.log('Loading recent tweet history…'); await getRecentTweets(); }
  catch(e){ console.error('Could not load tweet history on startup:', e?.message || e); }

  if (testStats && testStats.tvl !== '0') {
    if (!recentTweetsCache.tweets || recentTweetsCache.tweets.length===0) {
      const jitter = 5 + Math.floor(Math.random()*10);
      console.log(`Rate limited or empty cache; waiting ${jitter} minutes before first tweet…`);
      await new Promise(r=>setTimeout(r, jitter*60*1000));
      try { await getRecentTweets(); } catch {}
    }
    await postTweet();
  } else {
    console.log('Skipping initial tweet due to invalid stats');
  }

  console.log('Registering recurring tweet scheduler…');
  scheduleNextTweet();
  console.log('Scheduler registered.');

  // Periodic timeline priming (helps after transient 429s)
  setInterval(()=>primePostedHashesFromTimeline(80), 3 * 60 * 60 * 1000);

  // Daily stats at 14:00 UTC (idempotent)
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
      const h = hashTweet(statsTweet);
      if (postedHashes.has(h)) { console.log('Daily stats tweet identical; skipping'); return; }

      try {
        const tw = await twitterClient.v2.tweet(statsTweet);
        console.log('Daily stats tweet posted:', tw?.data?.id);
        postedHashes.add(h);
        tweetLog.push(statsTweet);
        if (tweetLog.length>500) tweetLog = tweetLog.slice(-500);
        await Promise.all([saveHashes(), saveTweetLog()]);
      } catch (err) {
        console.error('Failed to post daily stats:', err?.message || err);
        if (isDuplicateTweetError(err)) {
          postedHashes.add(h);
          await saveHashes();
        }
      }
    }
  });

  // Stats refresh loop
  setInterval(async ()=>{
    if (DEBUG_STATS) console.log('Refreshing stats cache…');
    try { await getProtocolStats(true); } catch(e){ console.error('Stats refresh failed:', e?.message || e); }
  }, 5*60*1000);

  // Periodic persistence & mem stats
  setInterval(async ()=>{
    await Promise.all([saveHashes(), saveTweetLog()]);
    const u = process.memoryUsage();
    console.log('Memory usage:', {
      rss: `${Math.round(u.rss/1024/1024)}MB`,
      heap: `${Math.round(u.heapUsed/1024/1024)}MB / ${Math.round(u.heapTotal/1024/1024)}MB`,
      external: `${Math.round(u.external/1024/1024)}MB`,
      hashCount: postedHashes.size,
      topicCooldowns: topicCooldowns.size,
      tweetLogCount: tweetLog.length
    });
  }, 30*60*1000);
}

/* ============================== Crash safety ============================ */
process.on('unhandledRejection', err => { console.error('Unhandled rejection:', err); });
process.on('uncaughtException', async err => { console.error('Uncaught exception:', err); await Promise.allSettled([saveHashes(), saveTweetLog()]); process.exit(1); });
process.on('SIGTERM', async ()=>{ console.log('SIGTERM: saving state…'); await Promise.allSettled([saveHashes(), saveTweetLog()]); process.exit(0); });
process.on('SIGINT',  async ()=>{ console.log('SIGINT: saving state…');  await Promise.allSettled([saveHashes(), saveTweetLog()]); process.exit(0); });

startBot().catch(async err => { console.error('Failed to start bot:', err); await Promise.allSettled([saveHashes(), saveTweetLog()]); process.exit(1); });
