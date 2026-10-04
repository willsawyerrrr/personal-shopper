import Foundation

public enum SharedConfig {
    public static let keychainService = "dev.willsawyerrrr.personal-shopper"
    public static let serverURL = "https://personal-shopper.willsawyerrrr.dev"
}

/// The access token (Keychain) the app, share extension and App Intent all read.
public struct SettingsStore: Sendable {
    private let tokens: any TokenStore

    public init(tokens: any TokenStore = KeychainTokenStore()) {
        self.tokens = tokens
    }

    public var isSignedIn: Bool { ((try? tokens.read()) ?? nil)?.isEmpty == false }

    /// A client for the saved settings. A `401` from the server clears the token.
    ///
    /// - Throws: `AdminError.notSignedIn` without a token.
    public func client(session: URLSession = .shared) throws -> AdminClient {
        guard let token = try tokens.read(), !token.isEmpty else { throw AdminError.notSignedIn }
        let tokens = tokens
        return try AdminClient(serverURL: SharedConfig.serverURL, token: token, session: session) { try? tokens.write(nil) }
    }

    /// Redeems the code in `callback` and stores the access token.
    public func completeSignIn(_ signIn: SignIn, callback: URL, session: URLSession = .shared) async throws {
        let code = try signIn.code(from: callback)
        let token = try await AdminClient.exchange(
            serverURL: SharedConfig.serverURL, code: code, verifier: signIn.verifier, session: session)
        try tokens.write(token)
    }

    /// Revokes the token on the server, best effort, and forgets it.
    public func signOut(session: URLSession = .shared) async throws {
        try? await client(session: session).logout()
        try tokens.write(nil)
    }
}
