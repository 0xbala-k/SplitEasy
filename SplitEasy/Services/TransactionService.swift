import Foundation
import Supabase

final class TransactionService {
    private let client: SupabaseClient = SupabaseService.shared.client

    // Fetch all "new" transactions for the current user
    func fetchNew() async throws -> [Transaction] {
        try await client
            .from("transactions")
            .select()
            .eq("status", value: "new")
            .order("date", ascending: false)
            .execute()
            .value
    }

    // Fetch history (split + skipped) with cursor-based pagination
    // cursor: (date, id) of last row from previous page
    func fetchHistory(cursor: (date: String, id: UUID)? = nil, limit: Int = 50) async throws -> [Transaction] {
        // .or() must be called on PostgrestFilterBuilder (before .order/.limit),
        // so we branch early to keep the filter chain types correct.
        if let cursor {
            // Rows where (date < cursor.date) OR (date == cursor.date AND id > cursor.id)
            return try await client
                .from("transactions")
                .select()
                .in("status", values: ["split", "skipped"])
                .or("date.lt.\(cursor.date),and(date.eq.\(cursor.date),id.gt.\(cursor.id))")
                .order("date", ascending: false)
                .order("id", ascending: true)
                .limit(limit)
                .execute()
                .value
        } else {
            return try await client
                .from("transactions")
                .select()
                .in("status", values: ["split", "skipped"])
                .order("date", ascending: false)
                .order("id", ascending: true)
                .limit(limit)
                .execute()
                .value
        }
    }

    // Mark a transaction as skipped (direct client update, RLS permits this)
    func skip(transactionId: UUID) async throws {
        try await client
            .from("transactions")
            .update(["status": "skipped"])
            .eq("id", value: transactionId.uuidString)
            .execute()
    }

    // Subscribe to new transactions via Realtime
    func subscribeToNew(onChange: @escaping ([Transaction]) -> Void) -> RealtimeChannelV2 {
        let channel = client.realtimeV2.channel("transactions:new")
        let changes = channel.postgresChange(
            InsertAction.self,
            schema: "public",
            table: "transactions",
            filter: "status=eq.new"
        )
        Task {
            // Subscribe first so we don't miss events between channel setup and subscription
            try? await channel.subscribeWithError()
            for await _ in changes {
                if let transactions = try? await fetchNew() {
                    await MainActor.run { onChange(transactions) }
                }
            }
        }
        return channel
    }
}
