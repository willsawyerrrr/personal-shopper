import Foundation

public enum SharedConfig {
    public static let appGroup = "group.dev.willsawyerrrr.personalshopper"
    public static let keychainService = "dev.willsawyerrrr.personalshopper"
    public static let defaultServerURL = "https://personal-shopper.willsawyerrrr.dev"
}

/// The server URL (app-group defaults) and access token (Keychain) the app,
/// share extension and App Intent all read.
///
/// `@unchecked Sendable`: `UserDefaults` is documented as thread-safe but not annotated.
public struct SettingsStore: @unchecked Sendable {
    private static let serverURLKey = "serverURL"

    private let defaults: UserDefaults
    private let tokens: any TokenStore

    public init(
        defaults: UserDefaults = UserDefaults(suiteName: SharedConfig.appGroup) ?? .standard,
        tokens: any TokenStore = KeychainTokenStore()
    ) {
        self.defaults = defaults
        self.tokens = tokens
    }

    public var serverURL: String {
        get { defaults.string(forKey: Self.serverURLKey) ?? SharedConfig.defaultServerURL }
        nonmutating set { defaults.set(newValue, forKey: Self.serverURLKey) }
    }

    public var isSignedIn: Bool { ((try? tokens.read()) ?? nil)?.isEmpty == false }

    /// A client for the saved settings. A `401` from the server clears the token.
    ///
    /// - Throws: `AdminError.notSignedIn` without a token, `.invalidURL` for an unusable server URL.
    public func client(session: URLSession = .shared) throws -> AdminClient {
        guard let token = try tokens.read(), !token.isEmpty else { throw AdminError.notSignedIn }
        let tokens = tokens
        return try AdminClient(serverURL: serverURL, token: token, session: session) { try? tokens.write(nil) }
    }

    /// Redeems the code in `callback` and stores the access token.
    public func completeSignIn(_ signIn: SignIn, callback: URL, session: URLSession = .shared) async throws {
        let code = try signIn.code(from: callback)
        let token = try await AdminClient.exchange(
            serverURL: serverURL, code: code, verifier: signIn.verifier, session: session)
        try tokens.write(token)
    }

    /// Revokes the token on the server, best effort, and forgets it.
    public func signOut(session: URLSession = .shared) async throws {
        try? await client(session: session).logout()
        try tokens.write(nil)
    }
}
