import Foundation

/// The trigger words that share one product and quantity.
public struct ItemGroup: Decodable, Sendable, Equatable, Identifiable {
    /// The stored (lower-case) words, in stored order.
    public let words: [String]
    public let stockcode: Int
    public let quantity: Int
    /// The product's title on woolworths.com.au; absent until the server has looked it up.
    public let listing: String?

    public var id: String { "\(stockcode)/\(quantity)" }

    public init(words: [String], stockcode: Int, quantity: Int, listing: String? = nil) {
        self.words = words
        self.stockcode = stockcode
        self.quantity = quantity
        self.listing = listing
    }

    /// Groups `items` by stockcode and quantity, ordered by each group's first word's position.
    public static func group(_ items: [Item]) -> [ItemGroup] {
        var order: [String] = []
        var groups: [String: ItemGroup] = [:]
        for item in items {
            let key = "\(item.stockcode)/\(item.quantity)"
            if let group = groups[key] {
                groups[key] = ItemGroup(
                    words: group.words + [item.word], stockcode: item.stockcode, quantity: item.quantity,
                    listing: group.listing ?? item.listing)
            } else {
                order.append(key)
                groups[key] = ItemGroup(
                    words: [item.word], stockcode: item.stockcode, quantity: item.quantity, listing: item.listing)
            }
        }
        return order.compactMap { groups[$0] }
    }

    /// Upper-cases the first letter of each word, after whitespace or a hyphen. For display only.
    public static func displayCase(_ word: String) -> String {
        var result = ""
        var atStart = true
        for character in word {
            result += atStart && character.isLetter ? character.uppercased() : String(character)
            atStart = character.isWhitespace || character == "-"
        }
        return result
    }

    /// The most prominent row text: the Woolworths listing, else the first word display-cased.
    public var title: String { listing ?? Self.displayCase(words.first ?? "") }

    /// The row's trigger words, display-cased and comma-separated.
    public var wordsText: String { words.map(Self.displayCase).joined(separator: ", ") }

    /// The row's footnote: stockcode and quantity.
    public var detail: String { "\(stockcode) · qty \(quantity)" }
}
