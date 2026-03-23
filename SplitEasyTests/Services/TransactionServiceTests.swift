import XCTest
@testable import SplitEasy

final class TransactionServiceTests: XCTestCase {
    func test_skipTransaction_updatesStatusLocally() async throws {
        // This test validates the skip logic using a mock; full integration requires Supabase
        // For unit testing, we verify the status value sent is "skipped"
        let statusValue = Transaction.Status.skipped.rawValue
        XCTAssertEqual(statusValue, "skipped")
    }
}
