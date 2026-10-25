import Foundation

/// A Woolworths passkey in the form `PUT /woolworths/passkey` takes. The binary
/// fields are standard base64; `privateKey` is a PKCS#8 DER key.
public struct PasskeyCredential: Codable, Equatable, Sendable {
    /// The relying party Woolworths signs in with.
    public static let rpId = "auth.woolworths.com.au"

    public let rpId: String
    public let credentialId: String
    public let userHandle: String
    public let privateKey: String

    public init(rpId: String, credentialId: String, userHandle: String, privateKey: String) {
        self.rpId = rpId
        self.credentialId = credentialId
        self.userHandle = userHandle
        self.privateKey = privateKey
    }

    /// Reads the credential the script posts, or `nil` when it is malformed or not for Woolworths.
    public init?(message: Any) {
        guard JSONSerialization.isValidJSONObject(message),
            let data = try? JSONSerialization.data(withJSONObject: message),
            let credential = try? JSONDecoder().decode(PasskeyCredential.self, from: data),
            credential.rpId == Self.rpId,
            ![credential.credentialId, credential.userHandle, credential.privateKey].contains(where: \.isEmpty)
        else { return nil }
        self = credential
    }
}
