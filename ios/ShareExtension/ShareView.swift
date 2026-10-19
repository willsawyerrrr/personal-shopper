import PersonalShopperKit
import SwiftUI

struct ShareView: View {
    @Bindable var model: AddItemModel
    let hasLink: Bool
    let signInState: SignInState
    let finish: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if case .unreadable(let reason) = signInState {
                    ContentUnavailableView(
                        "Can't read your sign-in",
                        systemImage: "key.slash",
                        description: Text(reason)
                    )
                } else if signInState == .signedOut {
                    ContentUnavailableView(
                        "Sign in required",
                        systemImage: "person.crop.circle.badge.exclamationmark",
                        description: Text("Open Personal Shopper to sign in.")
                    )
                } else if hasLink {
                    AddItemForm(model: model, showsURLField: false)
                } else {
                    ContentUnavailableView(
                        "Not a Woolworths product",
                        systemImage: "link.badge.plus",
                        description: Text("Share a woolworths.com.au product page.")
                    )
                }
            }
            .navigationTitle("Add to Personal Shopper")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                if signInState == .signedIn, hasLink {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(model.phase == .submitting ? "Adding…" : "Add") { Task { await submit() } }
                            .disabled(!model.canSubmit)
                    }
                }
            }
        }
    }

    private func submit() async {
        await model.submit()
        if model.phase == .added {
            try? await Task.sleep(for: .seconds(0.8))
            finish()
        }
    }
}
