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
  description?: string;          // custom title; falls back to merchant_name for display
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

// A row in the History list. A combined split (multiple transactions sharing one
// Splitwise expense) collapses into a single item with `combined` populated.
export interface HistoryItem {
  id: string;                 // transaction id for single rows; expense id for combined rows
  merchant_name: string;      // display title (description ?? merchant_name)
  amount: number;             // total (summed across members for combined rows)
  currency: string;           // from the (first) member transaction
  date: string;
  status: TransactionStatus;
  split?: { friend_names: string[]; amount_each: number };
  combined?: { expense_id: string; transaction_ids: string[]; count: number };
}
