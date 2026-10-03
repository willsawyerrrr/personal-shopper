import AppIntents
import PersonalShopperKit

struct AddItemIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Woolworths Product"
    static let description = IntentDescription(
        "Adds a Woolworths product to your Personal Shopper list so a trigger word puts it in your cart.")

    @Parameter(title: "Product URL", requestValueDialog: "Which Woolworths product link?")
    var url: URL

    @Parameter(title: "Trigger Word", description: "Defaults to the product name.")
    var word: String?

    @Parameter(title: "Name", description: "Defaults to the name in the link.")
    var name: String?

    @Parameter(title: "Quantity", default: 1, inclusiveRange: (1, 99))
    var quantity: Int

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$url) as \(\.$word)") {
            \.$name
            \.$quantity
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let link = ProductLink.parse(url) else { throw AddItemIntentError.notAProduct }
        let displayName = name?.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? link.suggestedName
        guard let trigger = word?.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? displayName?.lowercased()
        else { throw AddItemIntentError.noWord }
        do {
            try await SettingsStore().client().add(word: trigger, url: link.url, name: displayName, quantity: quantity)
        } catch {
            throw AddItemIntentError.failed(error.localizedDescription)
        }
        return .result(dialog: "Added \(displayName ?? trigger).")
    }
}

enum AddItemIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notAProduct
    case noWord
    case failed(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notAProduct: "That isn't a woolworths.com.au product link."
        case .noWord: "Give a trigger word or name for the product."
        case .failed(let message): "\(message)"
        }
    }
}

struct PersonalShopperShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddItemIntent(),
            phrases: [
                "Add a product to \(.applicationName)",
                "Add an item to \(.applicationName)",
            ],
            shortTitle: "Add Product",
            systemImageName: "cart.badge.plus"
        )
    }
}

extension String {
    fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
