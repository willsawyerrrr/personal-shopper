import Foundation
import Observation

/// State behind the edit-item sheet, which edits an item's name, trigger words and candidate
/// products.
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
    public static let maxNameLength = 80

    public let item: Item
    /// The custom display name; empty clears it.
    public var name: String
    /// The trigger phrases: lower-cased, unique, in order.
    public private(set) var words: [String]
    /// The text of the phrase being typed, before it is added to `words`.
    public var newWord = ""
    /// The item's candidate products; the cheapest per unit is added to the cart.
    public var candidates: [CandidateEntry]
    public private(set) var phase = Phase.editing
    /// Set when the server rejected the token, so the sheet can close on the signed-out state.
    public private(set) var signedOut = false

    private let makeClient: @MainActor () throws -> AdminClient

    public init(item: Item, makeClient: @escaping @MainActor () throws -> AdminClient) {
        self.item = item
        self.name = item.name ?? ""
        self.words = item.words
        self.candidates = item.candidates.map {
            CandidateEntry(product: String($0.stockcode), quantity: $0.quantity)
        }
        self.makeClient = makeClient
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

    /// Appends a blank candidate for the user to fill in.
    public func addCandidate() {
        candidates.append(CandidateEntry(product: "", quantity: 1))
    }

    /// Removes the candidates at `offsets`, unless that would leave none.
    public func removeCandidates(at offsets: IndexSet) {
        var remaining = candidates
        remaining.remove(atOffsets: offsets)
        if !remaining.isEmpty { candidates = remaining }
    }

    public var nameError: String? {
        name.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count > Self.maxNameLength
            ? "Use at most \(Self.maxNameLength) characters." : nil
    }

    public var wordsError: String? {
        words.isEmpty ? "Add at least one trigger phrase." : nil
    }

    /// `candidates` as sent to the server (first candidate, rest), or nil while any entry is
    /// unresolved or none remain.
    private var candidateInputs: (first: CandidateInput, rest: [CandidateInput])? {
        var inputs: [CandidateInput] = []
        for entry in candidates {
            guard let reference = ItemCandidate.reference(for: entry.product) else { return nil }
            inputs.append(CandidateInput(product: reference, quantity: entry.quantity))
        }
        guard let first = inputs.first else { return nil }
        return (first, Array(inputs.dropFirst()))
    }

    public var canSubmit: Bool {
        nameError == nil && wordsError == nil && candidateInputs != nil
            && candidates.allSatisfy { Self.quantityRange.contains($0.quantity) }
            && phase != .submitting
    }

    public func submit() async {
        guard canSubmit, let (first, rest) = candidateInputs else { return }
        phase = .submitting
        do {
            _ = try await makeClient().update(
                item,
                words: words,
                url: first.product,
                quantity: first.quantity,
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                alternatives: rest
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
