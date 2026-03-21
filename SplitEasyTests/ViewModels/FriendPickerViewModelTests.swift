import XCTest
@testable import SplitEasy

@MainActor
final class FriendPickerViewModelTests: XCTestCase {
    func test_equalSplitAmount_withTwoFriendsSelected() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: "30.00"))
        let friendA = SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)
        let friendB = SplitwiseFriend(id: "2", name: "Bob", avatarURL: nil)
        vm.toggleSelection(friendA)
        vm.toggleSelection(friendB)
        // 3 people total (2 friends + current user), $30.00 / 3 = $10.00
        XCTAssertEqual(vm.amountPerPerson, Decimal(string: "10.00")!)
    }

    func test_toggleSelection_addsAndRemovesFriend() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: "20.00"))
        let friend = SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)
        vm.toggleSelection(friend)
        XCTAssertTrue(vm.selectedFriends.contains(friend))
        vm.toggleSelection(friend)
        XCTAssertFalse(vm.selectedFriends.contains(friend))
    }

    func test_canSubmit_requiresAtLeastOneFriend() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: "20.00"))
        XCTAssertFalse(vm.canSubmit)
        let friend = SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)
        vm.toggleSelection(friend)
        XCTAssertTrue(vm.canSubmit)
    }

    private func makeTransaction(amount: String) -> Transaction {
        let json = """
        {"id":"00000000-0000-0000-0000-000000000001","user_id":"u1","plaid_item_id":"00000000-0000-0000-0000-000000000002","plaid_transaction_id":"tx1","merchant_name":"Test","amount":"\(amount)","currency":"USD","date":"2026-03-18","status":"new","created_at":"2026-03-18T10:00:00Z"}
        """.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try! decoder.decode(Transaction.self, from: json)
    }
}
