import Foundation
import Observation

/// State behind the edit-item sheet.
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

    public let item: Item
    public var word: String
    public var name: String
    /// A Woolworths product URL or a stockcode.
    public var product: String
    public var quantity: Int
    public private(set) var phase = Phase.editing
    /// Set when the server rejected the token, so the sheet can close on the signed-out state.
    public private(set) var signedOut = false

    private let makeClient: @MainActor () throws -> AdminClient

    public init(item: Item, makeClient: @escaping @MainActor () throws -> AdminClient) {
        self.item = item
        self.word = item.word
        self.name = item.name ?? ""
        self.product = String(item.stockcode)
        self.quantity = item.quantity
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

    public var wordError: String? {
        word.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Enter a trigger phrase." : nil
    }

    public var canSubmit: Bool {
        wordError == nil && productError == nil && Self.quantityRange.contains(quantity) && phase != .submitting
    }

    public func submit() async {
        guard canSubmit, let productReference else { return }
        phase = .submitting
        do {
            try await makeClient().update(
                word: item.word,
                newWord: word.trimmingCharacters(in: .whitespacesAndNewlines),
                product: productReference,
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
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
