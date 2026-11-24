import Foundation
import Synchronization
import Testing

@testable import PersonalShopperKit

struct PickupLinkTests {
    let link = "https://myorder.woolworths.com.au/pickup/order?token=0b6f1c9e-1d2a-4c3b-9e8f-123456789abc"

    @Test func findsTheLinkInAMessage() {
        #expect(PickupLink.parse("Your order is ready! Tap \(link) when you arrive.") == link)
    }

    @Test func findsTheShortLinkAsReceived() {
        let short = "https://w.wowpu.com.au/48neum1"
        #expect(PickupLink.parse("Your order is ready! \(short) See you soon") == short)
    }

    @Test func ignoresOtherShortLinks() {
        #expect(PickupLink.parse("https://w.wowpu.com.au/") == nil)
        #expect(PickupLink.parse("https://w.wowpu.com.au/a/b") == nil)
        #expect(PickupLink.parse("http://w.wowpu.com.au/48neum1") == nil)
        #expect(PickupLink.parse("https://w.wowpu.com.au:8443/48neum1") == nil)
        #expect(PickupLink.parse("https://user@w.wowpu.com.au/48neum1") == nil)
        #expect(PickupLink.parse("https://w.wowpu.com.au.evil.test/48neum1") == nil)
        #expect(PickupLink.parse("https://evil.test/w.wowpu.com.au/48neum1") == nil)
    }

    @Test func ignoresOtherLinks() {
        #expect(PickupLink.parse("https://www.woolworths.com.au/pickup/order?token=x") == nil)
        #expect(PickupLink.parse("http://myorder.woolworths.com.au/pickup/order?token=x") == nil)
        #expect(PickupLink.parse("https://myorder.woolworths.com.au/other?token=x") == nil)
        #expect(PickupLink.parse("milk") == nil)
    }
}

@Suite(.serialized)
@MainActor
struct PickupModelTests {
    let link = "https://myorder.woolworths.com.au/pickup/order?token=0b6f1c9e-1d2a-4c3b-9e8f-123456789abc"
    let status = #"{"statusTitle":"On the way","statusDescription":"We'll bring it out.","collectionMethod":"DriveUp"}"#

