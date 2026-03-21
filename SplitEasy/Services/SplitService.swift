import Foundation

struct SplitResult {
    let splitwiseExpenseId: String
    let amountEach: Decimal
}

final class SplitService {
    func createExpense(transactionId: UUID, friendIds: [String]) async throws -> SplitResult {
        struct RequestBody: Encodable {
            let transaction_id: String
            let friend_ids: [String]
        }
        struct Response: Decodable {
            let splitwiseExpenseId: String
            let amountEach: Decimal
            enum CodingKeys: String, CodingKey {
                case splitwiseExpenseId = "splitwise_expense_id"
                case amountEach = "amount_each"
            }
        }
        let response: Response = try await SupabaseService.shared.client.functions.invoke(
            "splitwise-create-expense",
            options: .init(body: RequestBody(
                transaction_id: transactionId.uuidString,
                friend_ids: friendIds
            ))
        )
        return SplitResult(
            splitwiseExpenseId: response.splitwiseExpenseId,
            amountEach: response.amountEach
        )
    }
}
