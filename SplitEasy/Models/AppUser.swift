import Foundation

struct AppUser: Codable {
    let displayName: String
    let avatarURL: String?

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case avatarURL = "avatar_url"
    }
}
