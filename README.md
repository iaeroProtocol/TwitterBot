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

Optional (on-chain stats; defaults are the post-migration Aero addresses on Base):
- `IAERO_AERO_POOL`, `AERO_USDC_POOL`, `LIQ_USDC_POOL` (change together; the AERO in both AERO pools must match)
- `IAERO_ADDRESS` (iAERO minted = `totalSupply()`)
- `VOTING_ESCROW_ADDRESS`, `PROTOCOL_AERO_STAKE_ID` (default `1584`; backing = `staked(id).amount`)
- `VAULT_ADDRESS` (PermalockVault V5, frozen; only read for LIQ minted)

Dry run (prints the daily stats tweet, posts nothing): `npm run stats:dry-run`

## Deployment

This bot is designed to run on Railway. Environment variables should be configured in Railway's dashboard, not committed to the repository.
