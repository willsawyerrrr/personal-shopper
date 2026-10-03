import Foundation

public enum SharedConfig {
    public static let appGroup = "group.dev.willsawyerrrr.personalshopper"
    public static let keychainService = "dev.willsawyerrrr.personalshopper"
    public static let defaultServerURL = "https://personal-shopper.willsawyerrrr.dev"
}

/// The server URL (app-group defaults) and shared secret (Keychain) the app,
/// share extension and App Intent all read.
///
/// `@unchecked Sendable`: `UserDefaults` is documented as thread-safe but not annotated.
public struct SettingsStore: @unchecked Sendable {
    private static let serverURLKey = "serverURL"

    private let defaults: UserDefaults
    private let secrets: any SecretStore

    public init(
        defaults: UserDefaults = UserDefaults(suiteName: SharedConfig.appGroup) ?? .standard,
        secrets: any SecretStore = KeychainSecretStore()
    ) {
        self.defaults = defaults
        self.secrets = secrets
    }

    public var serverURL: String {
        get { defaults.string(forKey: Self.serverURLKey) ?? SharedConfig.defaultServerURL }
        nonmutating set { defaults.set(newValue, forKey: Self.serverURLKey) }
    }

    public func secret() throws -> String {
        try secrets.read() ?? ""
    }

    public func setSecret(_ secret: String) throws {
        try secrets.write(secret.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// A client for the saved settings.
    ///
    /// - Throws: `AdminError.notConfigured` without a secret, `.invalidURL` for an unusable server URL.
    public func client(session: URLSession = .shared) throws -> AdminClient {
        let secret = try secret()
        guard !secret.isEmpty else { throw AdminError.notConfigured }
        return try AdminClient(serverURL: serverURL, secret: secret, session: session)
    }
}
