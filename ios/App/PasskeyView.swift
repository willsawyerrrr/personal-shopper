import PersonalShopperKit
import SwiftUI

/// Whether the household has a Woolworths passkey, with register, replace and remove.
struct PasskeyView: View {
    let session: Session
    @State private var model: PasskeyModel
    @State private var registering = false

    init(session: Session) {
        self.session = session
        _model = State(initialValue: PasskeyModel { try session.store.client() })
    }

    var body: some View {
        Form {
            if case .failed(let message) = model.phase {
                Section { Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            }
            Section {
                LabeledContent("Status") {
                    switch model.registered {
                    case true?: Text("Registered")
                    case false?: Text("Not registered")
                    case nil: Text("…")
                    }
                }
                Button(model.registered == true ? "Replace passkey" : "Register passkey") {
                    model.dismissFailure()
                    registering = true
                }
                if model.registered == true {
                    Button("Remove passkey", role: .destructive) { Task { await model.remove() } }
                }
            } footer: {
                Text(
                    "The server signs in to Woolworths with this passkey when its session expires. "
                        + "Log in to Woolworths and accept the prompt to create a passkey."
                )
            }
        }
        .navigationTitle("Woolworths passkey")
        .refreshable { await model.load() }
        .task { await model.load() }
        .fullScreenCover(isPresented: $registering) {
            RegisterPasskeyView(model: model) { registering = false }
        }
        .onChange(of: model.registered) { session.refresh() }
    }
}

/// The Woolworths login in a web view whose passkey prompts a software
/// authenticator answers; dismisses itself once the server has the passkey.
private struct RegisterPasskeyView: View {
    let model: PasskeyModel
    let dismiss: () -> Void

    var body: some View {
        NavigationStack {
            PasskeyWebView { message in
                Task {
                    await model.register(message: message)
                    if model.registered == true, model.phase == .idle { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) { status }
            .navigationTitle("Woolworths login")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: dismiss) } }
        }
    }

    @ViewBuilder private var status: some View {
        switch model.phase {
        case .saving:
            Label("Saving your passkey…", systemImage: "arrow.triangle.2.circlepath").padding().frame(maxWidth: .infinity)
                .background(.bar)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red).padding().frame(maxWidth: .infinity)
                .background(.bar)
        case .idle:
            EmptyView()
        }
    }
}
