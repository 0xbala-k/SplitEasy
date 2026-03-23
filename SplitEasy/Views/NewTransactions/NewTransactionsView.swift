import SwiftUI

struct NewTransactionsView: View {
    @StateObject private var vm = NewTransactionsViewModel()
    @State private var selectedTransaction: Transaction?
    @State private var toast: Toast?
    @EnvironmentObject private var settingsVM: SettingsViewModel
    @EnvironmentObject private var networkMonitor: NetworkMonitor

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.transactions.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.transactions.isEmpty {
                    emptyState
                } else {
                    transactionList
                }
            }
            .navigationTitle("New Transactions")
            .safeAreaInset(edge: .top) {
                if settingsVM.needsReauth {
                    ReauthBannerView { /* TODO: trigger Plaid update mode */ }
                }
                if !networkMonitor.isConnected {
                    HStack {
                        Image(systemName: "wifi.slash")
                        Text("No internet connection")
                    }
                    .font(.caption)
                    .foregroundColor(.white)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(Color.red)
                }
            }
        }
        .task { await vm.load() }
        .onAppear { vm.startRealtime() }
        .onDisappear { vm.stopRealtime() }
        .refreshable { await vm.refresh() }
        .sheet(item: $selectedTransaction) { tx in
            FriendPickerView(
                transaction: tx,
                isPresented: Binding(
                    get: { selectedTransaction != nil },
                    set: { if !$0 { selectedTransaction = nil } }
                ),
                onSuccess: { _, amountEach in
                    let f = NumberFormatter()
                    f.numberStyle = .currency
                    f.currencyCode = "USD"
                    let formatted = f.string(from: amountEach as NSDecimalNumber) ?? "$\(amountEach)"
                    toast = Toast(message: "Added! Others owe you \(formatted)", style: .success)
                }
            )
            .environmentObject(vm)
        }
        .toast($toast)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("No new transactions")
                .font(.headline)
            Text("New transactions will appear here automatically.")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private var transactionList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(vm.transactions) { tx in
                    TransactionRowView(
                        transaction: tx,
                        onSkip: { Task { await vm.skip(tx) } },
                        onSplit: { selectedTransaction = tx }
                    )
                    .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
    }
}
