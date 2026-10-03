import SwiftUI

/// The add-item fields. `showsURLField` is on in the app, where the URL is
/// pasted, and off in the share extension, where it arrives with the share.
public struct AddItemForm: View {
    @Bindable var model: AddItemModel
    let showsURLField: Bool

    public init(model: AddItemModel, showsURLField: Bool) {
        self.model = model
        self.showsURLField = showsURLField
    }

    public var body: some View {
        Form {
            if showsURLField {
                Section {
                    TextField("Woolworths product URL", text: $model.urlText)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .onChange(of: model.urlText) { model.applySuggestions() }
                    if !model.urlText.isEmpty, model.link == nil {
                        Text("Not a woolworths.com.au product link.").foregroundStyle(.red).font(.footnote)
                    }
                    PasteButton(payloadType: String.self) { strings in
                        if let text = strings.first { model.urlText = text }
                    }
                }
            } else if let link = model.link {
                Section("Product") { Text(link.url.absoluteString).font(.footnote).lineLimit(2) }
            }
            Section {
                TextField("Name", text: $model.name)
                TextField("Trigger word, e.g. milk", text: $model.word)
                    .textInputAutocapitalization(.never)
                Stepper("Quantity: \(model.quantity)", value: $model.quantity, in: 1...99)
            } footer: {
                Text("Say the trigger word to Siri to add this product to your cart.")
            }
            switch model.phase {
            case .failed(let message): Section { Text(message).foregroundStyle(.red) }
            case .added: Section { Label("Added", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            case .editing, .submitting: EmptyView()
            }
        }
        .disabled(model.phase == .submitting || model.phase == .added)
    }
}
