import Foundation

@MainActor
final class FriendPickerViewModel: ObservableObject {
    let transaction: Transaction
    private let friendService = FriendService()
    private let splitService = SplitService()

    @Published var friends: [SplitwiseFriend] = []
    @Published var selectedFriends: Set<SplitwiseFriend> = []
    @Published var isLoading = false
    @Published var isSubmitting = false
    @Published var errorMessage: String?
    @Published var successAmountEach: Decimal?

    var amountPerPerson: Decimal {
        guard !selectedFriends.isEmpty else { return 0 }
        let totalPeople = Decimal(selectedFriends.count + 1)
        var result = transaction.amount / totalPeople
        var rounded = Decimal()
        NSDecimalRound(&rounded, &result, 2, .plain)
        return rounded
    }

    var canSubmit: Bool { !selectedFriends.isEmpty && !isSubmitting }

    init(transaction: Transaction) {
        self.transaction = transaction
    }

    func toggleSelection(_ friend: SplitwiseFriend) {
        if selectedFriends.contains(friend) {
            selectedFriends.remove(friend)
        } else {
            selectedFriends.insert(friend)
        }
    }

    func loadFriends() async {
        isLoading = true
        defer { isLoading = false }
        do {
            friends = try await friendService.getFriends()
        } catch {
            errorMessage = "Could not load friends. Try again."
        }
    }

    func submit() async throws -> SplitResult {
        isSubmitting = true
        defer { isSubmitting = false }
        let ids = selectedFriends.map(\.id)
        let result = try await splitService.createExpense(
            transactionId: transaction.id,
            friendIds: ids
        )
        successAmountEach = result.amountEach
        return result
    }
}
