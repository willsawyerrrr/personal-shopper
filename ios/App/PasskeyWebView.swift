import PersonalShopperKit
import SwiftUI
import WebKit

/// A web view on the Woolworths login whose WebAuthn calls are answered by
/// `PasskeyScript`. `onCredential` receives each passkey the page creates for Woolworths.
struct PasskeyWebView: UIViewRepresentable {
    let onCredential: (Any) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCredential: onCredential) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1"
        configuration.userContentController.addUserScript(
            WKUserScript(source: PasskeyScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        configuration.userContentController.add(context.coordinator, name: PasskeyScript.messageHandler)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        #if DEBUG
            webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: PasskeyScript.loginURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onCredential = onCredential
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: PasskeyScript.messageHandler)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var onCredential: (Any) -> Void

        init(onCredential: @escaping (Any) -> Void) { self.onCredential = onCredential }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the Woolworths sign-in frame may hand over a passkey.
            guard message.frameInfo.securityOrigin.host == PasskeyCredential.rpId else { return }
            onCredential(message.body)
        }
    }
}
