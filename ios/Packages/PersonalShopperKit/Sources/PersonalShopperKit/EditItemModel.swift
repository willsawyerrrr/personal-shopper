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

    /// One alternative stockcode/quantity option being edited.
    public struct AlternativeEntry: Identifiable, Equatable, Sendable {
        public let id: UUID
        /// A Woolworths product URL or a stockcode.
        public var product: String
        public var quantity: Int

        public init(id: UUID = UUID(), product: String, quantity: Int) {
            self.id = id
            self.product = product
            self.quantity = quantity
        }
    }

    public static let quantityRange = 1...99
    public static let maxNameLength = 80

    public let group: ItemGroup
    /// The custom display name; empty clears it.
    public var name: String
    /// The trigger phrases: lower-cased, unique, in order.
    public private(set) var words: [String]
    /// The text of the phrase being typed, before it is added to `words`.
    public var newWord = ""
    /// A Woolworths product URL or a stockcode.
    public var product: String
    public var quantity: Int
    /// Other stockcode/quantity options for the same product; the cheapest per unit is added.
    public var alternatives: [AlternativeEntry]
    public private(set) var phase = Phase.editing
    /// Set when the server rejected the token, so the sheet can close on the signed-out state.
    public private(set) var signedOut = false

    private let makeClient: @MainActor () throws -> AdminClient

    public init(group: ItemGroup, makeClient: @escaping @MainActor () throws -> AdminClient) {
        self.group = group
        self.name = group.name ?? ""
        self.words = group.words
        self.product = String(group.stockcode)
        self.quantity = group.quantity
        self.alternatives = (group.alternatives ?? []).map {
            AlternativeEntry(product: String($0.stockcode), quantity: $0.quantity)
        }
        self.makeClient = makeClient
    }

    /// What a product reference `text` is sent as: a product link's URL or a bare stockcode.
    private func reference(for text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let stockcode = Int(trimmed), stockcode > 0, trimmed.allSatisfy(\.isASCII) { return trimmed }
        return ProductLink.parse(trimmed)?.url.absoluteString
    }

    /// What `product` is sent as: a product link's URL or a bare stockcode.
    var productReference: String? { reference(for: product) }

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

    /// Appends a blank alternative for the user to fill in.
    public func addAlternative() {
        alternatives.append(AlternativeEntry(product: "", quantity: 1))
    }

    /// Removes the alternatives at `offsets`.
    public func removeAlternatives(at offsets: IndexSet) {
        alternatives.remove(atOffsets: offsets)
    }

    /// The error for the alternative with `id`, suppressed while its product field is still blank.
    public func alternativeProductError(for id: AlternativeEntry.ID) -> String? {
        guard let entry = alternatives.first(where: { $0.id == id }) else { return nil }
        let blank = entry.product.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return blank || reference(for: entry.product) != nil
            ? nil : "Enter a woolworths.com.au product link or a stockcode."
    }

    /// `alternatives` as sent to the server, or nil while any entry is unresolved.
    private var alternativeInputs: [AlternativeInput]? {
        var inputs: [AlternativeInput] = []
        for entry in alternatives {
            guard let reference = reference(for: entry.product) else { return nil }
            inputs.append(AlternativeInput(product: reference, quantity: entry.quantity))
        }
        return inputs
    }

    public var nameError: String? {
        name.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count > Self.maxNameLength
            ? "Use at most \(Self.maxNameLength) characters." : nil
    }

    public var wordsError: String? {
        words.isEmpty ? "Add at least one trigger phrase." : nil
    }

    public var canSubmit: Bool {
        nameError == nil && wordsError == nil && productError == nil && Self.quantityRange.contains(quantity)
            && alternativeInputs != nil
            && alternatives.allSatisfy { Self.quantityRange.contains($0.quantity) }
            && phase != .submitting
    }

    public func submit() async {
        guard canSubmit, let productReference, let alternativeInputs else { return }
        phase = .submitting
        do {
            try await makeClient().update(
                group,
                words: words,
                product: productReference,
                quantity: quantity,
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                alternatives: alternativeInputs
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
