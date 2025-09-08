// twitter-bot.mjs - Complete version with documentation integration
import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import OpenAI from 'openai';
import cron from 'node-cron';
import express from 'express';

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

// Documentation context - hardcoded facts from docs.iaero.finance
function getDocumentationContext() {
  return {
    keyFacts: [
      "iAERO is a liquid staking protocol on Base network",
      "Users lock AERO permanently and receive liquid iAERO tokens 0.95:1",
      "iAERO can be traded on DEXs while earning staking rewards",
      "Stakers of iAERO earn 80% of all protocol fees",
      "Protocol treasury receives 10% of fees (80% of those go to LIQ stakers), 10% are used for peg defense",
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
      treasuryShare: "10%",
      pegDefense: "10%",
      liqEmissionModel: "halving per 5M tokens",
      stakingLockPeriod: "7 days for LIQ unstaking"
    }
  };
}

// DocsBot integration for accurate answers
async function askDocsBot(question) {
  if (!process.env.DOCSBOT_API_KEY) {
    console.log('DocsBot not configured, using static documentation');
    return null;
  }

  const url = `https://api.docsbot.ai/teams/${process.env.DOCSBOT_TEAM_ID}/bots/${process.env.DOCSBOT_BOT_ID}/chat-agent`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DOCSBOT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question,
        stream: false,
        context_items: 5,
      }),
    });
    
    if (!response.ok) {
      console.error('DocsBot API error:', response.status);
      return null;
    }
    
    const data = await response.json();
    const events = Array.isArray(data) ? data : [data];
    const answer = events.find(e => e?.event === 'answer')?.data?.answer;
    
    return answer || null;
  } catch (error) {
    console.error('DocsBot error:', error);
    return null;
  }
}

// Stats fetcher from your API
async function getProtocolStats() {
  try {
    const response = await fetch('https://iaero.finance/api/stats');
    if (!response.ok) throw new Error('Stats API error');
    
    const data = await response.json();
    return {
      tvl: data.tvl || 'N/A',
      apy: data.apy || 'N/A',
      totalStaked: data.totalStaked || 'N/A',
      liqPrice: data.liqPrice || 'N/A',
      aeroLocked: data.aeroLocked || 'N/A'
    };
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    // Return placeholder data for testing
    return {
      tvl: '5.2M',
      apy: '30',
      totalStaked: '1.8M',
      liqPrice: '0.15',
      aeroLocked: '2.5M'
    };
  }
}

// Generate protocol information tweet
async function generateProtocolTweet() {
  const topic = PROTOCOL_TOPICS[Math.floor(Math.random() * PROTOCOL_TOPICS.length)];
  const stats = await getProtocolStats();
  const docs = getDocumentationContext();
  
  // Try to get specific information from DocsBot
  let additionalContext = '';
  const docsBotAnswer = await askDocsBot(`What are the specific details about ${topic} in iAERO protocol?`);
  if (docsBotAnswer) {
    additionalContext = `\n\nAdditional verified information: ${docsBotAnswer}`;
  }
  
  const prompt = `Create an informative tweet about ${topic} for iAERO Protocol.
  
Use ONLY these verified facts from the documentation:
${docs.keyFacts.join('\n')}
${additionalContext}

${stats ? `Current live stats:
- TVL: $${stats.tvl}
- APY: ${stats.apy}%
- Total Staked: ${stats.totalStaked} iAERO
- LIQ Price: $${stats.liqPrice}
- AERO Locked: ${stats.aeroLocked}` : ''}

Requirements:
- Be factually accurate, only use provided information
- Make it engaging and informative
- Use 1-2 relevant emojis
- Keep under 280 characters
- Maximum 2 hashtags
- Don't make up statistics or features not mentioned`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_completion_tokens: 300
    });
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI error:', error);
    // Fallback tweets based on documented facts
    const fallbacks = [
      `🚀 iAERO Protocol: Lock AERO permanently, get liquid iAERO 1:1. Trade anytime while earning 80% of protocol fees. No unlock periods, just pure liquid staking on Base. TVL: $${stats?.tvl || 'N/A'}`,
      `💎 Why lock for 4 years when you can lock permanently and stay liquid? iAERO holders earn 80% of all protocol fees while maintaining full trading flexibility. Smart DeFi on Base.`,
      `📊 stiAERO unlocks capital efficiency: Use it as collateral while earning staking rewards. 80% fee share + LIQ emissions + borrowing power. This is next-gen DeFi on Base.`,
      `🔒 Permanent lock, liquid token. iAERO maintains its peg through arbitrage while you earn from protocol fees. ${stats?.apy || 'N/A'}% APY with zero lock period. DeFi done right.`,
      `⚡ Weekly rewards, no waiting. iAERO stakers receive 80% of protocol fees every epoch. Plus LIQ tokens with halving emissions. Current TVL: $${stats?.tvl || 'N/A'}`
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
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_completion_tokens: 300
    });
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI error:', error);
    // Fallback shitposts
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
    
    let tweetContent = isProtocolTweet  // Use 'let' instead of 'const'
      ? await generateProtocolTweet()
      : await generateShitpost();
    
    console.log(`[${new Date().toISOString()}] Posting tweet:`, tweetContent);
    
    // Validate tweet length
    if (tweetContent.length > 280) {
      console.error('Tweet too long, truncating...');
      tweetContent = tweetContent.substring(0, 277) + '...';
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
🔒 Total Staked: ${stats.totalStaked} iAERO
💎 LIQ Price: $${stats.liqPrice}
🏦 AERO Locked: ${stats.aeroLocked}

Stakers earn ${docs.stats.stakerShare} of all protocol fees.
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
