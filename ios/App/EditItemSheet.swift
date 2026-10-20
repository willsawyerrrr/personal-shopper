import PersonalShopperKit
import SwiftUI

struct EditItemSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: EditItemModel

    init(group: ItemGroup, store: SettingsStore) {
        _model = State(initialValue: EditItemModel(group: group) { try store.client() })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name (optional)", text: $model.name)
                        .textInputAutocapitalization(.words)
                    if let error = model.nameError {
                        Text(error).foregroundStyle(.red).font(.footnote)
                    }
                }
                Section("Trigger phrases") {
                    ForEach(model.words, id: \.self) { word in
                        Text(ItemGroup.displayCase(word))
                    }
                    .onDelete { model.removeWords(at: $0) }
                    .deleteDisabled(model.words.count <= 1)
                    TextField("Add trigger phrase", text: $model.newWord)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .onSubmit { model.addWord() }
                    if let error = model.wordsError {
                        Text(error).foregroundStyle(.red).font(.footnote)
                    }
                }
                Section {
                    Stepper("Quantity: \(model.quantity)", value: $model.quantity, in: EditItemModel.quantityRange)
                }
                Section("Product") {
                    if let listing = model.group.listing {
                        Text(listing).foregroundStyle(.secondary)
                    }
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
                ToolbarItem(placement: .secondaryAction) { EditButton() }
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
