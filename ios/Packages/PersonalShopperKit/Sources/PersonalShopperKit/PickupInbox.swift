import Foundation

/// Hands a ready-order link from the share extension to the app through the
/// shared Keychain access group, which no other app can read. The link is
/// removed when the app takes it and never logged.
public struct PickupInbox: Sendable {
    private let store: any TokenStore

    public init(store: any TokenStore = KeychainTokenStore(account: "pending-pickup-link")) {
        self.store = store
    }

    /// Keeps the pickup link in `text` for the app, replacing any waiting one.
    ///
    /// - Returns: Whether `text` held a pickup link.
    @discardableResult
    public func leave(_ text: String) throws -> Bool {
        guard let link = PickupLink.parse(text) else { return false }
        try store.write(link)
        return true
    }

    /// The waiting link, removed from the inbox, or `nil` when there is none.
    public func take() throws -> String? {
        guard let link = try store.read(), !link.isEmpty else { return nil }
        try store.write(nil)
        return PickupLink.parse(link)
    }
}
