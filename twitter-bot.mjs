// twitter-bot.mjs
import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import OpenAI from 'openai';
import cron from 'node-cron';
import express from 'express';

// Health check server for Railway
const app = express();
const PORT = process.env.PORT || 3000;

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

// [... rest of your code stays the same until the startBot function ...]

// Start the bot
async function startBot() {
  console.log('🤖 iAERO Twitter Bot starting...');
  
  // Post first tweet immediately when deployed to Railway
  console.log('Posting initial tweet on startup...');
  await postTweet();
  
  // Schedule recurring tweets
  scheduleNextTweet();
  
  // Daily stats tweet at 2 PM UTC
  cron.schedule('0 14 * * *', async () => {
    const stats = await getProtocolStats();
    if (stats) {
      const statsTweet = `📊 iAERO Daily Stats Update\n\n💰 TVL: $${stats.tvl}\n📈 APY: ${stats.apy}%\n🔒 Total Staked: ${stats.totalStaked} iAERO\n💎 LIQ Price: $${stats.liqPrice}\n\nLock. Stake. Earn. Stay liquid.`;
      await twitterClient.v2.tweet(statsTweet);
    }
  });
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Start the bot
startBot();
