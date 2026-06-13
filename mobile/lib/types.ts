// mobile/lib/types.ts

export type TransactionStatus = 'new' | 'split' | 'skipped';

export interface Transaction {
  id: string;            // Plaid transaction_id
  merchant_name: string;
  amount: number;        // always positive (debits only)
  currency: string;
  date: string;          // ISO-8601 date e.g. "2026-04-15"
  status: TransactionStatus;
  pending: boolean;
  created_at: string;    // ISO-8601 datetime; used for 6-month prune
}

export interface SplitDecision {
  id: string;                    // locally generated UUID
  transaction_id: string;
  splitwise_expense_id: string;  // idempotency key
  friend_ids: string[];          // stored as JSON in DB; parsed on read
  friend_names: string[];        // same order as friend_ids; for offline display
  amount_each: number;
  created_at: string;
}

export interface TransactionWithSplit extends Transaction {
  split?: Pick<SplitDecision, 'friend_names' | 'amount_each'>;
}

export interface SplitwiseFriend {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

// Raw Plaid transaction shape from the Worker response
export interface PlaidTransaction {
  transaction_id: string;
  merchant_name: string | null;
  name: string;           // fallback display name
  amount: number;         // always > 0 after Worker filters credits
  iso_currency_code: string | null;
  date: string;
  pending: boolean;
}

export interface PlaidTransactionsResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}

export interface SplitwiseAuthResponse {
  access_token: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
}
