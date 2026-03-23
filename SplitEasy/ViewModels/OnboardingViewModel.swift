import Foundation

enum OnboardingState {
    case loading
    case needsSplitwiseAuth
    case needsBankLink
    case complete
}

@MainActor
final class OnboardingViewModel: ObservableObject {
    @Published var state: OnboardingState = .loading
    @Published var errorMessage: String?
    @Published var currentUser: AppUser?
    @Published var oauthURL: URL?  // non-nil shows the web auth sheet

    private let authService = SplitwiseAuthService.shared
    private let supabase = SupabaseService.shared
    private var codeContinuation: CheckedContinuation<String, Error>?

    func checkAuthState() async {
        do {
            let session = try? await supabase.client.auth.session
            if session == nil {
                try await supabase.signInAnonymously()
            }
            if let userId = supabase.currentUserId {
                let user: AppUser? = try? await supabase.client
                    .from("users")
                    .select("display_name, avatar_url")
                    .eq("id", value: userId)
                    .single()
                    .execute()
                    .value
                if let user {
                    currentUser = user
                    let items: [PlaidItem] = (try? await supabase.client
                        .from("plaid_items")
                        .select()
                        .eq("user_id", value: userId)
                        .execute()
                        .value) ?? []
                    state = items.isEmpty ? .needsBankLink : .complete
                } else {
                    state = .needsSplitwiseAuth
                }
            }
        } catch {
            state = .needsSplitwiseAuth
        }
    }

    func signInWithSplitwise() async {
        errorMessage = nil
        do {
            let code: String = try await withCheckedThrowingContinuation { continuation in
                codeContinuation = continuation
                oauthURL = authService.buildOAuthURL()
            }
            oauthURL = nil
            // Ensure we have a valid anonymous session before calling the Edge Function
            let session = try? await supabase.client.auth.session
            if session == nil {
                try await supabase.signInAnonymously()
            }
            let user = try await authService.exchangeCodeWithBackend(code: code)
            currentUser = user
            state = .needsBankLink
        } catch {
            print("❌ Splitwise sign-in error: \(error)")
            errorMessage = "Sign in failed: \(error.localizedDescription)"
        }
    }

    func handleOAuthCode(_ code: String) {
        codeContinuation?.resume(returning: code)
        codeContinuation = nil
    }

    func handleOAuthCancel() {
        codeContinuation?.resume(throwing: URLError(.cancelled))
        codeContinuation = nil
        oauthURL = nil
    }
}
