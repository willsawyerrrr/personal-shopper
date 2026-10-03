import Foundation
import Security

public protocol SecretStore: Sendable {
    func read() throws -> String?
    func write(_ secret: String?) throws
}

public struct KeychainError: Error, LocalizedError {
    public let status: OSStatus

    public var errorDescription: String? {
        (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)."
    }
}

/// Stores the shared secret as a generic-password item. With no explicit
/// access group the item lands in the first `keychain-access-groups` entry of
/// the signing entitlements, which the app and the share extension both
/// declare, so they read the same item.
public struct KeychainSecretStore: SecretStore {
    private let service: String
    private let account = "shared-secret"
    private let accessGroup: String?

    public init(service: String = SharedConfig.keychainService, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func read() throws -> String? {
        var query = baseQuery()
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            return (result as? Data).flatMap { String(data: $0, encoding: .utf8) }
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError(status: status)
        }
    }

    public func write(_ secret: String?) throws {
        let delete = SecItemDelete(baseQuery() as CFDictionary)
        guard delete == errSecSuccess || delete == errSecItemNotFound else {
            throw KeychainError(status: delete)
        }
        guard let secret, !secret.isEmpty else { return }
        var attributes = baseQuery()
        attributes[kSecValueData] = Data(secret.utf8)
        // Readable while the device is locked so Shortcuts and Siri can add items.
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    private func baseQuery() -> [CFString: Any] {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup] = accessGroup }
        return query
    }
}
