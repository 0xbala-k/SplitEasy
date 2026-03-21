import Foundation
import Supabase

final class SupabaseService: ObservableObject {
    static let shared = SupabaseService()

    let client: SupabaseClient

    @Published private(set) var isAuthenticated = false

    private init() {
        let url = URL(string: Bundle.main.infoDictionary?["SUPABASE_URL"] as? String ?? "")!
        let key = Bundle.main.infoDictionary?["SUPABASE_ANON_KEY"] as? String ?? ""
        client = SupabaseClient(supabaseURL: url, supabaseKey: key)
    }

    // Sign in anonymously to get a Supabase JWT (needed to call Edge Functions).
    // After Splitwise OAuth, the user row is created server-side.
    @MainActor
    func signInAnonymously() async throws {
        try await client.auth.signInAnonymously()
        isAuthenticated = true
    }

    @MainActor
    func signOut() async throws {
        try await client.auth.signOut()
        isAuthenticated = false
    }

    var currentUserId: String? {
        client.auth.currentUser?.id.uuidString
    }
}
