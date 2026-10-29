import Foundation

/// A household item: a set of spoken trigger words mapped to a set of candidate products, the
/// cheapest per unit of which is added to the cart.
public struct Item: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// The household's own name for the item; absent when it has none.
    public let name: String?
    /// The product's title on woolworths.com.au, looked up for the first candidate; absent until
    /// the server has looked it up.
    public let listing: String?
    /// The spoken trigger phrases that refer to this item, in stored order.
    public let words: [String]
    /// This item's stockcode/quantity options, an unordered set, in stored order.
    public let candidates: [ItemCandidate]

    public init(
        id: String, name: String? = nil, listing: String? = nil, words: [String],
        candidates: [ItemCandidate]
    ) {
        self.id = id
        self.name = name
        self.listing = listing
        self.words = words
        self.candidates = candidates
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

    /// The most prominent row text: the custom name, else the Woolworths listing, else the first
    /// word display-cased.
    public var title: String { name ?? listing ?? Self.displayCase(words.first ?? "") }

    /// The Woolworths listing, shown beneath a custom name; nil when the title is the listing.
    public var subtitle: String? { name == nil ? nil : listing }

    /// The row's trigger words: display-cased, with every word after the first collapsed to a
    /// count.
    public var wordsText: String {
        guard let first = words.first else { return "" }
        let extra = words.count - 1
        return extra > 0 ? "\(Self.displayCase(first)) +\(extra) more" : Self.displayCase(first)
    }

    /// The row's footnote: the first candidate's stockcode and quantity, with every candidate
    /// after the first collapsed to a count.
    public var detail: String {
        guard let first = candidates.first else { return "" }
        let base = "\(first.stockcode) · qty \(first.quantity)"
        let extra = candidates.count - 1
        return extra > 0 ? "\(base) +\(extra) more" : base
    }
}

/// A stockcode and quantity option for an item; the cheapest per unit is added to the cart.
public struct ItemCandidate: Codable, Sendable, Equatable {
    public let stockcode: Int
    public let quantity: Int

    public init(stockcode: Int, quantity: Int) {
        self.stockcode = stockcode
        self.quantity = quantity
    }

    /// What a product reference `text` is sent as: a product link's URL or a bare stockcode.
    public static func reference(for text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let stockcode = Int(trimmed), stockcode > 0, trimmed.allSatisfy(\.isASCII) { return trimmed }
        return ProductLink.parse(trimmed)?.url.absoluteString
    }
}

/// One candidate product being edited: a Woolworths product URL or a stockcode, and a quantity.
public struct CandidateEntry: Identifiable, Equatable, Sendable {
    public let id: UUID
    public var product: String
    public var quantity: Int

    public init(id: UUID = UUID(), product: String, quantity: Int) {
        self.id = id
        self.product = product
        self.quantity = quantity
    }

    /// The error for this entry's product field, suppressed while it's still blank.
    public var productError: String? {
        let blank = product.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return blank || ItemCandidate.reference(for: product) != nil
            ? nil : "Enter a woolworths.com.au product link or a stockcode."
    }
}
