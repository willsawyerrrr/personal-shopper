import Foundation

/// One Google sign-in attempt: the PKCE verifier and `state` it generated, the
/// URL to open in the system browser, and the check of what comes back.
public struct SignIn: Sendable {
    public static let callbackScheme = "dev.willsawyerrrr.personalshopper"
    public static let redirectURI = "\(callbackScheme)://auth"

    public let verifier: String
    public let state: String
    public let startURL: URL

    public init(
        serverURL: String, verifier: String = PKCE.randomString(), state: String = PKCE.randomString()
    ) throws {
        guard var components = URLComponents(url: try validatedServerURL(serverURL), resolvingAgainstBaseURL: false)
        else { throw AdminError.invalidURL }
        components.percentEncodedPath = trimmingTrailingSlash(components.percentEncodedPath) + "/auth/start"
        components.queryItems = [
            URLQueryItem(name: "client", value: "ios"),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "code_challenge", value: PKCE.challenge(for: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        guard let url = components.url else { throw AdminError.invalidURL }
        self.verifier = verifier
        self.state = state
        self.startURL = url
    }

    /// The one-time code in the redirect, once its `state` matches this attempt.
    ///
    /// - Throws: `AdminError.signInFailed` for a mismatched `state`, an `error`
    ///   from the server or a missing code.
    public func code(from callback: URL) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw AdminError.signInFailed("The sign-in response didn't match the request.") }
        if let error = value("error") {
            switch error {
            case "signup_closed": throw AdminError.signInFailed("Sign-ups are closed.")
            case "user_limit": throw AdminError.signInFailed("Too many active sign-ins. Sign out of another device and try again.")
            default: throw AdminError.signInFailed("Google sign-in failed.")
            }
        }
        guard let code = value("code"), !code.isEmpty else { throw AdminError.signInFailed("Google sign-in failed.") }
        return code
    }
}

func validatedServerURL(_ serverURL: String) throws -> URL {
    let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
        scheme == "http" || scheme == "https", url.host() != nil
    else { throw AdminError.invalidURL }
    return url
}

func trimmingTrailingSlash(_ path: String) -> String {
    path.hasSuffix("/") ? String(path.dropLast()) : path
}
