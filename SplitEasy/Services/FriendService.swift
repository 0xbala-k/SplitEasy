import Foundation

final class FriendService {
    private var cachedFriends: [SplitwiseFriend]?

    // Returns cached friends or fetches from Edge Function.
    // Refresh forces a new network call.
    func getFriends(refresh: Bool = false) async throws -> [SplitwiseFriend] {
        if !refresh, let cached = cachedFriends { return cached }

        struct Response: Codable { let friends: [SplitwiseFriend] }
        let data = try await SupabaseService.shared.client.functions.invoke("splitwise-get-friends")
        let decoded = try JSONDecoder().decode(Response.self, from: data)
        cachedFriends = decoded.friends
        return decoded.friends
    }

    func clearCache() { cachedFriends = nil }
}
