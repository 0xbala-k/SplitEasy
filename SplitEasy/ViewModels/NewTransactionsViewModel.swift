import Foundation
import Supabase

@MainActor
final class NewTransactionsViewModel: ObservableObject {
    @Published var transactions: [Transaction] = []
    @Published var isLoading = false
    @Published var needsReauthBanner = false

    private let service = TransactionService()
    private var realtimeChannel: RealtimeChannelV2?

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            transactions = try await service.fetchNew()
        } catch {
            print("Load error: \(error)")
        }
    }

    func refresh() async { await load() }

    func startRealtime() {
        guard realtimeChannel == nil else { return }
        realtimeChannel = service.subscribeToNew { [weak self] updated in
            self?.transactions = updated
        }
    }

    func stopRealtime() {
        Task { await realtimeChannel?.unsubscribe() }
        realtimeChannel = nil
    }

    func skip(_ transaction: Transaction) async {
        transactions.removeAll { $0.id == transaction.id }
        do {
            try await service.skip(transactionId: transaction.id)
        } catch {
            transactions.append(transaction) // rollback optimistic update
        }
    }

    func remove(_ transaction: Transaction) {
        transactions.removeAll { $0.id == transaction.id }
    }
}
