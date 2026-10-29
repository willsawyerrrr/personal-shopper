import Foundation

/// A spoken trigger word mapped to a Woolworths product.
public struct Item: Codable, Sendable, Equatable, Identifiable {
    public let word: String
    public let stockcode: Int
    public let quantity: Int
    /// The product's title on woolworths.com.au; absent until the server has looked it up.
    public let listing: String?
    /// The household's own name for the product; absent when it has none.
    public let name: String?
    /// Other stockcode/quantity options for the same product; the cheapest per unit is added.
    public let alternatives: [ItemCandidate]?

    public var id: String { word }

    public init(
        word: String, stockcode: Int, quantity: Int, listing: String? = nil, name: String? = nil,
        alternatives: [ItemCandidate]? = nil
    ) {
        self.word = word
        self.stockcode = stockcode
        self.quantity = quantity
        self.listing = listing
        self.name = name
        self.alternatives = alternatives
    }
}

/// A stockcode and quantity option considered alongside an item's own when adding to cart.
public struct ItemCandidate: Codable, Sendable, Equatable {
    public let stockcode: Int
    public let quantity: Int

    public init(stockcode: Int, quantity: Int) {
        self.stockcode = stockcode
        self.quantity = quantity
    }
}
