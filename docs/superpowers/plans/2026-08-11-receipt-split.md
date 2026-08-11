# Receipt Split Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third "Receipt" option next to Equal/Custom in the split sheet. The user photographs or uploads a receipt, gets an editable itemized list back, assigns each item to whichever previously-selected people shared it (including an "All" button), and the app computes each person's share: their assigned items, plus tax split proportional to each person's item subtotal, plus tip split equally across everyone. The result feeds into the exact same `friendShares` hand-off the existing Custom mode already uses.

**Architecture:** A new Cloudflare Worker route (`workers/src/receipt.ts`, wired into `workers/src/index.ts`) calls Google Gemini (`generateContent` with a `responseSchema`) to turn a receipt photo into structured JSON, entirely server-side so the API key never reaches client code. The client (`mobile/lib/receiptScan.ts`) captures/downscales the photo with `expo-image-picker` + `expo-image-manipulator` (one implementation, both native and web) and posts it to the Worker via `mobile/lib/worker.ts`. A new pure module (`mobile/lib/receipt.ts`, zero RN imports) does all the cents-based tax/tip/item math and is fully unit tested independent of any UI. `FriendPickerSheet.tsx` gains a third `SplitMode`, a two-stage (`capture`/`assign`) receipt flow reusing its existing `BottomSheetFlatList`, and two new derived values (`receipt`, `effectiveTotal`) that plug into the existing `totalCents`/`ctaDisabled`/`handleAddToSplitwise` logic with minimal changes to that logic's shape.

**Corrected premise (verified during planning):** The app no longer uses Supabase at all — it migrated to a local-first architecture (SQLite/IndexedDB locally, Cloudflare Workers for anything server-side: `/plaid/*`, `/splitwise/*`). `supabase/` is dead code (only referenced by stale `supabase/config.toml` and old docs). New server-side code for this feature must be a Worker route, not a Supabase Edge Function. There is also no `split_type` column or itemization storage anywhere locally — `SplitDecision` (in `mobile/lib/types.ts`) has no such field, so **no DB/schema migration is needed for this feature.**

**Decisions confirmed with the user before implementation:**
- **(A) Reconciliation:** the bank-charged amount (`transactions.amount`, i.e. `totalAmount` in `FriendPickerSheet.tsx`) wins by default and is what's sent to Splitwise as `cost`. If the receipt's computed total (items + tax + tip) *exceeds* the charge — e.g. tip added after authorization, the common real-world case — the sheet auto-switches to charging the receipt total instead, via a user-overridable toggle, so the split isn't permanently blocked. If the receipt total is *less than* the charge, the bank amount still wins and the owner absorbs the difference (existing `ownerShareCents` behavior, unchanged).
- **(B) Owner as participant:** yes. The payer is a normal assignable participant on every item and shares in both the proportional tax split and the equal tip split, exactly like a friend. Required for correctness whenever the payer also had items on the receipt.
- **(C) Receipt mode in edit mode:** yes. Editing an existing split can re-scan a new receipt, same as it can already switch to Custom and retype amounts.

