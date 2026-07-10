# SplitEasy PWA Conversion — Design

**Date:** 2026-07-09
**Status:** Approved (auto mode — decisions made autonomously per user instruction)
**Goal:** Ship SplitEasy as an installable Progressive Web App so distribution does not require an Apple Developer account ($100/year). The web becomes the primary target; the existing iOS native path is kept working but no longer the deliverable.

## Context

The app is an Expo 52 + expo-router 4 React Native app (`mobile/`), backed by a Cloudflare Worker API proxy (`workers/`). Expo has first-class web support via react-native-web, so this is a **conversion in place** (add a web target + PWA shell), not a rewrite.

### Approaches considered

1. **Expo universal app (chosen).** Add react-native-web + Metro web target, platform-split the native-only modules, add PWA manifest/service worker. One codebase, all screens/stores/tests reused.
2. **Separate web rewrite (Next.js/Vite).** Duplicates every screen and store; ongoing double maintenance. Rejected.
3. **Capacitor/WebView wrapper.** Still needs Apple account to distribute on iOS. Rejected — doesn't solve the actual problem.

## Native-only surface and web replacements

| Native piece | Where | Web replacement |
|---|---|---|
| `expo-secure-store` | `lib/secure.ts`, `stores/plaidStore.ts` | `localStorage` via `lib/secure.web.ts` (same exported API). No OS keychain exists on web; tokens in localStorage is the standard PWA trade-off and equal to what the bundled `WORKER_API_KEY` already implies. |
| `expo-sqlite` | `lib/db.ts` | **IndexedDB** implementation `lib/db.web.ts` with the identical exported function API. expo-sqlite's wasm web build was rejected because it requires COOP/COEP cross-origin isolation, which breaks Plaid Link popups/OAuth and rules out simple static hosting. Data volume is tiny (≤6 months of transactions), so JS-side filtering/joining is fine. IndexedDB transactions cover the two atomicity helpers (`persistCombinedSplit`, `revertCombinedSplit`). |
| `react-native-plaid-link-sdk` | `app/(auth)/bank-connect.tsx`, `lib/plaidLinkAvailable.ts` | New `lib/plaidLink.ts` abstraction: `.native.ts` wraps the RN SDK, `.web.ts` loads Plaid Link JS (`https://cdn.plaid.com/link/v2/stable/link-initialize.js`) and uses `Plaid.create({ token, onSuccess, onExit })`. `bank-connect.tsx` calls only the abstraction. |
| Splitwise OAuth via `expo-web-browser` + `spliteasy://` scheme | `app/(auth)/index.tsx` | New `lib/splitwiseAuth.ts` abstraction: native keeps `openAuthSessionAsync` with the custom scheme; web does a full-page redirect to Splitwise authorize with `redirect_uri = origin + '/oauth/callback'` and a new `app/oauth/callback.tsx` route exchanges the code and routes onward. **Operational prerequisite:** the web redirect URI must be registered in the Splitwise OAuth app settings (documented in README). |
| Direct Splitwise API calls (CORS-blocked in browsers) | `lib/splitwise.ts` | Proxy through the Cloudflare Worker on web. Worker gains `ANY /splitwise/api/*` that forwards the method/body to `https://secure.splitwise.com/api/v3.0/*`, reading the user's Splitwise token from an `X-Splitwise-Token` header (worker API key stays in `Authorization`). Only the transport in `swGet`/`swPost` becomes platform-aware; exported API unchanged. |
| `Alert.alert` (no-op on web) | settings, history, bank-connect screens | `lib/dialog.ts` helper: native → `Alert.alert`, web → `window.alert`/`window.confirm` mapped to the same button-callback shape. |
| `TurboModuleRegistry` probe | `lib/plaidLinkAvailable.ts` | Folded into the `plaidLink` abstraction (`isAvailable()` — always true on web once the script loads). |

Already web-compatible (no change expected): zustand, AsyncStorage (localStorage-backed on web), NetInfo, expo-router, expo-linking, @expo/vector-icons, reanimated/gesture-handler/@gorhom/bottom-sheet (verify in browser during the verification phase).

## Worker changes

- **CORS:** answer `OPTIONS` preflights and add `Access-Control-Allow-Origin` (from an `ALLOWED_ORIGIN` env var, `*` in dev), `Access-Control-Allow-Headers: Authorization, Content-Type, X-Splitwise-Token` on all responses.
- **Splitwise proxy route** as described above.
- **Link token:** accept optional `platform` in `POST /plaid/link-token`; omit `android_package_name` when `platform === 'web'`.

## PWA shell

- `app.json`: add `"web"` to platforms; `web: { bundler: "metro", output: "single" }` (single-file SPA output → works on any static host, no server-side routing needed).
- `public/manifest.webmanifest`: name SplitEasy, `display: standalone`, theme/background `#5C7AEA`, 192/512 icons (maskable) generated from `assets/icon.png` with `sips`.
- `public/sw.js`: small hand-rolled service worker — precache the app shell on install, cache-first for hashed static assets, network-first with cache fallback for navigations. No workbox dependency.
- `app/+html.tsx`: manifest link, `theme-color`, `apple-touch-icon`, viewport meta (iOS Safari installability).
- SW registration in the root layout, web-only, after load.

## Config & deployment

- `WORKER_BASE_URL` / `WORKER_API_KEY` / `SPLITWISE_CLIENT_ID` continue to flow through `app.config.js` extra at build time.
- Build: `npx expo export --platform web` → `mobile/dist/`.
- Hosting: any static host; README documents Cloudflare Pages (free, same account as the Worker) with SPA fallback. Actual deployment is out of scope (requires credentials); local verification via `npx expo start --web` and a static serve of `dist/`.

## Testing

- All 71 existing mobile tests keep passing (jest-expo resolves `.native.ts`; where needed, explicit mapping keeps current suites pointed at the native implementations they test).
- New unit tests: `db.web.ts` against `fake-indexeddb`, `secure.web.ts`, dialog helper, worker CORS + Splitwise proxy (vitest).
- Manual/browser verification: sign-in redirect flow, Plaid Link web (sandbox), transaction list, split flow, offline banner, installability (manifest + SW audit).
- Known pre-existing baseline failure: 3 workers tests (malformed-JSON handling) fail on `main` before this work; not in scope, must not regress further.

## Out of scope

- Deleting the iOS project (kept working; PR notes it is no longer the distribution path).
- Per-user Plaid identity (existing TODO), push notifications, background sync.
