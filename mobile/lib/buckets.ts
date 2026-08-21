// mobile/lib/buckets.ts
//
// Where a transaction's money goes. Pure and dependency-free: no database, no
// network, no dates. Everything here is a table lookup or string munging, which
// keeps the routing rules cheap to test exhaustively and safe to call on every
// render of a transaction tile.

export type Bucket = 'travel' | 'needs' | 'food' | 'shopping' | 'experiences' | 'misc';
export type BucketGroup = 'travel' | 'needs' | 'wants' | 'misc';

// Which rule in resolveBucket produced a bucket. Drives the chip's lock state
// and lets the Spending tab report how much of a month is still a guess.
export type BucketSource = 'auto' | 'manual' | 'vacation';

export const BUCKETS: Bucket[] = ['travel', 'needs', 'food', 'shopping', 'experiences', 'misc'];

// `misc` is deliberately its own top-level group rather than a member of
// `wants`: unclassified spend must not inflate the wants number and distort
// the needs-vs-wants ratio the whole tracker exists to show.
export const BUCKET_GROUP: Record<Bucket, BucketGroup> = {
  travel: 'travel',
  needs: 'needs',
  food: 'wants',
  shopping: 'wants',
  experiences: 'wants',
  misc: 'misc',
};

export const GROUP_BUCKETS: Record<BucketGroup, Bucket[]> = {
  travel: ['travel'],
  needs: ['needs'],
  wants: ['food', 'shopping', 'experiences'],
  misc: ['misc'],
};

export const BUCKET_LABEL: Record<Bucket, string> = {
  travel: 'Travel',
  needs: 'Needs',
  food: 'Food',
  shopping: 'Shopping',
  experiences: 'Experiences',
  misc: 'Misc',
};

export const GROUP_LABEL: Record<BucketGroup, string> = {
  travel: 'Travel',
  needs: 'Needs',
  wants: 'Wants',
  misc: 'Misc',
};

// Plaid's personal_finance_category.detailed → bucket.
//
// The interesting entries are the ones where the detailed value disagrees with
// its own primary: groceries are a need while the rest of FOOD_AND_DRINK is a
// want, and everyday transportation is a need while TRAVEL_* is a trip.
export const PFC_DETAILED_TO_BUCKET: Record<string, Bucket> = {
  FOOD_AND_DRINK_GROCERIES: 'needs',
  FOOD_AND_DRINK_RESTAURANT: 'food',
  FOOD_AND_DRINK_FAST_FOOD: 'food',
  FOOD_AND_DRINK_COFFEE: 'food',
  FOOD_AND_DRINK_ALCOHOL_AND_BARS: 'food',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'food',
  FOOD_AND_DRINK_VENDING_MACHINES: 'food',
  FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK: 'food',

  TRANSPORTATION_GAS: 'needs',
  TRANSPORTATION_PARKING: 'needs',
  TRANSPORTATION_PUBLIC_TRANSIT: 'needs',
  TRANSPORTATION_TOLLS: 'needs',
  TRANSPORTATION_BIKES_AND_SCOOTERS: 'needs',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'needs',
  TRANSPORTATION_OTHER_TRANSPORTATION: 'needs',

  RENT_AND_UTILITIES_RENT: 'needs',
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'needs',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'needs',
  RENT_AND_UTILITIES_TELEPHONE: 'needs',
  RENT_AND_UTILITIES_WATER: 'needs',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE: 'needs',
  RENT_AND_UTILITIES_OTHER_UTILITIES: 'needs',

  LOAN_PAYMENTS_CAR_PAYMENT: 'needs',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'needs',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'needs',
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: 'needs',
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT: 'needs',
  LOAN_PAYMENTS_OTHER_PAYMENT: 'needs',

  BANK_FEES_ATM_FEES: 'needs',
  BANK_FEES_FOREIGN_TRANSACTION_FEES: 'needs',
  BANK_FEES_INSUFFICIENT_FUNDS: 'needs',
  BANK_FEES_INTEREST_CHARGE: 'needs',
  BANK_FEES_OVERDRAFT_FEES: 'needs',
  BANK_FEES_OTHER_BANK_FEES: 'needs',

  GENERAL_SERVICES_INSURANCE: 'needs',
  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING: 'needs',
  GENERAL_SERVICES_AUTOMOTIVE: 'needs',
  GENERAL_SERVICES_CHILDCARE: 'needs',
  GENERAL_SERVICES_EDUCATION: 'needs',
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: 'needs',
  GENERAL_SERVICES_STORAGE: 'needs',
  GENERAL_SERVICES_OTHER_GENERAL_SERVICES: 'needs',

  MEDICAL_PRIMARY_CARE: 'needs',
  MEDICAL_DENTAL_CARE: 'needs',
  MEDICAL_EYE_CARE: 'needs',
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'needs',
  MEDICAL_VETERINARY_SERVICES: 'needs',
  MEDICAL_NURSING_CARE: 'needs',
  MEDICAL_OTHER_MEDICAL: 'needs',

  HOME_IMPROVEMENT_HARDWARE: 'needs',
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: 'needs',
  HOME_IMPROVEMENT_SECURITY: 'needs',
  HOME_IMPROVEMENT_FURNITURE: 'shopping',
  HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT: 'needs',

  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'shopping',
  GENERAL_MERCHANDISE_ELECTRONICS: 'shopping',
  GENERAL_MERCHANDISE_SPORTING_GOODS: 'shopping',
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: 'shopping',
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: 'shopping',
  GENERAL_MERCHANDISE_DISCOUNT_STORES: 'shopping',
  GENERAL_MERCHANDISE_SUPERSTORES: 'shopping',
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: 'shopping',
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES: 'shopping',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'shopping',
  GENERAL_MERCHANDISE_TOBACCO_AND_VAPE: 'shopping',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'needs',
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: 'needs',
  GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE: 'shopping',

  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'needs',
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: 'needs',
  PERSONAL_CARE_HAIR_AND_BEAUTY: 'shopping',
  PERSONAL_CARE_OTHER_PERSONAL_CARE: 'shopping',

  ENTERTAINMENT_CASINOS_AND_GAMBLING: 'experiences',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'experiences',
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: 'experiences',
  ENTERTAINMENT_TV_AND_MOVIES: 'experiences',
  ENTERTAINMENT_VIDEO_GAMES: 'experiences',
  ENTERTAINMENT_OTHER_ENTERTAINMENT: 'experiences',

  TRAVEL_FLIGHTS: 'travel',
  TRAVEL_LODGING: 'travel',
  TRAVEL_RENTAL_CARS: 'travel',
  TRAVEL_PUBLIC_TRANSIT: 'travel',
  TRAVEL_TAXIS_AND_RIDE_SHARES: 'travel',
  TRAVEL_PARKING: 'travel',
  TRAVEL_GAS: 'travel',
  TRAVEL_OTHER_TRAVEL: 'travel',
};

