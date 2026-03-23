import XCTest
@testable import SplitEasy

final class TransactionTests: XCTestCase {
    func test_transactionStatus_rawValues() {
        XCTAssertEqual(Transaction.Status.new.rawValue, "new")
        XCTAssertEqual(Transaction.Status.split.rawValue, "split")
        XCTAssertEqual(Transaction.Status.skipped.rawValue, "skipped")
        XCTAssertEqual(Transaction.Status.removed.rawValue, "removed")
    }

    func test_transaction_decodable() throws {
        let json = """
        {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "user_id": "user-1",
            "plaid_item_id": "123e4567-e89b-12d3-a456-426614174001",
            "plaid_transaction_id": "plaid-tx-1",
            "merchant_name": "Chipotle",
            "amount": "24.50",
            "currency": "USD",
            "date": "2026-03-18",
            "status": "new",
            "created_at": "2026-03-18T10:00:00Z"
        }
        """.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let tx = try decoder.decode(Transaction.self, from: json)
        XCTAssertEqual(tx.merchantName, "Chipotle")
        XCTAssertEqual(tx.amount, Decimal(string: "24.50")!)
        XCTAssertEqual(tx.status, .new)
    }
}
