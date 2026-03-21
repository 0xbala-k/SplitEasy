import Foundation

struct Transaction: Codable, Identifiable, Equatable {
    enum Status: String, Codable {
        case new, split, skipped, removed
    }

    let id: UUID
    let userId: String
    let plaidItemId: UUID
    let plaidTransactionId: String
    let merchantName: String?
    let amount: Decimal
    let currency: String
    let date: String          // "YYYY-MM-DD" from Supabase
    var status: Status
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, currency, date, status
        case userId = "user_id"
        case plaidItemId = "plaid_item_id"
        case plaidTransactionId = "plaid_transaction_id"
        case merchantName = "merchant_name"
        case amount
        case createdAt = "created_at"
    }

    // amount is stored as numeric in Postgres; Supabase returns it as a string
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        userId = try c.decode(String.self, forKey: .userId)
        plaidItemId = try c.decode(UUID.self, forKey: .plaidItemId)
        plaidTransactionId = try c.decode(String.self, forKey: .plaidTransactionId)
        merchantName = try c.decodeIfPresent(String.self, forKey: .merchantName)
        let amountStr = try c.decode(String.self, forKey: .amount)
        amount = Decimal(string: amountStr) ?? 0
        currency = try c.decode(String.self, forKey: .currency)
        date = try c.decode(String.self, forKey: .date)
        status = try c.decode(Status.self, forKey: .status)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
    }
}
