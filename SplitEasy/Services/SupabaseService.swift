import Foundation
import Supabase

@MainActor
final class SupabaseService: ObservableObject {
    nonisolated(unsafe) static let shared = SupabaseService()

    nonisolated let client: SupabaseClient

    @Published private(set) var isAuthenticated = false

    private init() {
        let url = URL(string: Bundle.main.infoDictionary?["SUPABASE_URL"] as? String ?? "")!
        let key = Bundle.main.infoDictionary?["SUPABASE_ANON_KEY"] as? String ?? ""
        client = SupabaseClient(supabaseURL: url, supabaseKey: key)
    }

    // Sign in anonymously to get a Supabase JWT (needed to call Edge Functions).
    // After Splitwise OAuth, the user row is created server-side.
    func signInAnonymously() async throws {
        try await client.auth.signInAnonymously()
        isAuthenticated = true
    }

    func signOut() async throws {
        try await client.auth.signOut()
        isAuthenticated = false
    }

    var currentUserId: String? {
        client.auth.currentUser?.id.uuidString
    }
}
