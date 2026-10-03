import PersonalShopperKit
import SwiftUI

struct ItemsView: View {
    private let store = SettingsStore()
    @State private var items: [Item] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var adding = false

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                ForEach(items) { item in
                    VStack(alignment: .leading) {
                        Text(item.name ?? item.word)
                        Text("\(item.word) · \(item.stockcode) · qty \(item.quantity)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .onDelete { offsets in
                    let removed = offsets.map { items[$0] }
                    Task { await remove(removed) }
                }
            }
            .overlay {
                if loaded, items.isEmpty, error == nil {
                    ContentUnavailableView("No items", systemImage: "cart", description: Text("Tap + or share a Woolworths product to this app."))
                }
            }
            .navigationTitle("Items")
            .toolbar {
                Button("Add", systemImage: "plus") { adding = true }
            }
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) {
                AddItemSheet(store: store)
            }
        }
    }

    private func load() async {
        do {
            items = try await store.client().items()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func remove(_ removed: [Item]) async {
        do {
            let client = try store.client()
            for item in removed { try await client.remove(word: item.word) }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await load()
    }
}

private struct AddItemSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: AddItemModel

    init(store: SettingsStore) {
        _model = State(initialValue: AddItemModel { try store.client() })
    }

    var body: some View {
        NavigationStack {
            AddItemForm(model: model, showsURLField: true)
                .navigationTitle("Add item")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add") { Task { await submit() } }.disabled(!model.canSubmit)
                    }
                }
        }
    }

    private func submit() async {
        await model.submit()
        if model.phase == .added { dismiss() }
    }
}
