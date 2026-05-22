# SplitEasy

Automatically split shared expenses with friends. SplitEasy connects to your bank via Plaid, fetches recent transactions, and lets you assign splits to Splitwise contacts — all from a single mobile screen.

## Architecture

```
mobile/          Expo (React Native) iOS app
workers/         Cloudflare Worker — API proxy for Plaid & Splitwise
supabase/        Postgres DB + RLS policies (local dev via Supabase CLI)
```

The mobile app never holds Plaid or Splitwise secrets. All third-party API calls go through the Cloudflare Worker, which validates requests with a shared `WORKER_API_KEY`.

### Worker API routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/plaid/link-token` | Create a Plaid Link token to open the bank connection UI |
| POST | `/plaid/exchange` | Exchange a Plaid public token for an access token |
| POST | `/plaid/transactions` | Fetch recent transactions for a linked account |
| POST | `/splitwise/exchange` | Exchange a Splitwise OAuth code for an access token |

All routes require `Authorization: Bearer <WORKER_API_KEY>`.

---

## Prerequisites

- Node.js 18+
- [Expo CLI](https://docs.expo.dev/get-started/installation/) (`npm install -g expo-cli`)
- Xcode 15+ (for iOS builds)
- CocoaPods (`gem install cocoapods`)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A [Plaid](https://dashboard.plaid.com) developer account (sandbox is free)
- A [Splitwise](https://secure.splitwise.com/oauth_clients) OAuth application

---

## Local development

### 1. Supabase (database)

```bash
supabase start          # starts local Postgres + Studio at http://localhost:54323
supabase db reset       # applies all migrations from supabase/migrations/
```

Keep this running while developing.

### 2. Cloudflare Worker

```bash
cd workers
npm install
```

Create `workers/.env.local`:

```env
WORKER_API_KEY=any-random-string-for-local-dev
WORKER_URL=http://localhost:8787
SPLITWISE_CLIENT_ID=<your splitwise client id>
SPLITWISE_CLIENT_SECRET=<your splitwise client secret>
PLAID_CLIENT_ID=<your plaid client id>
PLAID_SECRET=<your plaid sandbox secret>
PLAID_ENV=sandbox
```

Start the Worker locally:

```bash
npx wrangler dev --env-file .env.local
# Listening on http://localhost:8787
```

### 3. Mobile app

```bash
cd mobile
npm install
```

Create `mobile/.env.local`:

```env
WORKER_BASE_URL=http://localhost:8787
WORKER_API_KEY=any-random-string-for-local-dev   # must match workers/.env.local
SPLITWISE_CLIENT_ID=<your splitwise client id>
```

#### iOS (native build required for Plaid)

```bash
cd mobile/ios
pod install
cd ..
npx expo start --dev-client
```

Then open `mobile/ios/SplitEasy.xcworkspace` in Xcode and press **⌘R** to build and run on a simulator or device. Once the app boots it will connect to the Metro bundler started above.

> **Why a native build?** Plaid's iOS SDK (`LinkKit`) is a native framework — it cannot run in Expo Go.

---

## Deployment

### Cloudflare Worker

```bash
cd workers
npx wrangler deploy

# Set production secrets (one-time or when rotating):
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put PLAID_ENV          # production
npx wrangler secret put WORKER_API_KEY
npx wrangler secret put SPLITWISE_CLIENT_ID
npx wrangler secret put SPLITWISE_CLIENT_SECRET
```

### Mobile app (EAS Build)

```bash
cd mobile
npx eas build --platform ios --profile production
```

Update `mobile/.env.local` (or EAS environment variables) to point `WORKER_BASE_URL` at the deployed Worker URL before submitting.