// Coarse fallback for detailed values Plaid adds after this table was written.
export const PFC_PRIMARY_TO_BUCKET: Record<string, Bucket> = {
  FOOD_AND_DRINK: 'food',
  TRANSPORTATION: 'needs',
  RENT_AND_UTILITIES: 'needs',
  LOAN_PAYMENTS: 'needs',
  BANK_FEES: 'needs',
  MEDICAL: 'needs',
  GENERAL_SERVICES: 'needs',
  HOME_IMPROVEMENT: 'needs',
  GENERAL_MERCHANDISE: 'shopping',
  PERSONAL_CARE: 'shopping',
  ENTERTAINMENT: 'experiences',
  TRAVEL: 'travel',
  GOVERNMENT_AND_NON_PROFIT: 'misc',
};

// Longest-first so a future primary that is a prefix of another still resolves
// to the more specific one.
const PRIMARIES = Object.keys(PFC_PRIMARY_TO_BUCKET).sort((a, b) => b.length - a.length);

/** The primary category a detailed Plaid category belongs to, or null. */
export function primaryOf(detailed: string | null | undefined): string | null {
  if (!detailed) return null;
  return PRIMARIES.find((p) => detailed === p || detailed.startsWith(`${p}_`)) ?? null;
}

// Last-resort routing by merchant name. This exists for two populations that
// have no stored Plaid category: transactions already sitting in the
// Transactions tab when this feature ships, and any institution whose feed
// omits personal_finance_category. Scanned in order, first match wins.
export const MERCHANT_KEYWORDS: [string, Bucket][] = [
  ['whole foods', 'needs'], ['trader joe', 'needs'], ['safeway', 'needs'],
  ['costco', 'needs'], ['kroger', 'needs'], ['aldi', 'needs'], ['publix', 'needs'],
  ['grocery', 'needs'], ['market', 'needs'],
  ['shell', 'needs'], ['chevron', 'needs'], ['exxon', 'needs'], ['mobil', 'needs'],
  ['arco', 'needs'], ['gas', 'needs'],
  ['geico', 'needs'], ['progressive', 'needs'], ['state farm', 'needs'],
  ['insurance', 'needs'], ['comcast', 'needs'], ['xfinity', 'needs'],
  ['verizon', 'needs'], ['t mobile', 'needs'], ['at t', 'needs'],
  ['rent', 'needs'], ['pharmacy', 'needs'], ['cvs', 'needs'], ['walgreens', 'needs'],

  ['starbucks', 'food'], ['chipotle', 'food'], ['mcdonald', 'food'],
  ['doordash', 'food'], ['uber eats', 'food'], ['grubhub', 'food'],
  ['postmates', 'food'], ['restaurant', 'food'], ['pizza', 'food'],
  ['coffee', 'food'], ['cafe', 'food'], ['brewing', 'food'], ['taqueria', 'food'],

  ['amazon', 'shopping'], ['amzn', 'shopping'], ['target', 'shopping'],
  ['walmart', 'shopping'], ['best buy', 'shopping'], ['apple store', 'shopping'],
  ['nike', 'shopping'], ['revzilla', 'shopping'], ['cycle gear', 'shopping'],
  ['etsy', 'shopping'], ['ebay', 'shopping'], ['ikea', 'shopping'],

  ['amc', 'experiences'], ['cinemark', 'experiences'], ['regal', 'experiences'],
  ['steam', 'experiences'], ['playstation', 'experiences'], ['xbox', 'experiences'],
  ['nintendo', 'experiences'], ['ticketmaster', 'experiences'],
  ['stubhub', 'experiences'], ['eventbrite', 'experiences'],
  ['museum', 'experiences'], ['netflix', 'experiences'], ['spotify', 'experiences'],

  ['airlines', 'travel'], ['airbnb', 'travel'], ['marriott', 'travel'],
  ['hilton', 'travel'], ['hyatt', 'travel'], ['expedia', 'travel'],
  ['booking com', 'travel'], ['hotel', 'travel'],
];

