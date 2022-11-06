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
async function fetchAllGitBookPages() {
  const baseUrl = 'https://docs.iaero.finance';
  
  // List all your GitBook pages here
  const pages = [
    '/',
    '/introduction/what-is-iaero',
    '/introduction/key-features',
    '/getting-started/how-to-lock-aero',
    '/getting-started/how-to-stake',
    '/getting-started/how-to-claim-rewards',
    '/getting-started/key-concepts-and-how-to',
    '/getting-started/the-magic-of-iaero',
    '/user-guides/deposit-aero',
    '/tokenomics/iaero-token',
    '/tokenomics/liq-token',
    '/tokenomics/stiaero',
    '/tokenomics/vesting',

  ];
  
  console.log(`Fetching ${pages.length} documentation pages...`);

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

Requirements:
- Under 280 characters
- Factually accurate based on the docs
- Include 1-2 emojis
- Include hashtags`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300
    });
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI error:', error);
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
      model: 'gpt-5',
      messages: [{ role: 'user', content: prompt }],
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