    private func model(
        locate: @escaping @MainActor () async throws -> Coordinates = { Coordinates(latitude: -33.5, longitude: 151.25) },
        waitForArrival: @escaping @MainActor (PickupStore, Coordinates) async throws -> Void = { _, _ in
            try await Task.sleep(for: .seconds(60))
        }
    ) throws -> PickupModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let client = try AdminClient(
            serverURL: "https://example.test", token: "ps_tok", session: URLSession(configuration: configuration))
        let model = PickupModel(makeClient: { client }, locate: locate, waitForArrival: waitForArrival)
        model.link = link
        return model
    }

    private func body() throws -> [String: Any] {
        let request = try #require(StubURLProtocol.requests.withLock { $0.last })
        let data = try #require(request.httpBody)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func enRouteSendsLinkAndLocation() async throws {
        StubURLProtocol.stub(body: status)
        let model = try model()
        await model.enRoute()
        let request = try #require(StubURLProtocol.requests.withLock { $0.last })
        #expect(request.url?.absoluteString == "https://example.test/pickup/en-route")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ps_tok")
        let sent = try body()
        #expect(sent["link"] as? String == link)
        #expect(sent["latitude"] as? Double == -33.5)
        #expect(sent["longitude"] as? Double == 151.25)
        #expect(model.status?.statusTitle == "On the way")
        #expect(model.phase == .idle)
    }

    @Test func arrivedSendsOnlyTheLink() async throws {
        StubURLProtocol.stub(body: status)
        let model = try model()
        await model.arrived()
        let request = try #require(StubURLProtocol.requests.withLock { $0.last })
        #expect(request.url?.absoluteString == "https://example.test/pickup/arrived")
        #expect(try body() as NSDictionary == ["link": link] as NSDictionary)
        #expect(model.status?.collectionMethod == "DriveUp")
    }

    @Test func locationFailureSendsNothing() async throws {
        StubURLProtocol.stub(body: status)
        let model = try model { throw LocationError.denied }
        await model.enRoute()
        #expect(model.phase == .failed(LocationError.denied.localizedDescription))
        #expect(StubURLProtocol.requests.withLock { $0.isEmpty })
    }

    @Test func rejectsWithoutALinkBeforeCalling() async throws {
        StubURLProtocol.stub(body: status)
        let model = try model()
        model.link = "not a link"
        await model.arrived()
        #expect(model.phase == .failed(AdminError.invalidPickupLink.localizedDescription))
        #expect(StubURLProtocol.requests.withLock { $0.isEmpty })
    }

    @Test(arguments: [
        (422, AdminError.invalidPickupLink), (502, .pickupUnavailable), (429, .rateLimited),
        (401, .unauthorized), (500, .server(status: 500)),
    ])
    func mapsFailureStatuses(status: Int, error: AdminError) async throws {
        StubURLProtocol.stub(status: status, body: #"{"error":"x"}"#)
        let model = try model()
        await model.arrived()
        #expect(model.phase == .failed(error.localizedDescription))
        #expect(model.status == nil)
    }

    private let statusWithStore =
        #"{"statusTitle":"On the way","statusDescription":"","collectionMethod":"DriveUp","store":{"name":"Town Hall","address":"1 George St, Sydney NSW 2000"}}"#
    private let store = PickupStore(name: "Town Hall", address: "1 George St, Sydney NSW 2000")

    private func waitUntil(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func reportsArrivalOnReachingTheStore() async throws {
        StubURLProtocol.stub(body: statusWithStore)
        let watched = Mutex<(PickupStore, Coordinates)?>(nil)
        let model = try model(waitForArrival: { store, near in watched.withLock { $0 = (store, near) } })
        await model.enRoute()
        await waitUntil { StubURLProtocol.requests.withLock { $0.count } == 2 && !model.busy }
        let (store, near) = try #require(watched.withLock { $0 })
        #expect(store == self.store)
        #expect(near == Coordinates(latitude: -33.5, longitude: 151.25))
        let request = try #require(StubURLProtocol.requests.withLock { $0.last })
        #expect(request.url?.absoluteString == "https://example.test/pickup/arrived")
        #expect(try body() as NSDictionary == ["link": link] as NSDictionary)
        #expect(model.watchedStore == nil)
    }

    @Test func stoppingDoesNotReportArrival() async throws {
        StubURLProtocol.stub(body: statusWithStore)
        let model = try model()
        await model.enRoute()
        #expect(model.watchedStore == store)
        model.stopWatching()
        #expect(model.watchedStore == nil)
        try await Task.sleep(for: .milliseconds(50))
        #expect(StubURLProtocol.requests.withLock { $0.count } == 1)
        #expect(model.phase == .idle)
    }

    @Test func parkingByHandStopsWatching() async throws {
        StubURLProtocol.stub(body: statusWithStore)
        let model = try model()
        await model.enRoute()
        await model.arrived()
        #expect(model.watchedStore == nil)
        try await Task.sleep(for: .milliseconds(50))
        #expect(StubURLProtocol.requests.withLock { $0.count } == 2)
    }

    @Test func watchFailureShowsItsMessage() async throws {
        StubURLProtocol.stub(body: statusWithStore)
        let model = try model(waitForArrival: { _, _ in throw LocationError.storeNotFound })
        await model.enRoute()
        await waitUntil { model.watchedStore == nil }
        #expect(model.phase == .failed(LocationError.storeNotFound.localizedDescription))
        #expect(StubURLProtocol.requests.withLock { $0.count } == 1)
    }

    @Test func doesNotWatchWithoutAStore() async throws {
        StubURLProtocol.stub(body: status)
        let model = try model(waitForArrival: { _, _ in Issue.record("watched") })
        await model.enRoute()
        #expect(model.watchedStore == nil)
    }

    @Test func adoptTakesALinkFromText() throws {
        let model = try model()
        model.link = ""
        #expect(model.adopt("see \(link)"))
        #expect(model.link == link)
        #expect(!model.adopt("hello"))
        #expect(model.link == link)
    }
}

struct PickupInboxTests {
    final class MemoryStore: TokenStore, @unchecked Sendable {
        private let value = Mutex<String?>(nil)
        func read() throws -> String? { value.withLock { $0 } }
        func write(_ token: String?) throws { value.withLock { $0 = token } }
    }

    let link = "https://myorder.woolworths.com.au/pickup/order?token=0b6f1c9e-1d2a-4c3b-9e8f-123456789abc"

    @Test func handsOverTheLinkOnce() throws {
        let inbox = PickupInbox(store: MemoryStore())
        #expect(try inbox.leave("Ready! \(link) See you soon"))
        #expect(try inbox.take() == link)
        #expect(try inbox.take() == nil)
    }

    @Test func ignoresTextWithoutAPickupLink() throws {
        let inbox = PickupInbox(store: MemoryStore())
        #expect(try !inbox.leave("https://www.woolworths.com.au/shop/productdetails/1/milk"))
        #expect(try inbox.take() == nil)
    }

    @Test func laterLinkReplacesEarlier() throws {
        let inbox = PickupInbox(store: MemoryStore())
        let other = link.replacingOccurrences(of: "0b6f1c9e", with: "11111111")
        try inbox.leave(link)
        try inbox.leave(other)
        #expect(try inbox.take() == other)
    }
}

@Suite(.serialized)
@MainActor
struct PickupShortcutTests {
    let link = "https://myorder.woolworths.com.au/pickup/order?token=0b6f1c9e-1d2a-4c3b-9e8f-123456789abc"
    let status = #"{"statusTitle":"On the way","statusDescription":"We'll bring it out.","collectionMethod":"DriveUp"}"#
    let inbox = PickupInboxTests.MemoryStore()
    let memory = PickupInboxTests.MemoryStore()

    private func shortcut() throws -> PickupShortcut {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let client = try AdminClient(
            serverURL: "https://example.test", token: "ps_tok", session: URLSession(configuration: configuration))
        return PickupShortcut(
            makeClient: { client }, locate: { Coordinates(latitude: -33.5, longitude: 151.25) },
            inbox: PickupInbox(store: inbox), memory: PickupLinkStore(store: memory))
    }

    @Test func enRouteUsesTheGivenLinkAndRemembersIt() async throws {
        StubURLProtocol.stub(body: status)
        let said = try await shortcut().enRoute(link: " \(link) ")
        #expect(said == "On the way. We'll bring it out.")
        #expect(try memory.read() == link)
    }

    @Test func arrivedFallsBackToTheInboxThenMemory() async throws {
        StubURLProtocol.stub(body: status)
        try inbox.write(link)
        _ = try await shortcut().arrived(link: nil)
        #expect(try inbox.read() == nil)
        #expect(try memory.read() == link)
        StubURLProtocol.stub(body: status)
        _ = try await shortcut().arrived(link: nil)
    }

    @Test func rejectsAnInvalidGivenLink() async throws {
        await #expect(throws: AdminError.invalidPickupLink) { try await shortcut().arrived(link: "milk") }
    }

    @Test func failsWithoutAnyLink() async throws {
        await #expect(throws: AdminError.noPickupLink) { try await shortcut().arrived(link: nil) }
    }
}
