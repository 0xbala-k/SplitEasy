import Foundation
import Supabase

final class TransactionService {
    private let client = SupabaseService.shared.client

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
        var query = client
            .from("transactions")
            .select()
            .in("status", values: ["split", "skipped"])
            .order("date", ascending: false)
            .order("id", ascending: true)
            .limit(limit)

        if let cursor {
            // Rows where (date < cursor.date) OR (date == cursor.date AND id > cursor.id)
            query = query.or("date.lt.\(cursor.date),and(date.eq.\(cursor.date),id.gt.\(cursor.id))")
        }

        return try await query.execute().value
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
            for await _ in changes {
                if let transactions = try? await fetchNew() {
                    await MainActor.run { onChange(transactions) }
                }
            }
        }
        Task { await channel.subscribe() }
        return channel
    }
}
