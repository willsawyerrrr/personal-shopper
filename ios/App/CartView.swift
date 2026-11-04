import PersonalShopperKit
import SwiftUI

struct CartView: View {
    let session: Session
    @State private var entries: [CartEntry] = []
    @State private var result: CheckoutResult?
    @State private var error: String?
    @State private var loaded = false
    @State private var checkingOut = false

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                if let result {
                    Section("Checkout") {
                        Label(result.dialog, systemImage: result.failed.isEmpty ? "checkmark.circle" : "exclamationmark.circle")
                            .foregroundStyle(result.failed.isEmpty ? .green : .orange)
                        ForEach(result.added) { entry in
                            Label("\(entry.title) × \(entry.quantity)", systemImage: "checkmark")
                        }
                        ForEach(result.failed) { entry in
                            VStack(alignment: .leading) {
                                Label(entry.title, systemImage: "xmark")
                                Text(entry.error)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                ForEach(entries) { entry in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(entry.title)
                                .font(.headline)
                            Text(entry.words.joined(separator: ", "))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer()
                        Text("× \(entry.count)")
                            .foregroundStyle(.secondary)
                    }
                    .swipeActions {
                        Button("Remove", systemImage: "trash", role: .destructive) {
                            Task { await remove(entry) }
                        }
                    }
                }
            }
            .overlay {
                if loaded, entries.isEmpty, error == nil {
                    ContentUnavailableView(
                        "Your cart is empty", systemImage: "cart",
                        description: Text("Add items by voice, or swipe an item right on the Items tab."))
                }
            }
            .navigationTitle("Cart")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Check Out", systemImage: "cart.badge.checkmark") { Task { await checkOut() } }
                        .disabled(entries.isEmpty || checkingOut)
                }
            }
            .refreshable { await load() }
            .task(id: session.signedIn) { await load() }
        }
    }

    private func load() async {
        defer {
            loaded = true
            session.refresh()
        }
        guard session.signedIn else {
            entries = []
            return
        }
        do {
            entries = try await session.store.client().cart()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remove(_ entry: CartEntry) async {
        do {
            try await session.store.client().remove(entry)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await load()
    }

    private func checkOut() async {
        checkingOut = true
        defer { checkingOut = false }
        do {
            result = try await session.store.client().checkOut()
            error = nil
        } catch {
            result = nil
            self.error = error.localizedDescription
        }
        await load()
    }
}
