import Foundation

struct PlaidItem: Codable, Identifiable {
    let id: UUID
    let institutionName: String?
    let institutionLogoURL: String?
    let needsReauth: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case institutionName = "institution_name"
        case institutionLogoURL = "institution_logo_url"
        case needsReauth = "needs_reauth"
    }
}
