import SwiftUI

struct HistoryView: View {
    @StateObject private var vm = HistoryViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.transactions.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.transactions.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "clock")
                            .font(.system(size: 48))
                            .foregroundColor(.secondary)
                        Text("No history yet")
                            .font(.headline)
                        Text("Transactions you split or skip will appear here.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                } else {
                    List {
                        ForEach(vm.transactions) { tx in
                            HistoryRowView(transaction: tx)
                                .onAppear {
                                    if tx.id == vm.transactions.last?.id {
                                        Task { await vm.loadNextPage() }
                                    }
                                }
                        }
                        if vm.isLoading {
                            HStack { Spacer(); ProgressView(); Spacer() }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("History")
        }
        .task { await vm.loadInitial() }
    }
}