**Tech Stack:** React Native / Expo 52, expo-router, zustand, expo-sqlite/IndexedDB, @gorhom/bottom-sheet, jest-expo, Cloudflare Workers (`workers/`), vitest. Google Gemini API (`gemini-2.5-flash` via `generateContent`, pinned through an env var since `gemini-2.0-flash` was retired 2026-03-03 — do not hardcode a model id that can't be rotated without a code change).

---

## File Structure

- `workers/src/receipt.ts` (create) — `RECEIPT_SCHEMA`, prompt, `parseMoneyToCents`, `normalizeReceipt`, `callGemini`.
- `workers/src/index.ts` (modify) — `Env` gains `GEMINI_API_KEY`/`GEMINI_MODEL`; new `POST /receipt/parse` route inside the existing `authenticate()`/`withCors()` wrapper.
- `workers/src/index.test.ts` (modify) — tests for the new route.
- `mobile/lib/receipt.ts` (create) — pure types + math (`distribute`, `computeReceiptShares`, `toFriendShares`). No RN imports.
- `mobile/__tests__/lib/receipt.test.ts` (create) — full TDD coverage of the math, including a property test.
- `mobile/lib/worker.ts` (modify) — add `parseReceipt()`.
- `mobile/__tests__/lib/worker.test.ts` (modify) — tests for `parseReceipt`.
- `mobile/lib/receiptScan.ts` (create) — pick → downscale → base64 → worker call, one implementation for native + web.
- `mobile/__tests__/lib/receiptScan.test.ts` (create) — mocked picker/manipulator/worker tests.
- `mobile/lib/receiptScan.web.ts` (create, **conditional** — only if the Phase 3 empirical web check fails) — canvas-based downscale fallback.
- `mobile/components/ReceiptItemRow.tsx` (create) — one item row: name, price, delete, assignee chips + All.
- `mobile/components/ReceiptCapture.tsx` (create) — capture-stage header content (Take photo / Choose photo / Skip).
- `mobile/components/ReceiptSummary.tsx` (create) — totals, tax/tip inputs, reconciliation toggle.
- `mobile/components/FriendPickerSheet.tsx` (modify) — third `SplitMode`, receipt state machine, derived `receipt`/`effectiveTotal`, list branches, `handleAddToSplitwise` three-way `shares`/`amount`.
- `mobile/__tests__/components/FriendPickerSheet.test.tsx` (modify) — integration tests for the receipt flow.
- `mobile/app.json` (modify) — `expo-image-picker` plugin block (camera/photos permission strings).
- `README.md` (modify) — document `GEMINI_API_KEY`/`GEMINI_MODEL` alongside existing worker secrets.

Tasks 2 and 3 are pure-logic and fully TDD. Task 4's transport layer is TDD; its web capture path has one empirical assumption that must be verified before UI work proceeds (see Task 4). Tasks 5–6 are React Native UI/sheet wiring, verified with `npx tsc --noEmit` as the automated gate, per this project's existing convention that RN bottom-sheet interactions aren't unit-testable in this jest setup — Task 7 adds what *is* testable at the integration level via the sheet's existing bespoke `@gorhom/bottom-sheet` mock.

---

## Task 1: Dependencies & config

**Files:**
- Modify: `mobile/package.json`, `mobile/app.json`, `workers/wrangler.toml` (comment/docs only), `README.md`

- [ ] **Step 1:** `cd mobile && npx expo install expo-image-picker expo-image-manipulator` — expect SDK-52-pinned versions `~16.0.6` / `~13.0.6` (confirmed against `node_modules/expo/bundledNativeModules.json` during planning; if `expo install` resolves differently, treat that as new information, not an error to force past).
- [ ] **Step 2:** Add to `mobile/app.json` under `plugins`:
  ```json
  ["expo-image-picker", {
    "photosPermission": "SplitEasy needs access to your photos so you can attach a receipt to a split.",
    "cameraPermission": "SplitEasy needs camera access so you can photograph a receipt."
  }]
  ```
- [ ] **Step 3:** `mobile/ios/` is committed to git (Podfile etc. are tracked; only `Pods/`/`build/` are ignored), so the plugin's permission strings do not take effect until prebuild runs. Run `npx expo prebuild -p ios`, then `cd ios && pod install`, and commit the resulting `Info.plist` (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`) and `Podfile.lock` changes. `mobile/android/` is not currently committed, so no Android prebuild step is needed yet.
- [ ] **Step 4:** In `workers/`, run `wrangler secret put GEMINI_API_KEY` (interactive — the human operator runs this, not the agent). Document `GEMINI_API_KEY` and optional `GEMINI_MODEL` (default `gemini-2.5-flash`) in the `wrangler.toml` header comment block next to the existing secret list, and in `README.md`'s setup instructions.
- [ ] **Gate:** `npx tsc --noEmit` clean; `npm test` in `mobile/` still fully green at the pre-existing baseline.

---

## Task 2: Pure receipt math (`mobile/lib/receipt.ts`)

**Files:**
- Create: `mobile/lib/receipt.ts`
- Test: `mobile/__tests__/lib/receipt.test.ts`

Everything operates in integer cents. Every distribution uses **largest-remainder apportionment with a deterministic tiebreak by participant index, owner at index 0** — matching the existing floor-remainder-to-owner pattern already in `mobile/lib/splitwise.ts` (`buildExpenseBody`, lines ~106–118) and `FriendPickerSheet.tsx` (lines ~158–170).

- [ ] **Step 1: Write the failing tests** in `mobile/__tests__/lib/receipt.test.ts`:
  1. Spec's worked example — items $100 total, A's items $80, B's items $20, tax $10 → A's `taxShareCents` is exactly 800, B's is exactly 200.
  2. A $10.00 item split 3 ways → shares `[334, 333, 333]` (owner/index-0 gets the extra cent), summing to 1000.
  3. A $0.01 tip across 3 participants → `[1, 0, 0]`.
  4. Items `[3333, 3333, 3334]`, one assignee each, tax `1000` → per-person tax shares sum to exactly 1000.
  5. All items assigned to one person → that person's tax share equals the entire tax.
  6. Zero items, non-zero tax → tax splits equally across participants (no NaN, no divide-by-zero).
  7. Empty items array → all zeros; `receiptTotalCents === taxCents + tipCents`.
  8. An item with `assignees: []` appears in `unassignedItemIds` and contributes 0 to every participant's subtotal.
  9. Single participant (owner only, no friends selected) → owner gets 100% of everything; `toFriendShares` returns `{}`.
  10. **Property test:** 200 randomized inputs (1–15 items, 1–8 participants, random assignee subsets, random tax/tip in `0..5000` cents) — assert `Σ totalPerParticipantCents === receiptTotalCents` and every individual share `>= 0` for every input. (Use a seeded/deterministic PRNG or a fixed table of generated cases — this project's jest setup has no `Date.now()`/`Math.random()` restriction like the Workflow tool does, but keep the test itself deterministic so CI doesn't flake.)
  11. Determinism: identical input object → identical output across two calls (guards against relying on `Object.keys` iteration order anywhere instead of the explicit `participantIds` array).
- [ ] **Step 2: Implement** in `mobile/lib/receipt.ts`:

  ```ts
  export const OWNER_FALLBACK_ID = '__me__';

  export interface ReceiptItem {
    id: string;            // local id, e.g. from a generateId() helper already used elsewhere in the codebase
    name: string;
    priceCents: number;    // line total (quantity already multiplied in)
    quantity?: number;     // display only
    assignees: string[];   // participant ids; [] = unassigned
  }

  export interface ReceiptComputeInput {
    ownerId: string;
    friendIds: string[];   // stable order, from the existing `selected` set
    items: ReceiptItem[];
    taxCents: number;
    tipCents: number;
  }

  export interface ReceiptComputeResult {
    participantIds: string[];                       // [ownerId, ...friendIds]
    itemSubtotalCents: Record<string, number>;
    taxShareCents: Record<string, number>;
    tipShareCents: Record<string, number>;
    totalPerParticipantCents: Record<string, number>;
    itemsTotalCents: number;
    receiptTotalCents: number;                       // items + tax + tip
    unassignedItemIds: string[];
  }

  export function computeReceiptShares(input: ReceiptComputeInput): ReceiptComputeResult { /* ... */ }
  export function toFriendShares(r: ReceiptComputeResult, ownerId: string): Record<string, number> { /* ... */ }
  ```

  **`distribute(totalCents: number, weights: number[]): number[]`** (internal helper, largest-remainder apportionment):
  - `weightSum = Σweights`. If `weightSum === 0`, return an all-zero array (callers decide the fallback — see tax's fallback below).
  - `exact_i = totalCents * weights_i / weightSum`; `base_i = Math.floor(exact_i)`; `rem = totalCents - Σbase_i`.
  - Sort indices by fractional part `exact_i - base_i` descending, tiebreak by **ascending index** (so ties favor the owner at index 0).
  - Add 1 cent to each of the first `rem` sorted indices.
  - Must handle negative `totalCents` without throwing (a malformed receipt shouldn't crash the app), and the result must always sum to exactly `totalCents`.

  **Item subtotals:** for each item with `k = assignees.length > 0`, run `distribute(item.priceCents, ones(k))` over the assignees normalized into `participantIds` order, and accumulate into `itemSubtotalCents`. Items with `k === 0` go into `unassignedItemIds` and contribute nothing. This guarantees `Σ itemSubtotalCents === Σ (assigned items' priceCents)`.

  **Tax:** `weights = participantIds.map(p => itemSubtotalCents[p] ?? 0)`; `taxShareCents = distribute(taxCents, weights)`. If `Σweights === 0` (nothing assigned yet), fall back to `distribute(taxCents, ones(participantIds.length))` so tax still has *somewhere* to go rather than vanishing.

  **Tip:** `tipShareCents = distribute(tipCents, ones(participantIds.length))` — always equal split, remainder cents land on the lowest indices (owner first).

  **Totals:** `totalPerParticipantCents[p] = itemSubtotalCents[p] + taxShareCents[p] + tipShareCents[p]`. Invariant, test-asserted: `Σ totalPerParticipantCents === itemsTotalCents + taxCents + tipCents === receiptTotalCents`.

  **`toFriendShares`:** returns `{ [friendId]: totalPerParticipantCents[friendId] / 100 }` for every id in `friendIds`, **excluding the owner** — this is the exact shape `ExpenseParams.friendShares` already expects in `mobile/lib/splitwise.ts`.

- [ ] **Gate:** `npm test -- receipt.test` green (all 11 cases); `npx tsc --noEmit` clean.

---

## Task 3: Worker route (`workers/src/receipt.ts`)

**Files:**
- Create: `workers/src/receipt.ts`
- Modify: `workers/src/index.ts`
- Modify: `workers/src/index.test.ts`

- [ ] **Step 1: Write the failing tests** in `workers/src/index.test.ts` (extend `makeEnv()` to include `GEMINI_API_KEY: 'test_gemini_key'`, and mock `fetch` for the Gemini call):
  - `POST /receipt/parse` without auth → 401 (existing `authenticate()` gate).
  - Missing `image_base64` in body → 400 `MISSING_IMAGE`.
  - `image_base64.length > 7_000_000` → 413 `IMAGE_TOO_LARGE`.
  - Unsupported `mime_type` (not in `image/jpeg|image/png|image/webp|image/heic`) → 400 `UNSUPPORTED_MIME_TYPE`.
  - `GEMINI_API_KEY` unset in env → 503 `RECEIPT_PARSE_UNAVAILABLE`.
  - Happy path: mock `fetch` to return a valid Gemini JSON response; assert the outbound request URL contains the configured model id, `x-goog-api-key` header is set, `generationConfig.responseMimeType === 'application/json'`, and the response is `200` with the normalized shape.
  - Gemini returns non-2xx → 502 `RECEIPT_PARSE_FAILED`.
  - Gemini candidate text is not valid JSON → 502 `RECEIPT_PARSE_FAILED` (must not be conflated with the existing top-level `SyntaxError` → 400 `INVALID_REQUEST_BODY` handler, which is for the *incoming* request body, not the Gemini response — wrap the Gemini-response `JSON.parse` in its own try/catch).
  - `fetch` rejects with an abort (simulate `AbortError`) → 502 `RECEIPT_PARSE_FAILED`.
  - `normalizeReceipt` unit tests (can live in the same file or a colocated one): `"$12.99"` → 1299 cents; `"1,234.50"` → 123450; `"abc"` → `null`; when `tax` is absent but `subtotal` and `total` both parse, tax is derived as `total - subtotal - tip`, clamped to `>= 0`; blank-name or unparseable-price item rows are dropped; more than 200 items is capped at 200.
- [ ] **Step 2: Implement** `workers/src/receipt.ts`:

  ```ts
  export interface ParsedItem { name: string; quantity: number; price_cents: number }
  export interface ParsedReceipt {
    merchant: string | null;
    items: ParsedItem[];
    subtotal_cents: number | null;
    tax_cents: number;
    tip_cents: number;
    total_cents: number | null;
  }
  ```

  `RECEIPT_SCHEMA` (Gemini `responseSchema`, OpenAPI-3.0 subset): **all money fields are `type: "string"`** (e.g. `"12.99"`), not `number` — a number-typed schema invites float artifacts like `12.989999999`; a string parsed by our own strict regex is deterministic.
  ```
  { merchant: string|null, currency: string|null,
    items: [{ name: string, quantity: integer|null, price: string }],   // price = LINE TOTAL, already × quantity
    subtotal: string|null, tax: string|null, tip: string|null, total: string|null }
  required: ["items"]
  ```
  System instruction / prompt: extract itemized line items only; `price` is the line total; exclude subtotal/tax/tip/total/discount/service-charge lines from `items`; return `null` for absent values rather than guessing; return an empty `items` array if the image isn't a receipt.

  `parseMoneyToCents(s: string | null): number | null` — exported, pure: trim; strip `$ € £ ,` and non-breaking spaces; allow a leading `-`; require `/^-?\d{1,7}(\.\d{1,2})?$/`; return `Math.round(parseFloat(s) * 100)`; else `null`.

  `normalizeReceipt(raw): ParsedReceipt` — exported, pure, never throws: drop items with unparseable price or blank name; cap at 200 items; `tax_cents` = parsed value, else derived from `total - subtotal - tip` (clamped `>= 0`) if both `subtotal` and `total` parse, else `0`; `tip_cents` = parsed value, else `0`.

  `callGemini(env, base64: string, mimeType: string)`: `POST https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent`, header `x-goog-api-key: ${env.GEMINI_API_KEY}`, body:
  ```json
  { "systemInstruction": {"parts":[{"text": PROMPT}]},
    "contents": [{"role":"user","parts":[{"inline_data":{"mime_type":"image/jpeg","data":"<base64>"}}]}],
    "generationConfig": {"responseMimeType":"application/json","responseSchema":RECEIPT_SCHEMA,"temperature":0} }
  ```
  with `signal: AbortSignal.timeout(20_000)`. **The base64 string must be forwarded verbatim — never decoded/re-encoded** (Cloudflare's CPU-time budget doesn't count time spent awaiting `fetch`, but would count a synchronous `atob`/re-encode of a few-hundred-KB string).

- [ ] **Step 3: Wire the route** in `workers/src/index.ts`: extend `Env` with `GEMINI_API_KEY: string; GEMINI_MODEL?: string`; add `handleReceiptParse(req, env)` implementing the validation/error-mapping above; add `else if (req.method === 'POST' && path === '/receipt/parse') res = await handleReceiptParse(req, env);` inside the existing `authenticate()`/`withCors()` wrapper, alongside the other routes.
- [ ] **Gate:** `cd workers && npm test` green.
- [ ] **Manual verification:** `wrangler dev` + `curl` with a real base64-encoded receipt photo against the live Gemini API, confirming the actual response shape matches what `normalizeReceipt` expects (model behavior can drift from documented examples).

---

## Task 4: Client transport & capture (`mobile/lib/receiptScan.ts`)

**Files:**
- Modify: `mobile/lib/worker.ts`
- Test: `mobile/__tests__/lib/worker.test.ts`
- Create: `mobile/lib/receiptScan.ts`
- Test: `mobile/__tests__/lib/receiptScan.test.ts`
- Create (conditional, see Step 4): `mobile/lib/receiptScan.web.ts`

This task carries the plan's single unverified runtime assumption (Step 4 below) — do the empirical check **before** starting any UI work in Tasks 5–6, so a fallback (if needed) doesn't require reworking components built on top of it.

- [ ] **Step 1: `mobile/lib/worker.ts`** — add, reusing the existing `post` helper (which already supplies the auth header and `WorkerError` mapping):
  ```ts
  export async function parseReceipt(image_base64: string, mime_type = 'image/jpeg'): Promise<ParsedReceipt> {
    return post('/receipt/parse', { image_base64, mime_type });
  }
  ```
  Add the matching `ParsedReceipt` type (mirror the Worker's shape; colocate in `mobile/lib/types.ts` or re-export from `worker.ts`, whichever matches this file's existing convention for shared response types).
- [ ] **Step 2: tests** in `mobile/__tests__/lib/worker.test.ts` — `parseReceipt` posts to `/receipt/parse` with the auth header set; a 502 response maps to `WorkerError('RECEIPT_PARSE_FAILED')`.
- [ ] **Step 3: `mobile/lib/receiptScan.ts`:**
  ```ts
  export type ReceiptScanOutcome =
    | { status: 'cancelled' }
    | { status: 'ok'; receipt: ParsedReceipt }
    | { status: 'failed'; reason: 'parse' | 'network' | 'image' };

  export async function scanReceipt(source: 'camera' | 'library'): Promise<ReceiptScanOutcome> { /* ... */ }
  ```
  Flow: if `source === 'camera'`, call `ImagePicker.requestCameraPermissionsAsync()` (resolves granted as a no-op on web); denied → `{status:'failed', reason:'image'}`. Call `launchCameraAsync`/`launchImageLibraryAsync` with `{ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1, allowsEditing: false, base64: false }` (quality 1 deliberately — web ignores the `quality` option entirely, so compression is handled uniformly in the next step instead). `result.canceled` → `{status:'cancelled'}`. Then `manipulateAsync(asset.uri, [{ resize: { width: 1600 } }], { compress: 0.7, format: SaveFormat.JPEG, base64: true })` — guard `if (asset.width && asset.width < 1600)` to skip the resize action (don't upscale a small image) while still running the format/compress/base64 normalization. A thrown error here → `{status:'failed', reason:'image'}`. Finally call `parseReceipt(base64, 'image/jpeg')`; a thrown `WorkerError`/network error → `{status:'failed', reason:'parse'}` or `'network'` as appropriate.
- [ ] **Step 4 (empirical, blocking):** Run `npm run web` and, with a throwaway test button, confirm `expo-image-manipulator`'s `manipulateAsync` accepts the `data:` URL returned by the web image picker and successfully returns a `base64` result. **If it does not**, create `mobile/lib/receiptScan.web.ts` implementing the same downscale via `Image` → `<canvas>` → `canvas.toDataURL('image/jpeg', 0.7)` (roughly 25 lines), matching `scanReceipt`'s exported signature exactly so no caller code changes.
- [ ] **Step 5: tests** in `mobile/__tests__/lib/receiptScan.test.ts`, mocking `expo-image-picker`, `expo-image-manipulator`, and `@/lib/worker`: cancelled picker; permission denied; manipulator throws → `failed/image`; worker call throws → `failed/parse`; happy path asserts the resize/compress options passed to the manipulator and that `parseReceipt` is called with the **manipulator's** base64 output, not the picker's raw asset.
- [ ] **Gate:** `npm test` green; `npx tsc --noEmit` clean; the Step 4 web smoke check has passed (with or without the `.web.ts` fallback).

---

## Task 5: UI components

**Files:**
- Create: `mobile/components/ReceiptItemRow.tsx`
- Create: `mobile/components/ReceiptCapture.tsx`
- Create: `mobile/components/ReceiptSummary.tsx`

All styling must come from `mobile/lib/theme.ts` (`Colors`, `Radius`, `Shadow`, `Spacing`, `merchantColor`) — no new color literals, matching the rest of this file's conventions.

- [ ] **`ReceiptCapture.tsx`:** Two `Pressable`s — "Take photo" (`camera-outline`) and "Choose photo" (`image-outline`) — plus a status line and a "Skip — enter items manually" link. On press of either photo option: caller sets `scanning`, calls `scanReceipt(source)`, and on `ok` seeds items (`{ id: generateId(), name, priceCents: price_cents, quantity, assignees: [] }` per parsed item) plus `taxCents`/`tipCents`, then advances to the `assign` stage with a toast like "Found N items — check them over"; on `failed`, clears items, still advances to `assign`, toasts "Couldn't read the receipt. Add items manually." (never blocks); on `cancelled`, stays put with no toast. Hide the camera button when `Platform.OS === 'web' && !navigator.mediaDevices` (desktop Chrome's `capture` attribute silently degrades to a plain file dialog, which would be a confusing duplicate of "Choose photo").
- [ ] **`ReceiptItemRow.tsx`:** a row of `[name input] [price input] [delete]`, then a wrapping (not horizontally-scrolling — see Task 6's layout note on why no nested scrollable) row of assignee chips: All, You, and each selected friend, plus a trailing "N sharing · $X.XX ea" hint. Name and price fields use the same local-state + commit-on-blur pattern as the existing `CustomRow` component in `FriendPickerSheet.tsx` (parse on blur, `Math.round(parsed*100)/100`, revert on invalid — this is what prevents a "typing resets to 0.00" bug). "All" toggles: pressed when every participant is already assigned, pressing it again clears to `[]`. Unassigned rows render with `Colors.errorLight` background and an "Assign someone" hint. Wrap the row in `memo()` keyed on `(item, participantIds)` so editing one item's name doesn't re-render every other row on a receipt with many lines.
- [ ] **`ReceiptSummary.tsx`:** "Items $X · Tax [$__] · Tip [$__]" with the same blur-commit input pattern (extraction is unreliable — these fields must be user-correctable); "Receipt total $X" vs "Charged $Y"; when they differ, the reconciliation line and toggle from Task 6's `useReceiptTotal` state (reuse `ownerCard`/`ownerCardError` styles for the over-budget presentation); a "Retake photo" link that returns to the `capture` stage without discarding existing items.
- [ ] **Gate:** `npx tsc --noEmit` clean. (Per this project's existing convention, RN sheet/component rendering itself is verified manually, not via jest — see Task 7 for what the integration test *does* cover.)

---

## Task 6: FriendPickerSheet integration

**Files:**
- Modify: `mobile/components/FriendPickerSheet.tsx`

- [ ] **Step 1: State.** Extend `type SplitMode = 'equal' | 'custom' | 'receipt';` add `type ReceiptStage = 'capture' | 'assign';` and:
  ```ts
  const [receiptStage, setReceiptStage] = useState<ReceiptStage>('capture');
  const [scanning, setScanning] = useState(false);
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [taxCents, setTaxCents] = useState(0);
  const [tipCents, setTipCents] = useState(0);
  const [useReceiptTotal, setUseReceiptTotal] = useState(false);
  const autoToggledRef = useRef(false);
  ```
  Reset all of these in the existing `openToken` effect (around line 81), alongside the current `setSelected`/`setCustomAmounts`/`setSplitMode` resets.
- [ ] **Step 2: Derived values.** Add, positioned **above** the `if (members.length === 0) return null;` bail-out (every hook must run unconditionally before that line, per the existing comment explaining why):
  ```ts
  const ownerId = user_id ?? OWNER_FALLBACK_ID;
  const friendIdsOrdered = useMemo(() => selectedFriends.map(f => f.id), [selectedFriends]);
  const receipt = useMemo(
    () => computeReceiptShares({ ownerId, friendIds: friendIdsOrdered, items, taxCents, tipCents }),
    [ownerId, friendIdsOrdered, items, taxCents, tipCents]
  );
  const receiptDeltaCents = Math.round(totalAmount * 100) - receipt.receiptTotalCents;
  const effectiveTotal = splitMode === 'receipt' && useReceiptTotal
    ? receipt.receiptTotalCents / 100
    : totalAmount;
  ```
- [ ] **Step 3: Rewire the existing `totalCents`/`friendTotalCents`/`ownerShareCents`/`isOverBudget`/`ctaDisabled` block** (around lines 158–172) to derive from `effectiveTotal` instead of `totalAmount`, with a third branch:
  ```ts
  const totalCents = Math.round(effectiveTotal * 100);
  const n = selected.size + 1;
  const equalShareCents = selected.size > 0 ? Math.floor(totalCents / n) : 0;
  const friendTotalCents =
    splitMode === 'receipt'
      ? friendIdsOrdered.reduce((s, id) => s + (receipt.totalPerParticipantCents[id] ?? 0), 0)
    : splitMode === 'custom'
      ? selectedFriends.reduce((sum, f) => sum + Math.round((customAmounts[f.id] ?? 0) * 100), 0)
      : equalShareCents * selected.size;
  const ownerShareCents = totalCents - friendTotalCents;
  const isOverBudget = ownerShareCents < -1;
  const receiptBlocked =
    splitMode === 'receipt' &&
    (receiptStage === 'capture' || scanning || items.length === 0 || receipt.unassignedItemIds.length > 0);
  const ctaDisabled = selected.size === 0 || submitting || isOverBudget || title.trim() === '' || receiptBlocked;
  ```
  Note this does **not** change `renderFooter`'s dependency array (`[ctaDisabled, submitting, mode, insets.bottom]`, around line 218) — it already depends on `ctaDisabled`, which now folds in the receipt terms, so the footer memo stays untouched.
- [ ] **Step 4: Reconciliation auto-toggle.** When `receipt.receiptTotalCents` changes and `receiptDeltaCents < -1` (receipt exceeds the charge) and `!autoToggledRef.current`, set `useReceiptTotal(true)` and `autoToggledRef.current = true`. This fires once; after that the user's manual toggle wins. Reset `autoToggledRef.current = false` in the same effect/reset block as Step 1 (each new open or scan should be able to auto-toggle again).
- [ ] **Step 5: Assignee pruning.** When the friend selection changes while items hold assignments, drop now-invalid assignee ids so nothing points at a deselected friend:
  ```ts
  useEffect(() => {
    const valid = new Set([ownerId, ...friendIdsOrdered]);
    setItems(prev => {
      let dirty = false;
      const next = prev.map(it => {
        const kept = it.assignees.filter(a => valid.has(a));
        if (kept.length === it.assignees.length) return it;
        dirty = true;
        return { ...it, assignees: kept };
      });
      return dirty ? next : prev;   // identity-stable when nothing changed, so `receipt`'s memo doesn't re-run needlessly
    });
  }, [ownerId, friendIdsOrdered]);
  ```
- [ ] **Step 6: `switchToReceipt()`**, mirroring the existing `switchToCustom()`: `setSplitMode('receipt'); setReceiptStage(items.length > 0 ? 'assign' : 'capture');` — items and assignments survive switching to Equal/Custom and back, so nothing is lost by tapping away.
- [ ] **Step 7: `handleAddToSplitwise` changes** — exactly two spots. The `shares` computation becomes:
  ```ts
  const shares =
    splitMode === 'receipt' ? { friendShares: toFriendShares(receipt, ownerId) }
    : splitMode === 'custom' ? { friendShares: customAmounts }
    : {};
  ```
  and every `amount: totalAmount` in both the `updateExpense` and `createExpense` call sites becomes `amount: effectiveTotal`. Nothing else in that function changes; `submitRef.current = handleAddToSplitwise` (existing pattern) keeps the footer's press handler pointed at the current closure without widening the footer's memo deps.
- [ ] **Step 8: Segmented control** — add a third "Receipt" button, rendered only when `selected.size > 0 && !isCombine` (receipt mode is unavailable for combined-transaction splits — a receipt is one physical purchase). Per decision (C), this is available in both `create` and `edit` mode.
- [ ] **Step 9: List branches.** `data` becomes `splitMode === 'equal' ? filtered : splitMode === 'custom' ? selectedFriends : items`. `renderItem` gets a third branch rendering `<ReceiptItemRow>`. `listHeader` gets a `receipt` branch: title block + segmented control + (`receiptStage === 'capture' ? <ReceiptCapture .../> : <ReceiptSummary .../>` + an "Add item" button + an "ITEMS" section label, when in `assign` stage). `ListEmptyComponent` gets a receipt branch (spinner while `scanning`, or an empty-state prompt). Add a `ListFooterComponent` for the assign stage showing a per-person breakdown strip — this is the FlatList's own footer prop, unrelated to and safely coexisting with the sheet's `footerComponent`. `keyExtractor` becomes `(x: { id: string }) => x.id`, which already works for both `SplitwiseFriend` and `ReceiptItem`.
- [ ] **Step 10 (layout constraint — do not violate):** No new `BottomSheetView`, no new nested scrollable, anywhere in the receipt branches. The single existing `BottomSheetFlatList` stays the direct child of `BottomSheetModal`, exactly as it is today. This project has a documented gorhom bottom-sheet bug (commit `74df33b`, and see project memory "gorhom BottomSheetView breaks flex layout") where `BottomSheetView` composes `{flex:1}` under a library style that overrides it with `position:'absolute'`, silently collapsing the scrollable's height and pushing the CTA off-screen. `ReceiptItemRow`'s assignee-chip row must wrap (`flexWrap:'wrap'`), not use a nested horizontal `ScrollView`, for the same reason (a `ScrollView` inside a `BottomSheetFlatList` row is also a gesture-handler hazard). Do not add a stage-dependent label to `renderFooter` — keep "Add to Splitwise" throughout receipt mode, disabled during `capture`; the capture-stage CTAs (Take photo / Choose photo / Skip) live in the header instead, where they can't scroll out of view.
- [ ] **Gate:** `npx tsc --noEmit` clean.

---

## Task 7: Integration tests

**Files:**
- Modify: `mobile/__tests__/components/FriendPickerSheet.test.tsx`

The existing bespoke `@gorhom/bottom-sheet` mock at the top of this file already renders `footerComponent`, making the CTA reachable in tests.

- [ ] Receipt segment button is absent until at least one friend is selected, and absent entirely when `combineTransactions` is passed (per decision on `isCombine`).
- [ ] Tapping Receipt enters the `capture` stage; tapping "Skip — enter manually" advances to `assign` with an empty item list.
- [ ] With `scanReceipt` mocked to return `{status:'failed', reason:'parse'}`, the sheet still lands on `assign` with zero items and does not throw or show an error state that blocks progress.
- [ ] Given one $30 item assigned to `[owner, friend2]`, $3 tax, $6 tip, and a $39 transaction total (equal to the receipt total, so no reconciliation divergence): pressing the CTA calls `createExpense` with `friendShares: { '<friend2 id>': 19.5 }` and `amount: 39`.
- [ ] An item with no assignees (`unassignedItemIds` non-empty) disables the CTA.
- [ ] When the receipt total exceeds the transaction amount, the reconciliation toggle auto-enables and `createExpense`/`updateExpense` is called with `amount` equal to the receipt total, not the original transaction amount.
- [ ] **Gate:** `npm test` (full suite, not just this file) green; `npx tsc --noEmit` clean.

---

## Task 8: Hardening & docs

**Files:**
- Modify: `workers/wrangler.toml`
- Modify: `README.md`

- [ ] Add rate limiting to `/receipt/parse`. `WORKER_API_KEY` is embedded in the web bundle (extractable from the PWA's JS by anyone), so without a limit this route is an open proxy to the Gemini quota — a pre-existing posture shared with the Plaid routes, but those require a valid `access_token` to do anything useful, whereas an unauthenticated-in-spirit receipt-parse call has value on its own. Pick one:
  - Zero-code: a Cloudflare dashboard WAF Rate Limiting rule on `/receipt/parse` (e.g. 20 req / 10 min / IP), configured directly in the Cloudflare dashboard (human operator, not agent-executable).
  - In-code: add a `ratelimit` binding in `wrangler.toml`:
    ```toml
    [[unsafe.bindings]]
    name = "RECEIPT_LIMITER"
    type = "ratelimit"
    namespace_id = "1001"
    simple = { limit = 20, period = 60 }
    ```
    then in `handleReceiptParse`: `await env.RECEIPT_LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'anon' })` → `429 RATE_LIMITED` when exceeded. Requires adding a `simple` mock to the `makeEnv()` test helper in `workers/src/index.test.ts`.
- [ ] Document `GEMINI_API_KEY` / `GEMINI_MODEL` in `README.md` alongside the existing worker secrets setup instructions.
- [ ] Manual verification matrix, web first (primary platform per the confirmed platform priority): PWA on iOS Safari (camera capture + installed-to-home-screen), PWA on desktop Chrome (file picker path), native iOS dev build (camera permission prompt copy renders correctly), native Android.

---

## Known risks (carried forward, not blocking, worth a glance during implementation)

1. Gemini model churn — `gemini-2.0-flash` was retired five months before this plan was written; `gemini-2.5-flash` is not guaranteed to outlive this feature. Mitigated by `GEMINI_MODEL` being an env var, not a hardcoded string.
2. Extraction quality on crumpled/thermal receipts will vary. The editable review step (Task 5's `ReceiptSummary`/`ReceiptItemRow`) is the load-bearing mitigation — do not let a "looks good, skip review" shortcut get added later.
3. `FriendPickerSheet.tsx` is ~850 lines before this change and will grow meaningfully. If it crosses roughly 1100 lines, extracting the receipt branch into a component that returns `{header, data, renderItem}` back to the parent is the natural cut — but it must not introduce a second scrollable or a `BottomSheetView` wrapper (see Task 6, Step 10).
4. HEIC: iOS Safari's photo library can hand back `image/heic`. `manipulateAsync` normalizes output to JPEG, so the Worker should always receive `image/jpeg` in practice — the Worker's mime allowlist includes HEIC defensively in case the manipulator step is ever bypassed.
5. Currency is extracted by Gemini but not currently used — the expense still uses `members[0].currency`, consistent with today's USD-only Plaid setup.
