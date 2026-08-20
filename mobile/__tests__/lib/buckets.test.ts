import {
  normalizeMerchant, primaryOf, resolveBucket, BUCKET_GROUP, GROUP_BUCKETS, BUCKETS,
} from '@/lib/buckets';

describe('normalizeMerchant', () => {
  it('lowercases, strips punctuation, and drops store numbers', () => {
    expect(normalizeMerchant('STARBUCKS #4471')).toBe('starbucks');
    expect(normalizeMerchant('Starbucks')).toBe('starbucks');
    expect(normalizeMerchant("Trader Joe's  ")).toBe('trader joe s');
  });

  it('returns empty string for null or blank', () => {
    expect(normalizeMerchant(null)).toBe('');
    expect(normalizeMerchant(undefined)).toBe('');
    expect(normalizeMerchant('   ')).toBe('');
  });
});

describe('primaryOf', () => {
  it('extracts the primary category from a detailed one', () => {
    expect(primaryOf('FOOD_AND_DRINK_GROCERIES')).toBe('FOOD_AND_DRINK');
    expect(primaryOf('TRANSPORTATION_GAS')).toBe('TRANSPORTATION');
    expect(primaryOf('TRAVEL_FLIGHTS')).toBe('TRAVEL');
  });

  it('returns null for unknown or missing input', () => {
    expect(primaryOf('WHATEVER_ELSE')).toBeNull();
    expect(primaryOf(null)).toBeNull();
  });
});

describe('BUCKET_GROUP', () => {
  it('puts only food/shopping/experiences under wants', () => {
    expect(BUCKET_GROUP.food).toBe('wants');
    expect(BUCKET_GROUP.shopping).toBe('wants');
    expect(BUCKET_GROUP.experiences).toBe('wants');
    expect(BUCKET_GROUP.travel).toBe('travel');
    expect(BUCKET_GROUP.needs).toBe('needs');
    // misc is top-level, NOT under wants
    expect(BUCKET_GROUP.misc).toBe('misc');
  });

  it('GROUP_BUCKETS is the exact inverse of BUCKET_GROUP', () => {
    const flattened = Object.values(GROUP_BUCKETS).flat().sort();
    expect(flattened).toEqual([...BUCKETS].sort());
    for (const [group, buckets] of Object.entries(GROUP_BUCKETS)) {
      for (const b of buckets) expect(BUCKET_GROUP[b]).toBe(group);
    }
  });
});

describe('resolveBucket precedence', () => {
  const base = { merchant_name: 'Starbucks', plaid_category: 'FOOD_AND_DRINK_COFFEE' };

  it('rule 1: a vacation beats everything, including a manual tag', () => {
    expect(resolveBucket({ ...base, vacation_id: 'v1', bucket: 'shopping' }))
      .toEqual({ bucket: 'travel', source: 'vacation' });
  });

  it('rule 2: an existing manual bucket beats merchant memory and Plaid', () => {
    expect(resolveBucket({ ...base, bucket: 'needs' }, { starbucks: 'shopping' }))
      .toEqual({ bucket: 'needs', source: 'manual' });
  });

  it('rule 3: merchant memory beats the Plaid category', () => {
    expect(resolveBucket(base, { starbucks: 'needs' }))
      .toEqual({ bucket: 'needs', source: 'manual' });
  });

  it('rule 4: the detailed Plaid category wins over the primary fallback', () => {
    // GROCERIES is a need even though FOOD_AND_DRINK maps to food
    expect(resolveBucket({ merchant_name: 'Safeway', plaid_category: 'FOOD_AND_DRINK_GROCERIES' }))
      .toEqual({ bucket: 'needs', source: 'auto' });
  });

  it('rule 5: falls back to the primary category for an unknown detailed one', () => {
    expect(resolveBucket({ merchant_name: 'Odd Diner', plaid_category: 'FOOD_AND_DRINK_SOMETHING_NEW' }))
      .toEqual({ bucket: 'food', source: 'auto' });
  });

  it('rule 6: falls back to merchant keywords when there is no Plaid category', () => {
    expect(resolveBucket({ merchant_name: 'WHOLE FOODS MKT #123', plaid_category: null }))
      .toEqual({ bucket: 'needs', source: 'auto' });
    expect(resolveBucket({ merchant_name: 'AMC Theatres', plaid_category: null }))
      .toEqual({ bucket: 'experiences', source: 'auto' });
  });

  it('keyword matching respects word boundaries', () => {
    // "rent" must not match inside "Parent Teacher Store"
    expect(resolveBucket({ merchant_name: 'Parent Teacher Store', plaid_category: null }).bucket)
      .not.toBe('needs');
  });

  it('rule 7: falls through to misc', () => {
    expect(resolveBucket({ merchant_name: 'Zzyzx Unknown Co', plaid_category: null }))
      .toEqual({ bucket: 'misc', source: 'auto' });
  });

  it('always returns a bucket in BUCKETS', () => {
    for (const name of ['', 'x', 'Shell Oil', 'Chipotle', 'Amazon', 'Netflix']) {
      expect(BUCKETS).toContain(resolveBucket({ merchant_name: name }).bucket);
    }
  });
});
