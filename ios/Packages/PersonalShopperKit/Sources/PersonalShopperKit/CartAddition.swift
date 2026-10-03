import Foundation

/// The server's answer to adding a spoken item to the cart.
public struct CartAddition: Codable, Sendable, Equatable {
    public let item: String
    public let stockcode: Int
    public let quantity: Int

    public init(item: String, stockcode: Int, quantity: Int) {
        self.item = item
        self.stockcode = stockcode
        self.quantity = quantity
    }

    /// e.g. `Added 2 × Milk`.
    public var dialog: String { "Added \(quantity) × \(item.prefix(1).uppercased() + item.dropFirst())" }
}
