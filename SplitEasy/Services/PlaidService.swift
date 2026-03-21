import Foundation
import LinkKit

@MainActor
final class PlaidService: ObservableObject {
    static let shared = PlaidService()

    @Published var handler: Handler?

    // Create a Plaid Link handler. The link_token should be obtained from your backend.
    // For Sandbox testing: use a link_token from Plaid dashboard.
    func createHandler(linkToken: String, completion: @escaping (String) -> Void) {
        var config = LinkTokenConfiguration(token: linkToken) { result in
            switch result {
            case .success(let success):
                completion(success.publicToken)
            case .failure(let error):
                print("Plaid Link error: \(error.localizedDescription)")
            }
        }
        let result = Plaid.create(config)
        switch result {
        case .success(let handler):
            self.handler = handler
        case .failure(let error):
            print("Failed to create Plaid handler: \(error)")
        }
    }

    // Exchange public_token with backend Edge Function
    func exchangeToken(_ publicToken: String) async throws -> String {
        struct Response: Decodable { let institution_name: String }
        let response: Response = try await SupabaseService.shared.client.functions.invoke(
            "plaid-link-exchange",
            options: .init(body: ["public_token": publicToken])
        )
        return response.institution_name
    }
}
