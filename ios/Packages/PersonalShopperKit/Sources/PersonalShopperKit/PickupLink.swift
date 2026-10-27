import Foundation

/// The Woolworths ready-order link from a pickup SMS or email: either the short
/// `https://w.wowpu.com.au/<code>` link Woolworths texts, or the
/// `https://myorder.woolworths.com.au/pickup/order?token=…` URL it redirects to.
/// A link is kept as received, never resolved on the device.
public enum PickupLink {
    /// The first pickup link in `text`, or `nil` when it has none.
    public static func parse(_ text: String) -> String? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        return detector?.matches(in: text, range: range)
            .compactMap(\.url)
            .first(where: isPickupLink)?
            .absoluteString
    }

    private static func isPickupLink(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user() == nil, url.password() == nil, url.port == nil else { return false }
        switch url.host()?.lowercased() {
        case "myorder.woolworths.com.au":
            return url.path() == "/pickup/order"
        case "w.wowpu.com.au":
            let path = url.path()
            return path.count > 1 && path.dropFirst().allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
                && path.hasPrefix("/")
        default:
            return false
        }
    }
}
