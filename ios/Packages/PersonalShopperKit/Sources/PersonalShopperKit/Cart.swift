import Foundation

/// An item in the Personal Shopper cart and how many of it the cart holds.
public struct CartEntry: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let words: [String]
    public let count: Int

    public init(id: String, title: String, words: [String], count: Int) {
        self.id = id
        self.title = title
        self.words = words
        self.count = count
    }
}

/// A cart entry sent to the Woolworths cart at checkout.
public struct CheckedOutEntry: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let stockcode: Int
    public let quantity: Int
}

/// A cart entry that stayed in the cart because it could not be sent.
public struct FailedEntry: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let error: String
}

/// What checking out sent to the Woolworths cart and what stayed behind.
public struct CheckoutResult: Codable, Sendable, Equatable {
    public let added: [CheckedOutEntry]
    public let failed: [FailedEntry]

    public init(added: [CheckedOutEntry], failed: [FailedEntry]) {
        self.added = added
        self.failed = failed
    }

    /// The sentence to speak or show, e.g. `Added 2 items to your Woolworths cart. Couldn't add Eggs.`
    public var dialog: String {
        if added.isEmpty && failed.isEmpty { return "Your cart is empty." }
        var sentences: [String] = []
        if !added.isEmpty {
            sentences.append("Added \(added.count) \(added.count == 1 ? "item" : "items") to your Woolworths cart.")
        }
        if !failed.isEmpty {
            sentences.append("Couldn't add \(failed.map(\.title).formatted(.list(type: .and))).")
        }
        return sentences.joined(separator: " ")
    }
}
