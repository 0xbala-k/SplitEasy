import SwiftUI
import LinkKit

struct BankConnectView: View {
    @ObservedObject var vm: OnboardingViewModel
    @StateObject private var plaid = PlaidService.shared
    @State private var showingLink = false
    @State private var isConnecting = false
    @State private var toast: Toast?

    var body: some View {
        VStack(spacing: 32) {
            Spacer()
            Image(systemName: "building.columns.fill")
                .font(.system(size: 80))
                .foregroundStyle(.blue)
            VStack(spacing: 8) {
                Text("Connect your bank")
                    .font(.largeTitle).bold()
                Text("Automatically import transactions to split")
                    .font(.title3).foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            VStack(spacing: 16) {
                Button {
                    Task { await connectBank() }
                } label: {
                    if isConnecting {
                        ProgressView().tint(.white)
                    } else {
                        Label("Connect via Plaid", systemImage: "link")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color.accentColor)
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .disabled(isConnecting)

                Button("Skip for now") {
                    vm.state = .complete
                }
                .foregroundColor(.secondary)
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 48)
        }
        .sheet(isPresented: $showingLink) {
            if let handler = plaid.handler {
                LinkController(handler: handler)
                    .ignoresSafeArea()
            }
        }
        .toast($toast)
    }

    private func connectBank() async {
        isConnecting = true
        defer { isConnecting = false }
        struct LinkTokenResponse: Codable { let link_token: String }
        guard let data = try? await SupabaseService.shared.client.functions.invoke("plaid-create-link-token"),
              let response = try? JSONDecoder().decode(LinkTokenResponse.self, from: data)
        else {
            toast = Toast(message: "Could not start bank connection. Try again.", style: .error)
            return
        }
        plaid.createHandler(linkToken: response.link_token) { publicToken in
            Task {
                do {
                    let name = try await plaid.exchangeToken(publicToken)
                    toast = Toast(message: "\(name) connected!", style: .success)
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    vm.state = .complete
                } catch {
                    toast = Toast(message: "Connection failed. Try again.", style: .error)
                }
            }
        }
        showingLink = true
    }
}
