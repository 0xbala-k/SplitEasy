import Foundation

@MainActor
final class SettingsViewModel: ObservableObject {
    @Published var plaidItem: PlaidItem?
    @Published var currentUser: AppUser?
    @Published var needsReauth = false

    private let supabase = SupabaseService.shared

    func load() async {
        guard let userId = supabase.currentUserId else { return }
        async let userFetch: AppUser? = try? supabase.client
            .from("users").select("display_name, avatar_url")
            .eq("id", value: userId).single().execute().value
        async let plaidFetch: PlaidItem? = try? supabase.client
            .from("plaid_items").select()
            .eq("user_id", value: userId).single().execute().value

        let (user, item) = await (userFetch, plaidFetch)
        currentUser = user
        plaidItem = item
        needsReauth = item?.needsReauth ?? false
    }

    func signOut() async {
        try? await supabase.signOut()
    }
}
