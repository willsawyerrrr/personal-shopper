import CryptoKit
import Foundation
import Security

/// PKCE (RFC 7636, S256) and random-string helpers for the sign-in flow.
public enum PKCE {
    /// 32 random bytes as 43 base64url characters, valid as a verifier or a `state`.
    public static func randomString() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess)
        return base64URL(Data(bytes))
    }

    /// `base64url(SHA-256(verifier))` without padding.
    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
