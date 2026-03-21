import Foundation

struct SplitwiseFriend: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let avatarURL: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case avatarURL = "avatar_url"
    }
}
