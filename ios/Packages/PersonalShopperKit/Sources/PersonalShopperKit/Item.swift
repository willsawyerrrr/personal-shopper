import Foundation

/// A spoken trigger word mapped to a Woolworths product.
public struct Item: Codable, Sendable, Equatable, Identifiable {
    public let word: String
    public let stockcode: Int
    public let quantity: Int
    public let name: String?

    public var id: String { word }

    public init(word: String, stockcode: Int, quantity: Int, name: String? = nil) {
        self.word = word
        self.stockcode = stockcode
        self.quantity = quantity
        self.name = name
    }
}
