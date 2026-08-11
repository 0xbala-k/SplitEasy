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
| POST | `/receipt/parse` | Upload a receipt photo (base64), get back merchant/items/subtotal/tax/tip/total parsed by Gemini |

All routes require `Authorization: Bearer <WORKER_API_KEY>`.

### Rate limiting

`WORKER_API_KEY` is bundled into the web app's JS and is therefore extractable by anyone who inspects the PWA — a valid-looking `Authorization` header doesn't by itself prove a legitimate caller. This is a low-severity, pre-existing posture shared by every route, but `/receipt/parse` is the one where an unauthenticated-in-spirit caller gets standalone value (burning Gemini API quota) without needing anything else (the Plaid routes, by contrast, require a real `access_token` to do anything useful).

`/receipt/parse` is rate-limited to **20 requests / 60 seconds per client IP** (keyed off `CF-Connecting-IP`, falling back to `"anon"` when absent, e.g. local dev), via a Cloudflare Workers [`ratelimit` binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) declared in `workers/wrangler.toml`:

```toml
[[unsafe.bindings]]
name = "RECEIPT_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 20, period = 60 }
```

Exceeding the limit returns `429 { "error": "RATE_LIMITED" }`. No additional Cloudflare dashboard configuration is required — the binding is provisioned automatically on `wrangler deploy`. If a different limit is ever needed, adjust `simple.limit`/`simple.period` in `wrangler.toml`; no code change is required.

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
- A [Gemini API](https://aistudio.google.com/apikey) key (for receipt parsing)

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
GEMINI_API_KEY=<your gemini api key>
GEMINI_MODEL=gemini-2.5-flash    # optional, defaults to gemini-2.5-flash
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
npx wrangler secret put GEMINI_API_KEY     # required for receipt parsing
npx wrangler secret put GEMINI_MODEL       # optional, defaults to gemini-2.5-flash
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

---

## Manual QA

Automated tests (Jest for `mobile/`, Vitest for `workers/`) cover logic and component behavior, but a few things — camera/file-picker plumbing, OS permission prompt copy, PWA install behavior — can only be verified by hand on real devices/browsers. Run this checklist before shipping any change that touches receipt capture (`mobile/components/ReceiptCapture.tsx`, `mobile/lib/receiptScan.ts`) or the Worker's `/receipt/parse` route.

Web is the primary distribution platform, so verify it first; native builds are secondary.

- [ ] **PWA on iOS Safari — camera capture.** Install the PWA (Share → Add to Home Screen), open it from the home screen icon (not the browser tab), start a Receipt split, tap "Take photo", confirm the camera opens directly (not a file picker), capture a real receipt, and confirm it scans and populates items.
- [ ] **PWA on iOS Safari — installed-to-home-screen behavior.** With the PWA installed, confirm the app opens full-screen (no Safari chrome), the receipt flow doesn't get interrupted by any browser UI, and navigating away/back (e.g. backgrounding the app mid-scan) doesn't lose sheet state unexpectedly.
- [ ] **PWA on desktop Chrome — file picker path.** Open the web app in desktop Chrome (no camera capture attribute support in the same way as mobile), start a Receipt split, tap "Choose photo" (the camera button should be hidden per the `Platform.OS === 'web' && !navigator.mediaDevices` check), pick an image file, and confirm it scans correctly.
- [ ] **Native iOS dev build — camera permission prompt copy.** On a fresh install (or after resetting camera permissions in Settings), trigger "Take photo" and confirm the iOS permission prompt shows the expected app-provided copy (from `Info.plist`'s `NSCameraUsageDescription`), not a generic/blank message. Confirm both Allow and Deny paths behave sensibly (Deny should not crash the flow — it should fail gracefully into the manual-entry path).
- [ ] **Native Android.** Repeat the camera and file-picker checks on a physical or emulated Android device: camera permission prompt copy, photo capture, and photo-library selection all produce a scanned/normalized receipt or a graceful failure into manual entry.

For each row above, also spot-check the failure path (deny permission, cancel the picker, or pick a non-receipt image) to confirm the app falls back to "enter items manually" rather than getting stuck.
