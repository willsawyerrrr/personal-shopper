import PersonalShopperKit
import SwiftUI

struct ItemsView: View {
    let session: Session
    @State private var groups: [ItemGroup] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var adding = false
    @State private var editing: ItemGroup?

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                ForEach(groups) { group in
                    Button { editing = group } label: {
                        VStack(alignment: .leading) {
                            Text(group.title)
                                .font(.headline)
                            Text(group.wordsText)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            Text(group.detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .tint(.primary)
                }
                .onDelete { offsets in
                    let removed = offsets.map { groups[$0] }
                    Task { await remove(removed) }
                }
            }
            .overlay {
                if !session.signedIn {
                    ContentUnavailableView("Signed out", systemImage: "person.crop.circle.badge.exclamationmark", description: Text("Sign in with Google in Settings."))
                } else if loaded, groups.isEmpty, error == nil {
                    ContentUnavailableView("No items", systemImage: "cart", description: Text("Tap + or share a Woolworths product to this app."))
                }
            }
            .navigationTitle("Items")
            .toolbar {
                Button("Add", systemImage: "plus") { adding = true }
            }
            .refreshable { await load() }
            .task(id: session.signedIn) { await load() }
            .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) {
                AddItemSheet(store: session.store)
            }
            .sheet(item: $editing, onDismiss: { Task { await load() } }) { group in
                EditItemSheet(group: group, store: session.store)
            }
        }
    }

    private func load() async {
        defer {
            loaded = true
            session.refresh()
        }
        guard session.signedIn else {
            groups = []
            return
        }
        do {
            groups = ItemGroup.group(try await session.store.client().items())
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remove(_ removed: [ItemGroup]) async {
        do {
            let client = try session.store.client()
            for group in removed { try await client.remove(group) }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        session.refresh()
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
