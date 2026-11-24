import Foundation

/// Remembers the latest ready-order link in the Keychain so Siri and Shortcuts can
/// use it without being given one. The link is never logged.
public struct PickupLinkStore: Sendable {
    private let store: any TokenStore

    public init(store: any TokenStore = KeychainTokenStore(account: "last-pickup-link")) {
        self.store = store
    }

    /// Keeps the pickup link in `text`, if any, replacing the remembered one.
    public func remember(_ text: String) throws {
        guard let link = PickupLink.parse(text) else { return }
        try store.write(link)
    }

    /// The remembered link, or `nil` when there is none.
    public func recall() throws -> String? {
        try store.read().flatMap(PickupLink.parse)
    }
}
