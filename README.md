# SplitEasy

Automatically split shared expenses with friends. SplitEasy connects to your bank via Plaid, fetches recent transactions, and lets you assign splits to Splitwise contacts — all from a single mobile screen.

## Architecture

```
mobile/          Expo app — PWA (web) + optional iOS native build
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
| GET/POST | `/splitwise/api/*` | CORS proxy to the Splitwise API for the web app (user token via `X-Splitwise-Token`) |

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

#### Web (PWA)

```bash
cd mobile
npm run web          # dev server in the browser
npm run build:web    # production build → mobile/dist/
```

The web app talks to the same local Worker. Two extra setup notes:

- **Splitwise redirect URI:** register `http://localhost:8081/oauth/callback` (dev) and `https://<your-domain>/oauth/callback` (production) as callback URLs in your [Splitwise OAuth app](https://secure.splitwise.com/oauth_clients). The native custom scheme `spliteasy://oauth/callback` stays registered for iOS builds.
- **Plaid on web** uses Plaid's hosted Link JS — no native build needed.

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

### Web app (PWA — primary distribution, via Vercel)

`mobile/vercel.json` configures the build (`npm run build:web` → `dist/`), the SPA fallback rewrite (so the `/oauth/callback` route works on hard loads), and cache headers (`sw.js` never cached; hashed bundles immutable).

One-time setup:

```bash
cd mobile
npx vercel login
npx vercel link                     # create/link the Vercel project (root = mobile)
# Build-time env vars, needed because app.config.js embeds them into the bundle:
npx vercel env add WORKER_BASE_URL production      # https://<your-worker>.workers.dev
npx vercel env add WORKER_API_KEY production
npx vercel env add SPLITWISE_CLIENT_ID production
```

Deploy:

```bash
cd mobile
npx vercel deploy --prod
```

(Any static host works — the build is plain static files: `npx expo export --platform web` with the three env vars set, then serve `mobile/dist/` with an SPA fallback to `index.html`.)

Set `ALLOWED_ORIGIN` on the Worker to the deployed origin, e.g. `https://<project>.vercel.app` (optional hardening; defaults to `*`):

```bash
cd workers && npx wrangler secret put ALLOWED_ORIGIN
```

Users install the PWA from the browser: **Share → Add to Home Screen** on iOS Safari, or the install prompt on Chrome/Edge/Android.

### iOS native build (optional, requires Apple Developer account)

```bash
cd mobile
npx eas build --platform ios --profile production
```
