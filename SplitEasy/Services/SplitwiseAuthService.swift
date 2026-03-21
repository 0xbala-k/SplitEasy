import Foundation

@MainActor
final class SplitwiseAuthService: ObservableObject {
    static let shared = SplitwiseAuthService()

    private let clientId = Bundle.main.infoDictionary?["SPLITWISE_CLIENT_ID"] as? String ?? ""
    private let redirectURI = Bundle.main.infoDictionary?["SPLITWISE_REDIRECT_URI"] as? String ?? ""

    func buildOAuthURL() -> URL {
        var components = URLComponents(string: "https://www.splitwise.com/oauth/authorize")!
        components.queryItems = [
            .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "response_type", value: "code"),
        ]
        let url = components.url!
        print("🌐 OAuth URL: \(url)")
        return url
    }

    func exchangeCodeWithBackend(code: String) async throws -> AppUser {
        return try await SupabaseService.shared.client.functions.invoke(
            "splitwise-auth-callback",
            options: .init(body: ["code": code])
        )
    }
}
