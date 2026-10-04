import Foundation

/// A user in the signed-in user's household, which shares its items and Woolworths account.
public struct HouseholdMember: Codable, Sendable, Equatable, Identifiable {
    public let email: String
    /// Whether this member is the signed-in user.
    public let you: Bool

    public var id: String { email }

    public init(email: String, you: Bool) {
        self.email = email
        self.you = you
    }
}

/// A single-use code that lets someone join the household until it expires.
public struct HouseholdInvite: Sendable, Equatable {
    public let code: String
    public let expiresAt: Date

    public init(code: String, expiresAt: Date) {
        self.code = code
        self.expiresAt = expiresAt
    }
}
