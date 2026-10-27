import PersonalShopperKit
import SwiftUI
import UIKit

/// Tells Woolworths the customer is on their way to, or has parked for, a Direct to boot pickup.
struct PickupView: View {
    let session: Session
    @State private var model: PickupModel
    @AppStorage("pickup.readClipboard") private var readClipboard = false
    @Environment(\.scenePhase) private var scenePhase

    init(session: Session) {
        self.session = session
        let location = LocationProvider()
        _model = State(
            initialValue: PickupModel(makeClient: { try session.store.client() }, locate: { try await location.current() })
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                if case .failed(let message) = model.phase {
                    Section { Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
                if let status = model.status {
                    Section("Status") {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(status.statusTitle).font(.headline)
                            Text(status.statusDescription).foregroundStyle(.secondary)
                        }
                        LabeledContent("Collection", value: status.collectionMethod)
                    }
                }
                Section {
                    TextField("https://myorder.woolworths.com.au/…", text: $model.link, axis: .vertical)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(1...4)
                    PasteButton(payloadType: String.self) { strings in
                        if let text = strings.first { model.adopt(text) }
                    }
                } header: {
                    Text("Ready-order link")
                } footer: {
                    Text("Copy the link from the text or email Woolworths sends when your order is ready.")
                }
                Section {
                    Button("I'm on my way", systemImage: "car") { Task { await model.enRoute() } }
                    Button("I've parked in a bay", systemImage: "parkingsign") { Task { await model.arrived() } }
                } footer: {
                    Text("On my way shares your location with Woolworths once, when you tap it.")
                }
                .disabled(model.busy || model.parsedLink == nil)
                Section {
                    Toggle("Use the link on my clipboard", isOn: $readClipboard)
                } footer: {
                    Text(
                        "Fills the link when you open this tab with one copied. iOS may ask to allow pasting "
                            + "unless Paste from Other Apps is set to Allow for Personal Shopper in Settings."
                    )
                }
            }
            .overlay {
                if model.busy { ProgressView().controlSize(.large) }
            }
            .navigationTitle("Pickup")
            .task(id: scenePhase) { await pickUpClipboard() }
        }
    }

    /// Reads the clipboard only once the system reports a web link on it, so a
    /// clipboard without one never triggers the paste prompt.
    private func pickUpClipboard() async {
        guard readClipboard, scenePhase == .active, model.parsedLink == nil else { return }
        let pasteboard = UIPasteboard.general
        let hasLink = (try? await pasteboard.detectedValues(for: [\.probableWebURL]))?.probableWebURL != nil
        guard hasLink, let text = pasteboard.string else { return }
        model.adopt(text)
    }
}
