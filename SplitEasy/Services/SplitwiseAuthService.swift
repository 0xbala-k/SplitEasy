import Foundation
import UIKit

@MainActor
final class SplitwiseAuthService: ObservableObject {
    static let shared = SplitwiseAuthService()

    private let clientId = Bundle.main.infoDictionary?["SPLITWISE_CLIENT_ID"] as? String ?? ""
    private let redirectURI = Bundle.main.infoDictionary?["SPLITWISE_REDIRECT_URI"] as? String ?? ""

    // Stored continuation awaiting the OAuth callback URL
    private var oauthContinuation: CheckedContinuation<String, Error>?

    // Called from SplitEasyApp.onOpenURL when spliteasy:// is opened
    func handleCallback(url: URL) {
        print("🔄 handleCallback: \(url.absoluteString)")
        guard let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value
        else {
            oauthContinuation?.resume(throwing: URLError(.badServerResponse))
            oauthContinuation = nil
            return
        }
        oauthContinuation?.resume(returning: code)
        oauthContinuation = nil
    }

    // Opens Safari for Splitwise OAuth and waits for the callback URL
    func startOAuth() async throws -> String {
        var components = URLComponents(string: "https://www.splitwise.com/oauth/authorize")!
        components.queryItems = [
            .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "response_type", value: "code"),
        ]
        let authURL = components.url!
        print("🌐 Opening OAuth URL: \(authURL)")

        return try await withCheckedThrowingContinuation { continuation in
            oauthContinuation = continuation
            UIApplication.shared.open(authURL)
        }
    }

    // Send auth code to Edge Function for server-side token exchange
    func exchangeCodeWithBackend(code: String) async throws -> AppUser {
        return try await SupabaseService.shared.client.functions.invoke(
            "splitwise-auth-callback",
            options: .init(body: ["code": code])
        )
    }
}
