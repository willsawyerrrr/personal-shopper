import Foundation

/// A Woolworths product page URL, as shared from the Woolworths app or Safari.
public struct ProductLink: Sendable, Equatable {
    public let url: URL
    public let stockcode: Int
    /// The human-readable path segment after the stockcode, if present.
    public let slug: String?

    /// Finds the first Woolworths product URL in `text`, which may be a bare
    /// URL or prose containing one.
    public static func parse(_ text: String) -> ProductLink? {
        let candidates = [text.trimmingCharacters(in: .whitespacesAndNewlines)] + detectedURLs(in: text)
        return candidates.lazy.compactMap { URL(string: $0).flatMap(ProductLink.init) }.first
    }

    public static func parse(_ url: URL) -> ProductLink? {
        ProductLink(url: url)
    }

    /// A display name derived from the slug, e.g. `Woolworths Full Cream Milk 2l`.
    public var suggestedName: String? {
        guard let slug else { return nil }
        let words = slug.split(separator: "-").map { word in
            word.prefix(1).uppercased() + word.dropFirst()
        }
        return words.isEmpty ? nil : words.joined(separator: " ")
    }

    private init?(url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
            let host = url.host()?.lowercased(),
            host == "woolworths.com.au" || host.hasSuffix(".woolworths.com.au")
        else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count >= 3, parts[0].lowercased() == "shop", parts[1].lowercased() == "productdetails",
            let stockcode = Int(parts[2]), stockcode > 0
        else { return nil }
        self.url = url
        self.stockcode = stockcode
        self.slug = parts.count > 3 ? parts[3] : nil
    }

    private static func detectedURLs(in text: String) -> [String] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return []
        }
        let range = NSRange(text.startIndex..., in: text)
        return detector.matches(in: text, range: range).compactMap { $0.url?.absoluteString }
    }
}
