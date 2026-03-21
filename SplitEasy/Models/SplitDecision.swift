import Foundation

struct SplitDecision: Codable, Identifiable {
    let id: UUID
    let transactionId: UUID
    let splitwiseExpenseId: String
    let friendIds: [String]
    let equalAmountEach: Decimal?

    enum CodingKeys: String, CodingKey {
        case id
        case transactionId = "transaction_id"
        case splitwiseExpenseId = "splitwise_expense_id"
        case friendIds = "friend_ids"
        case equalAmountEach = "equal_amount_each"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        transactionId = try c.decode(UUID.self, forKey: .transactionId)
        splitwiseExpenseId = try c.decode(String.self, forKey: .splitwiseExpenseId)
        friendIds = try c.decode([String].self, forKey: .friendIds)
        if let str = try c.decodeIfPresent(String.self, forKey: .equalAmountEach) {
            equalAmountEach = Decimal(string: str)
        } else {
            equalAmountEach = nil
        }
    }
}
