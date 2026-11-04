import AppIntents
import PersonalShopperKit

struct AddItemIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Woolworths Product"
    static let description = IntentDescription(
        "Adds a Woolworths product to your Personal Shopper list so a trigger word puts it in your cart.")

    @Parameter(title: "Product URL", requestValueDialog: "Which Woolworths product link?")
    var url: URL

    @Parameter(title: "Trigger Word", description: "Defaults to the name in the link.")
    var word: String?

    @Parameter(title: "Quantity", default: 1, inclusiveRange: (1, 99))
    var quantity: Int

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$url) as \(\.$word)") {
            \.$quantity
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let link = ProductLink.parse(url) else { throw AddItemIntentError.notAProduct }
        guard let trigger = word?.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? link.suggestedName?.lowercased()
        else { throw AddItemIntentError.noWord }
        do {
            try await SettingsStore().client().add(word: trigger, url: link.url, quantity: quantity)
        } catch {
            throw AddItemIntentError.failed(error.localizedDescription)
        }
        return .result(dialog: "Added \(trigger).")
    }
}

enum AddItemIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notAProduct
    case noWord
    case failed(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notAProduct: "That isn't a woolworths.com.au product link."
        case .noWord: "Give a trigger word for the product."
        case .failed(let message): "\(message)"
        }
    }
}

struct AddToCartIntent: AppIntent {
    static let title: LocalizedStringResource = "Add to My Cart"
    static let description = IntentDescription("Adds an item you've mapped in Personal Shopper to your Personal Shopper cart.")
    static let openAppWhenRun = false

    @Parameter(title: "Item", requestValueDialog: "What do you want to add?")
    var item: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$item) to my cart")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let spoken = item.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let dialog = try await SettingsStore().client().addToCartDialog(item: spoken)
            return .result(dialog: "\(dialog)")
        } catch {
            throw AddItemIntentError.failed(error.localizedDescription)
        }
    }
}

struct AddManyToCartIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Many to My Cart"
    static let description = IntentDescription(
        "Keeps asking what to add to your cart until you say \"that's it\".")
    static let openAppWhenRun = false

    @Parameter(title: "Item", requestValueDialog: "What do you want to add?")
    var item: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add several items to my cart")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let client = try SettingsStore().client()
        var spoken = item
        while !DoneSpeech.isDone(spoken) {
            let reply: String
            do {
                reply = try await client.addToCartDialog(item: spoken.trimmingCharacters(in: .whitespacesAndNewlines))
            } catch {
                throw AddItemIntentError.failed(error.localizedDescription)
            }
            spoken = try await $item.requestValue(IntentDialog("\(reply). What next?"))
        }
        return .result(dialog: "Okay, that's everything.")
    }
}

struct CheckOutIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Out My Cart"
    static let description = IntentDescription(
        "Sends your Personal Shopper cart to your Woolworths cart. It never places an order.")
    static let openAppWhenRun = false

    static var parameterSummary: some ParameterSummary {
        Summary("Send my cart to Woolworths")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            let result = try await SettingsStore().client().checkOut()
            return .result(dialog: "\(result.dialog)")
        } catch {
            throw AddItemIntentError.failed(error.localizedDescription)
        }
    }
}

struct PersonalShopperShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddToCartIntent(),
            phrases: [
                "Add to my Woolworths cart with \(.applicationName)",
                "Add to my cart with \(.applicationName)",
            ],
            shortTitle: "Add to Cart",
            systemImageName: "cart"
        )
        AppShortcut(
            intent: AddManyToCartIntent(),
            phrases: [
                "Add several items to my cart with \(.applicationName)",
                "Start a shopping list with \(.applicationName)",
            ],
            shortTitle: "Add Many to Cart",
            systemImageName: "cart.fill.badge.plus"
        )
        AppShortcut(
            intent: CheckOutIntent(),
            phrases: [
                "Check out my cart with \(.applicationName)",
                "Send my cart to Woolworths with \(.applicationName)",
                "Check out with \(.applicationName)",
            ],
            shortTitle: "Check Out",
            systemImageName: "cart.badge.checkmark"
        )
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
