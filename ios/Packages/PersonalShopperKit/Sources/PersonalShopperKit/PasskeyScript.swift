import Foundation

/// The user script that answers WebAuthn requests with a software authenticator.
public enum PasskeyScript {
    /// The name of the native message handler the script posts each created credential to.
    public static let messageHandler = "passkey"

    /// The page the Woolworths passkey is created from.
    public static let loginURL = URL(string: "https://www.woolworths.com.au/shop/securelogin")!

    public static let source: String = {
        let url = Bundle.module.url(forResource: "passkey-authenticator", withExtension: "js")!
        return try! String(contentsOf: url, encoding: .utf8)
    }()
}
