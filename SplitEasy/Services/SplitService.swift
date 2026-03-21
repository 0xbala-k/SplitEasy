import Foundation

struct SplitResult {
    let splitwiseExpenseId: String
    let amountEach: Decimal
}

final class SplitService {
    func createExpense(transactionId: UUID, friendIds: [String]) async throws -> SplitResult {
        struct Response: Codable {
            let splitwiseExpenseId: String
            let amountEach: String
            enum CodingKeys: String, CodingKey {
                case splitwiseExpenseId = "splitwise_expense_id"
                case amountEach = "amount_each"
            }
        }
        let data = try await SupabaseService.shared.client.functions.invoke(
            "splitwise-create-expense",
            options: .init(body: [
                "transaction_id": transactionId.uuidString,
                "friend_ids": friendIds
            ])
        )
        let response = try JSONDecoder().decode(Response.self, from: data)
        return SplitResult(
            splitwiseExpenseId: response.splitwiseExpenseId,
            amountEach: Decimal(string: response.amountEach) ?? 0
        )
    }
}
