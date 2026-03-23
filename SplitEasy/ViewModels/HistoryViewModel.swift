import Foundation

@MainActor
final class HistoryViewModel: ObservableObject {
    @Published var transactions: [Transaction] = []
    @Published var isLoading = false
    @Published var hasMore = true

    private let service = TransactionService()
    private var lastCursor: (date: String, id: UUID)?
    private let pageSize = 50

    func loadInitial() async {
        lastCursor = nil
        transactions = []
        hasMore = true
        await loadNextPage()
    }

    func loadNextPage() async {
        guard hasMore, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await service.fetchHistory(cursor: lastCursor, limit: pageSize)
            transactions.append(contentsOf: page)
            hasMore = page.count == pageSize
            if let last = page.last {
                lastCursor = (date: last.date, id: last.id)
            }
        } catch {
            print("History load error: \(error)")
        }
    }
}