// Word-boundary match against the normalized name, so "rent" does not fire on
// "parent" and "gas" does not fire on "gaslight".
function matchesKeyword(normalized: string, keyword: string): boolean {
  if (!normalized) return false;
  return normalized === keyword
    || normalized.startsWith(`${keyword} `)
    || normalized.endsWith(` ${keyword}`)
    || normalized.includes(` ${keyword} `);
}

/**
 * A merchant name reduced to a stable memory key: lowercased, punctuation
 * flattened to spaces, standalone digit groups dropped. "STARBUCKS #4471" and
 * "Starbucks" both become "starbucks", so re-tagging one teaches the app about
 * every branch.
 */
export function normalizeMerchant(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BucketInput {
  merchant_name: string | null;
  plaid_category?: string | null;
  bucket?: Bucket | null;
  vacation_id?: string | null;
}

export interface ResolvedBucket {
  bucket: Bucket;
  source: BucketSource;
}

/**
 * The bucket a transaction belongs in, and which rule decided it.
 *
 * Precedence, highest first:
 *   1. it belongs to a vacation        → travel (locked)
 *   2. it already carries a bucket     → that value
 *   3. the merchant has been re-tagged → the learned bucket
 *   4. Plaid's detailed category
 *   5. Plaid's primary category
 *   6. a merchant-name keyword
 *   7. misc
 *
 * Rules 1 and 2 are why the commit path needs no special-casing: calling this
 * on an already-tagged or vacation-bound transaction returns it unchanged.
 */
export function resolveBucket(
  tx: BucketInput,
  memory: Record<string, Bucket> = {}
): ResolvedBucket {
  if (tx.vacation_id) return { bucket: 'travel', source: 'vacation' };
  if (tx.bucket) return { bucket: tx.bucket, source: 'manual' };

  const key = normalizeMerchant(tx.merchant_name);
  const remembered = key ? memory[key] : undefined;
  if (remembered) return { bucket: remembered, source: 'manual' };

  const detailed = tx.plaid_category ?? null;
  const byDetailed = detailed ? PFC_DETAILED_TO_BUCKET[detailed] : undefined;
  if (byDetailed) return { bucket: byDetailed, source: 'auto' };

  const primary = primaryOf(detailed);
  const byPrimary = primary ? PFC_PRIMARY_TO_BUCKET[primary] : undefined;
  if (byPrimary) return { bucket: byPrimary, source: 'auto' };

  for (const [keyword, bucket] of MERCHANT_KEYWORDS) {
    if (matchesKeyword(key, keyword)) return { bucket, source: 'auto' };
  }

  return { bucket: 'misc', source: 'auto' };
}
