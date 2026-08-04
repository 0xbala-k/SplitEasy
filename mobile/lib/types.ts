// mobile/lib/types.ts

export type TransactionStatus = 'new' | 'split' | 'skipped';

export type ReviewReason = 'amount_changed' | 'reversed';

// Outcome of rekeying a pending transaction's row onto its posted Plaid id.
// 'conflict' = another transaction already occupies the posted id and holds its
// own Splitwise expense; both rows are left untouched rather than clobbered.
export type RekeyResult = 'unchanged' | 'changed' | 'not_found' | 'conflict';

export interface Transaction {
  id: string;            // Plaid transaction_id
  merchant_name: string;
  amount: number;        // always positive (debits only)
  currency: string;
  date: string;          // ISO-8601 date e.g. "2026-04-15"
  status: TransactionStatus;
  pending: boolean;
  created_at: string;    // ISO-8601 datetime; used for 6-month prune
  vacation_id?: string | null; // set while assigned to a vacation
  review_reason?: ReviewReason | null; // set when a pending→posted transition needs user attention
  amount_changed_from?: number | null; // previous amount, for "was $X → now $Y"; set alongside review_reason='amount_changed'
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
  // When Plaid transitions a pending transaction to posted, the posted
  // transaction carries a new transaction_id and points back at the old
  // (now-removed) pending id here. Used to rekey the local row instead of
  // treating the posted transaction as brand new.
  pending_transaction_id?: string | null;
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

// A row in the "Needs review" queue: a transaction whose pending→posted
// transition needs user attention (amount changed, or the pending charge was
// reversed and never posted). A combined split's members collapse into a
// single row keyed by the shared Splitwise expense, same as HistoryItem.
export interface ReviewItem {
  id: string;                  // tx id for single rows; expense id for combined
  merchant_name: string;
  amount: number;              // new total (summed for combined)
  amount_changed_from: number | null;  // old total (summed for combined)
  currency: string;
  date: string;
  reason: ReviewReason;
  split: { friend_names: string[]; amount_each: number };
  expense_id: string;
  transaction_ids: string[];   // 1 entry for single, N for combined
}

export type VacationStatus = 'draft' | 'active' | 'ended';

export interface Vacation {
  id: string;
  name: string;
  start_date: string | null;   // ISO-8601 date "YYYY-MM-DD"
  end_date: string | null;
  status: VacationStatus;
  splitwise_group_id: string | null;
  splitwise_group_name: string | null;
  splitwise_group_member_ids: string[] | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface CreateVacationInput {
  name: string;
  start_date?: string | null;
  end_date?: string | null;
  splitwise_group_id?: string | null;
  splitwise_group_name?: string | null;
  splitwise_group_member_ids?: string[] | null;
}

export interface SplitwiseGroup {
  id: string;
  name: string;
  member_ids: string[];
  member_names: string[];
}
