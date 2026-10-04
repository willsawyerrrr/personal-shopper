import Foundation
import Observation

/// State behind the edit-item sheet, which edits a product and all its trigger words.
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
    /// The trigger words, separated by commas.
    public var words: String
    /// A Woolworths product URL or a stockcode.
    public var product: String
    public var quantity: Int
    public private(set) var phase = Phase.editing
    /// Set when the server rejected the token, so the sheet can close on the signed-out state.
    public private(set) var signedOut = false

    private let makeClient: @MainActor () throws -> AdminClient

    public init(group: ItemGroup, makeClient: @escaping @MainActor () throws -> AdminClient) {
        self.group = group
        self.words = group.wordsText
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

    /// `words` split on commas, trimmed, lower-cased and de-duplicated.
    public var parsedWords: [String] {
        var seen = Set<String>()
        return words.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public var wordsError: String? {
        parsedWords.isEmpty ? "Enter at least one trigger word." : nil
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
                words: parsedWords,
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
