import Foundation

/// The Woolworths ready-order link from a pickup SMS or email.
public enum PickupLink {
    /// The first `https://myorder.woolworths.com.au/pickup/order` link in `text`,
    /// or `nil` when it has none.
    public static func parse(_ text: String) -> String? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        return detector?.matches(in: text, range: range)
            .compactMap(\.url)
            .first { url in
                url.scheme == "https" && url.host()?.lowercased() == "myorder.woolworths.com.au"
                    && url.path() == "/pickup/order"
            }?
            .absoluteString
    }
}
