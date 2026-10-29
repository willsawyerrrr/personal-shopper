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
                    TextField("Name (optional)", text: $model.name)
                        .textInputAutocapitalization(.words)
                    if let error = model.nameError {
                        Text(error).foregroundStyle(.red).font(.footnote)
                    }
                }
                Section("Trigger phrases") {
                    ForEach(model.words, id: \.self) { word in
                        Text(Item.displayCase(word))
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
                    ForEach($model.candidates) { $candidate in
                        VStack(alignment: .leading) {
                            TextField("Woolworths product URL or stockcode", text: $candidate.product)
                                .textInputAutocapitalization(.never)
                                .keyboardType(.URL)
                                .autocorrectionDisabled()
                            if let error = candidate.productError {
                                Text(error).foregroundStyle(.red).font(.footnote)
                            }
                            Stepper(
                                "Quantity: \(candidate.quantity)", value: $candidate.quantity,
                                in: EditItemModel.quantityRange)
                        }
                    }
                    .onDelete { model.removeCandidates(at: $0) }
                    .deleteDisabled(model.candidates.count <= 1)
                    Button("Add product") { model.addCandidate() }
                } header: {
                    Text("Products")
                } footer: {
                    if let listing = model.item.listing {
                        Text(listing)
                    } else {
                        Text("Other stockcode or quantity options for this item; the cheapest per unit is added to the cart.")
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
