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

    private let authService = SplitwiseAuthService.shared
    private let supabase = SupabaseService.shared

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
            let code = try await authService.startOAuth()
            let user = try await authService.exchangeCodeWithBackend(code: code)
            currentUser = user
            state = .needsBankLink
        } catch {
            print("❌ Splitwise sign-in error: \(error)")
            errorMessage = "Sign in failed: \(error.localizedDescription)"
        }
    }
}
