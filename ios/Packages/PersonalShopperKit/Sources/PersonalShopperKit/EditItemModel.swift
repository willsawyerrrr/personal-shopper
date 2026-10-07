import Foundation
import Observation

/// State behind the edit-item sheet, which edits a product and all its trigger phrases.
@MainActor
@Observable
public final class EditItemModel {
    public enum Phase: Equatable {
        case editing
        case submitting
        case saved
        case failed(String)
    }

    public static let quantityRange = 1...99

    public let group: ItemGroup
    /// The trigger phrases: lower-cased, unique, in order.
    public private(set) var words: [String]
    /// The text of the phrase being typed, before it is added to `words`.
    public var newWord = ""
    /// A Woolworths product URL or a stockcode.
    public var product: String
    public var quantity: Int
    public private(set) var phase = Phase.editing
    /// Set when the server rejected the token, so the sheet can close on the signed-out state.
    public private(set) var signedOut = false

    private let makeClient: @MainActor () throws -> AdminClient

    public init(group: ItemGroup, makeClient: @escaping @MainActor () throws -> AdminClient) {
        self.group = group
        self.words = group.words
        self.product = String(group.stockcode)
        self.quantity = group.quantity
        self.makeClient = makeClient
    }

    /// What `product` is sent as: a product link's URL or a bare stockcode.
    var productReference: String? {
        let trimmed = product.trimmingCharacters(in: .whitespacesAndNewlines)
        if let stockcode = Int(trimmed), stockcode > 0, trimmed.allSatisfy(\.isASCII) { return trimmed }
        return ProductLink.parse(trimmed)?.url.absoluteString
    }

    public var productError: String? {
        productReference == nil ? "Enter a woolworths.com.au product link or a stockcode." : nil
    }

    /// Appends `newWord` to `words`, trimmed, lower-cased and with inner whitespace collapsed,
    /// unless it is empty or already present. Clears `newWord` either way.
    public func addWord() {
        let phrase = newWord.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
        newWord = ""
        if !phrase.isEmpty, !words.contains(phrase) { words.append(phrase) }
    }

    /// Removes the phrases at `offsets`, unless that would leave none.
    public func removeWords(at offsets: IndexSet) {
        var remaining = words
        remaining.remove(atOffsets: offsets)
        if !remaining.isEmpty { words = remaining }
    }

    public var wordsError: String? {
        words.isEmpty ? "Add at least one trigger phrase." : nil
    }

    public var canSubmit: Bool {
        wordsError == nil && productError == nil && Self.quantityRange.contains(quantity) && phase != .submitting
    }

    public func submit() async {
        guard canSubmit, let productReference else { return }
        phase = .submitting
        do {
            try await makeClient().update(
                group,
                words: words,
                product: productReference,
                quantity: quantity
            )
            phase = .saved
        } catch {
            if let error = error as? AdminError, error == .unauthorized || error == .notSignedIn {
                signedOut = true
            }
            phase = .failed(error.localizedDescription)
        }
    }

    public func dismissFailure() {
        if case .failed = phase { phase = .editing }
    }
}
