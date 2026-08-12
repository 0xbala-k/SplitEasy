export interface ParsedItem { name: string; quantity: number; price_cents: number }
export interface ParsedReceipt {
  merchant: string | null;
  items: ParsedItem[];
  subtotal_cents: number | null;
  tax_cents: number;
  tip_cents: number;
  total_cents: number | null;
}

// Raw shape returned by Gemini per RECEIPT_SCHEMA — all money fields are
// strings (e.g. "12.99") so we control rounding ourselves instead of trusting
// float-typed JSON output.
interface RawReceiptItem {
  name?: unknown;
  quantity?: unknown;
  price?: unknown;
}
interface RawReceipt {
  merchant?: unknown;
  currency?: unknown;
  items?: unknown;
  subtotal?: unknown;
  tax?: unknown;
  tip?: unknown;
  total?: unknown;
}

const MAX_ITEMS = 200;

// OpenAPI-3.0 subset schema passed to Gemini's responseSchema. Money fields
// are deliberately typed as strings — a number-typed schema invites float
// artifacts like 12.989999999; a string parsed by our own strict regex is
// deterministic.
export const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: 'string', nullable: true },
    currency: { type: 'string', nullable: true },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'integer', nullable: true },
          price: { type: 'string' },
        },
        required: ['name', 'price'],
      },
    },
    subtotal: { type: 'string', nullable: true },
    tax: { type: 'string', nullable: true },
    tip: { type: 'string', nullable: true },
    total: { type: 'string', nullable: true },
  },
  required: ['items'],
} as const;

export const RECEIPT_PROMPT =
  'You are extracting structured data from a photo of a receipt. Extract only ' +
  'the itemized line items — do not include subtotal, tax, tip, discount, or ' +
  'service-charge lines in the items array. For each item, "price" is the ' +
  'LINE TOTAL for that item (already multiplied by quantity, not the per-unit ' +
  'price). If a value is not present on the receipt, return null for it rather ' +
  'than guessing. If the image is not a receipt, return an empty items array.';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export function parseMoneyToCents(s: string | null | undefined): number | null {
  if (typeof s !== 'string') return null;
  const cleaned = s
    .trim()
    .replace(/[\s ]/g, '')
    .replace(/[$€£,]/g, '');
  if (!/^-?\d{1,7}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function normalizeReceipt(raw: unknown): ParsedReceipt {
  const r = (raw && typeof raw === 'object' ? raw : {}) as RawReceipt;

  const merchant = typeof r.merchant === 'string' ? r.merchant : null;

  const rawItems = Array.isArray(r.items) ? r.items : [];
  const items: ParsedItem[] = [];
  for (const entry of rawItems) {
    if (items.length >= MAX_ITEMS) break;
    if (!entry || typeof entry !== 'object') continue;
    const it = entry as RawReceiptItem;
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name) continue;
    const priceCents = parseMoneyToCents(typeof it.price === 'string' ? it.price : null);
    if (priceCents === null) continue;
    const quantity = typeof it.quantity === 'number' && Number.isFinite(it.quantity) ? it.quantity : 1;
    items.push({ name, quantity, price_cents: priceCents });
  }

  const subtotalCents = parseMoneyToCents(typeof r.subtotal === 'string' ? r.subtotal : null);
  const totalCents = parseMoneyToCents(typeof r.total === 'string' ? r.total : null);
  const parsedTip = parseMoneyToCents(typeof r.tip === 'string' ? r.tip : null);
  const tipCents = parsedTip ?? 0;

  const parsedTax = parseMoneyToCents(typeof r.tax === 'string' ? r.tax : null);
  let taxCents: number;
  if (parsedTax !== null) {
    taxCents = parsedTax;
  } else if (subtotalCents !== null && totalCents !== null) {
    taxCents = Math.max(0, totalCents - subtotalCents - tipCents);
  } else {
    taxCents = 0;
  }

  return {
    merchant,
    items,
    subtotal_cents: subtotalCents,
    tax_cents: taxCents,
    tip_cents: tipCents,
    total_cents: totalCents,
  };
}

export interface GeminiEnv {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
}

// Calls the Gemini generateContent API with the receipt image, verbatim.
// The base64 string must never be decoded/re-encoded here — Cloudflare
// Workers bill CPU time, and a synchronous re-encode of a few-hundred-KB
// string would cost real CPU budget for no reason (awaiting fetch does not).
export async function callGemini(env: GeminiEnv, base64: string, mimeType: string): Promise<Response> {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `${GEMINI_ENDPOINT}/v1beta/models/${model}:generateContent`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: RECEIPT_PROMPT }] },
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: base64 } }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RECEIPT_SCHEMA,
        temperature: 0,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
}
