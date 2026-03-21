import SwiftUI

struct SettingsView: View {
    @StateObject private var vm = SettingsViewModel()
    @StateObject private var plaid = PlaidService.shared
    @State private var isReconnecting = false
    @State private var toast: Toast?

    var body: some View {
        NavigationStack {
            Form {
                Section("Bank Account") {
                    if let item = vm.plaidItem {
                        HStack {
                            Image(systemName: "building.columns.fill")
                                .foregroundColor(.blue)
                            Text(item.institutionName ?? "Connected Bank")
                        }
                        if item.needsReauth {
                            Button {
                                Task { await reconnectBank() }
                            } label: {
                                if isReconnecting { ProgressView() } else { Text("Reconnect Bank") }
                            }
                            .foregroundColor(.orange)
                            .disabled(isReconnecting)
                        } else {
                            Label("Connected", systemImage: "checkmark.circle.fill")
                                .foregroundColor(.green)
                        }
                    } else {
                        Text("No bank connected")
                            .foregroundColor(.secondary)
                    }
                }

                Section("Splitwise Account") {
                    if let user = vm.currentUser {
                        HStack {
                            Image(systemName: "person.circle.fill")
                                .foregroundColor(.accentColor)
                            Text(user.displayName)
                        }
                    }
                    Button("Sign Out", role: .destructive) {
                        Task { await vm.signOut() }
                    }
                }

                Section("Notifications") {
                    Toggle("Transaction Alerts", isOn: .constant(false))
                        .disabled(true)
                    Text("Push notifications coming soon.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Settings")
        }
        .task { await vm.load() }
        .toast($toast)
    }

    private func reconnectBank() async {
        isReconnecting = true
        defer { isReconnecting = false }
        struct LinkTokenResponse: Codable { let link_token: String }
        guard let data = try? await SupabaseService.shared.client.functions.invoke("plaid-create-link-token"),
              let response = try? JSONDecoder().decode(LinkTokenResponse.self, from: data)
        else {
            toast = Toast(message: "Could not start reconnection. Try again.", style: .error)
            return
        }
        plaid.createHandler(linkToken: response.link_token) { publicToken in
            Task {
                do {
                    _ = try await plaid.exchangeToken(publicToken)
                    await vm.load()
                    toast = Toast(message: "Bank reconnected!", style: .success)
                } catch {
                    toast = Toast(message: "Reconnection failed. Try again.", style: .error)
                }
            }
        }
    }
}
