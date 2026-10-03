import Foundation
import Observation

/// State behind the add-item form shared by the app and the share extension.
@MainActor
@Observable
public final class AddItemModel {
    public enum Phase: Equatable {
        case editing
        case submitting
        case added
        case failed(String)
    }

    public var urlText: String
    public var word = ""
    public var name = ""
    public var quantity = 1
    public private(set) var phase = Phase.editing

    private let makeClient: @MainActor () throws -> AdminClient

    public init(urlText: String = "", makeClient: @escaping @MainActor () throws -> AdminClient) {
        self.urlText = urlText
        self.makeClient = makeClient
        applySuggestions()
    }

    public var link: ProductLink? { ProductLink.parse(urlText) }

    public var canSubmit: Bool {
        link != nil && !word.trimmingCharacters(in: .whitespaces).isEmpty && phase != .submitting
    }

    /// Fills the name and trigger word from the URL for whichever the user hasn't typed.
    public func applySuggestions() {
        guard let suggested = link?.suggestedName else { return }
        if name.isEmpty { name = suggested }
        if word.isEmpty { word = suggested.lowercased() }
    }

    public func submit() async {
        guard let link, canSubmit else { return }
        phase = .submitting
        do {
            let client = try makeClient()
            let trimmedName = name.trimmingCharacters(in: .whitespaces)
            try await client.add(
                word: word.trimmingCharacters(in: .whitespaces),
                url: link.url,
                name: trimmedName.isEmpty ? nil : trimmedName,
                quantity: quantity
            )
            phase = .added
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    public func dismissFailure() {
        if case .failed = phase { phase = .editing }
    }
}
