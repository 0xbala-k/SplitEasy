import Foundation

final class FriendService {
    static let shared = FriendService()
    private var cachedFriends: [SplitwiseFriend]?

    // Returns cached friends or fetches from Edge Function.
    // Refresh forces a new network call.
    func getFriends(refresh: Bool = false) async throws -> [SplitwiseFriend] {
        if !refresh, let cached = cachedFriends { return cached }

        struct Response: Decodable { let friends: [SplitwiseFriend] }
        let decoded: Response = try await SupabaseService.shared.client.functions.invoke("splitwise-get-friends")
        cachedFriends = decoded.friends
        return decoded.friends
    }

    func clearCache() { cachedFriends = nil }
}
