import SwiftUI

/// Leaves a shared Woolworths ready-order link for the app's Pickup tab and
/// says so, since a share extension cannot open the app itself.
struct PickupShareView: View {
    let leave: () throws -> Bool
    let finish: () -> Void
    @State private var failure: String?

    var body: some View {
        ContentUnavailableView {
            Label(failure == nil ? "Link saved" : "Couldn't save the link", systemImage: failure == nil ? "checkmark.circle" : "exclamationmark.triangle")
        } description: {
            Text(failure ?? "Open Personal Shopper to tell Woolworths you're on your way.")
        } actions: {
            Button("Done", action: finish).buttonStyle(.borderedProminent)
        }
        .task {
            do { _ = try leave() } catch { failure = error.localizedDescription }
        }
    }
}
