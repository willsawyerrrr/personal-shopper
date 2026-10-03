import Observation
import PersonalShopperKit

/// Whether a token is stored, for views to show the sign-in state.
@MainActor
@Observable
final class Session {
    let store = SettingsStore()
    private(set) var signedIn: Bool

    init() { signedIn = store.isSignedIn }

    func refresh() { signedIn = store.isSignedIn }
}
