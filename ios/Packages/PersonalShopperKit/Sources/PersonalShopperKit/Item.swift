import Foundation

/// A spoken trigger word mapped to a Woolworths product.
public struct Item: Codable, Sendable, Equatable, Identifiable {
    public let word: String
    public let stockcode: Int
    public let quantity: Int
    /// The product's title on woolworths.com.au; absent until the server has looked it up.
    public let listing: String?

    public var id: String { word }

    public init(word: String, stockcode: Int, quantity: Int, listing: String? = nil) {
        self.word = word
        self.stockcode = stockcode
        self.quantity = quantity
        self.listing = listing
    }
}
