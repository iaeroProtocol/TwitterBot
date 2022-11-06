# iAERO Protocol Twitter Bot

Automated Twitter/X bot for the iAERO Protocol that posts updates and engages with the crypto community.

## Features
- Posts every 4-6 hours (randomized)
- 75% protocol information, 25% crypto culture content
- AI-generated varied content
- Daily stats updates
- Health check endpoint for monitoring

## Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Set up environment variables (see below)
4. Run: `npm start`

## Environment Variables

Required in Railway or `.env` file:
- `TWITTER_API_KEY`
- `TWITTER_API_SECRET`
- `TWITTER_ACCESS_TOKEN`
- `TWITTER_ACCESS_SECRET`
- `OPENAI_API_KEY`

## Deployment

This bot is designed to run on Railway. Environment variables should be configured in Railway's dashboard, not committed to the repository.
