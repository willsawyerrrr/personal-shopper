import PersonalShopperKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await present() }
    }

    private func present() async {
        let text = await sharedText()
        let model = AddItemModel(urlText: text) { try SettingsStore().client() }
        let root = ShareView(model: model, hasLink: model.link != nil, signInState: SettingsStore().signInState) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        } cancel: { [weak self] in
            self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }
        let host = UIHostingController(rootView: root)
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    /// The first shared URL or text that contains a Woolworths product link,
    /// falling back to whatever was shared so the form can explain the problem.
    private func sharedText() async -> String {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var candidates: [String] = []
        for item in items {
            if let text = item.attributedContentText?.string { candidates.append(text) }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                    let url = await provider.object(ofClass: URL.self)
                {
                    candidates.append(url.absoluteString)
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                    let string = await provider.object(ofClass: String.self)
                {
                    candidates.append(string)
                }
            }
        }
        return candidates.first { ProductLink.parse($0) != nil } ?? candidates.first ?? ""
    }
}

extension NSItemProvider {
    @MainActor fileprivate func object<T: _ObjectiveCBridgeable & Sendable>(ofClass type: T.Type) async -> T?
    where T._ObjectiveCType: NSItemProviderReading {
        await withCheckedContinuation { continuation in
            _ = loadObject(ofClass: type) { object, _ in continuation.resume(returning: object) }
        }
    }
}
