import Foundation

/// The server's answer to adding a spoken item to the cart.
public struct CartAddition: Codable, Sendable, Equatable {
    public let item: String
    public let stockcode: Int
    public let quantity: Int
    /// How many of the item the cart holds, absent from older servers.
    public let count: Int?

    public init(item: String, stockcode: Int, quantity: Int, count: Int? = nil) {
        self.item = item
        self.stockcode = stockcode
        self.quantity = quantity
        self.count = count
    }

    /// e.g. `Added Milk to your cart`, with ` (2 in total)` when the cart holds more than one.
    public var dialog: String {
        let name = item.prefix(1).uppercased() + item.dropFirst()
        let total = count.flatMap { $0 > 1 ? " (\($0) in total)" : nil } ?? ""
        return "Added \(name) to your cart\(total)"
    }
}
