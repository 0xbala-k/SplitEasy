import Foundation
import AuthenticationServices

@MainActor
final class SplitwiseAuthService: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = SplitwiseAuthService()

    private let clientId = Bundle.main.infoDictionary?["SPLITWISE_CLIENT_ID"] as? String ?? ""
    private let redirectURI = Bundle.main.infoDictionary?["SPLITWISE_REDIRECT_URI"] as? String ?? ""

    // Initiates Splitwise OAuth. Returns the authorization code for server-side exchange.
    func startOAuth() async throws -> String {
        var components = URLComponents(string: "https://secure.splitwise.com/oauth/authorize")!
        components.queryItems = [
            .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "response_type", value: "code"),
        ]
        let authURL = components.url!
        let callbackScheme = "spliteasy"

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callbackScheme) { url, error in
                if let error { continuation.resume(throwing: error); return }
                guard let url,
                      let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                        .queryItems?.first(where: { $0.name == "code" })?.value
                else {
                    continuation.resume(throwing: URLError(.badServerResponse))
                    return
                }
                continuation.resume(returning: code)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            session.start()
        }
    }

    // Send auth code to Edge Function for server-side token exchange
    func exchangeCodeWithBackend(code: String) async throws -> AppUser {
        return try await SupabaseService.shared.client.functions.invoke(
            "splitwise-auth-callback",
            options: .init(body: ["code": code])
        )
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.windows.first ?? ASPresentationAnchor()
    }
}
