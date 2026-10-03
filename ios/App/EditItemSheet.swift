import PersonalShopperKit
import SwiftUI

struct EditItemSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: EditItemModel

    init(item: Item, store: SettingsStore) {
        _model = State(initialValue: EditItemModel(item: item) { try store.client() })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $model.name)
                    TextField("Trigger phrase, e.g. milk", text: $model.word)
                        .textInputAutocapitalization(.never)
                    if model.wordError != nil {
                        Text(model.wordError ?? "").foregroundStyle(.red).font(.footnote)
                    }
                    Stepper("Quantity: \(model.quantity)", value: $model.quantity, in: EditItemModel.quantityRange)
                }
                Section("Product") {
                    TextField("Woolworths product URL or stockcode", text: $model.product)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    if let error = model.productError {
                        Text(error).foregroundStyle(.red).font(.footnote)
                    }
                }
                if case .failed(let message) = model.phase {
                    Section { Text(message).foregroundStyle(.red) }
                }
            }
            .disabled(model.phase == .submitting || model.phase == .saved)
            .navigationTitle("Edit item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(!model.canSubmit)
                }
            }
        }
    }

    private func save() async {
        await model.submit()
        if model.phase == .saved || model.signedOut { dismiss() }
    }
}
