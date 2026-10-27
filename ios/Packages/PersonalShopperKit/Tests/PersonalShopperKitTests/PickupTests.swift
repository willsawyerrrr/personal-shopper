import Foundation
import Testing

@testable import PersonalShopperKit

struct PickupLinkTests {
    let link = "https://myorder.woolworths.com.au/pickup/order?token=0b6f1c9e-1d2a-4c3b-9e8f-123456789abc"

    @Test func findsTheLinkInAMessage() {
        #expect(PickupLink.parse("Your order is ready! Tap \(link) when you arrive.") == link)
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
        locate: @escaping @MainActor () async throws -> Coordinates = { Coordinates(latitude: -33.5, longitude: 151.25) }
    ) throws -> PickupModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let client = try AdminClient(
            serverURL: "https://example.test", token: "ps_tok", session: URLSession(configuration: configuration))
        let model = PickupModel(makeClient: { client }, locate: locate)
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

    @Test func adoptTakesALinkFromText() throws {
        let model = try model()
        model.link = ""
        #expect(model.adopt("see \(link)"))
        #expect(model.link == link)
        #expect(!model.adopt("hello"))
        #expect(model.link == link)
    }
}
