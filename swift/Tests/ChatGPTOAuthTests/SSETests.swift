import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import ChatGPTOAuth

final class SSETests: XCTestCase {
    func testChunkSplitMultilineDoneAndUnknownEvents() throws {
        let chunks = [
            "event: response.output_",
            "text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n",
            "event: future.event\ndata: first\ndata: second\n\n",
            "data: [DO",
            "NE]\r",
            "\n\r\n",
            "event: ignored\ndata: after\n\n",
        ]
        var parser = SSEParser()
        var events: [ResponseEvent] = []
        for chunk in chunks {
            events.append(contentsOf: try parser.consume(Data(chunk.utf8)))
        }
        events.append(contentsOf: try parser.finish())

        XCTAssertEqual(events, [
            ResponseEvent(
                type: "response.output_text.delta",
                data: .object([
                    "type": .string("response.output_text.delta"),
                    "delta": .string("Hi"),
                ]),
                delta: "Hi"
            ),
            ResponseEvent(type: "future.event", data: .string("first\nsecond")),
        ])
    }

    func testLastEventNameWinsCommentsAreIgnoredAndTrailingBlockIsParsed() throws {
        let payload = """
        : keepalive
        event: old
        event: current
        data: opaque
        """
        XCTAssertEqual(
            try parseSSE(Data(payload.utf8)),
            [ResponseEvent(type: "current", data: .string("opaque"))]
        )
    }

    func testUTF8ScalarMayBeSplitAcrossChunks() throws {
        let payload = Data("data: café\n\n".utf8)
        let split = payload.firstIndex(of: 0xC3)!
        var parser = SSEParser()
        XCTAssertTrue(try parser.consume(payload[..<payload.index(after: split)]).isEmpty)
        let events = try parser.consume(payload[payload.index(after: split)...]) + parser.finish()
        XCTAssertEqual(events, [ResponseEvent(type: "message", data: .string("café"))])
    }

    func testJSONTypeOverridesSSENameAndDeltaIsExposed() throws {
        let payload = Data("event: fallback\ndata: {\"type\":\"custom\",\"delta\":\"x\"}\n\n".utf8)
        XCTAssertEqual(
            try parseSSE(payload),
            [ResponseEvent(
                type: "custom",
                data: .object(["type": .string("custom"), "delta": .string("x")]),
                delta: "x"
            )]
        )
    }

    func testClientUsesExactWireShapeRetriesOne401AndReusesSessionID() async throws {
        let (auth, client) = try await makeClient(protocolClass: ClientFixtureProtocol.self)
        let request = ResponseRequest(model: "gpt-test", input: .text("hello"))
        let first = try await client.respond(request)
        let second = try await client.respond(request)

        XCTAssertEqual(first.outputText, second.outputText)
        XCTAssertNotNil(UUID(uuidString: first.outputText))
        let status = try await auth.status(subject: "app-user")
        let rateLimits = await client.lastRateLimits
        XCTAssertEqual(status?.accountID, "acct-1")
        XCTAssertEqual(rateLimits?.primary?.usedPercent, 25.5)
    }

    func testClientSurfacesTypedSecond401AndRedactsFailureBodies() async throws {
        let (_, rejected) = try await makeClient(protocolClass: AlwaysUnauthorizedProtocol.self)
        do {
            _ = try await rejected.respond(ResponseRequest(model: "gpt-test", input: .text("hello")))
            XCTFail("Expected authentication failure")
        } catch {
            XCTAssertEqual(
                error as? ChatGPTOAuthError,
                .authentication(message: "Authentication was rejected after one refresh retry.")
            )
        }

        let secret = "sk-transport-secret"
        let (_, failed) = try await makeClient(protocolClass: SecretFailureProtocol.self)
        do {
            _ = try await failed.respond(ResponseRequest(model: "gpt-test", input: .text("hello")))
            XCTFail("Expected transport failure")
        } catch {
            XCTAssertFalse(error.localizedDescription.contains(secret))
            XCTAssertTrue(error.localizedDescription.contains("[REDACTED]"))
        }
    }

    private func makeClient(protocolClass: URLProtocol.Type) async throws -> (AuthSession, SubscriptionAI) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        let urlSession = URLSession(configuration: configuration)
        let protocolConfiguration = ProtocolConfiguration(
            tokenURL: URL(string: "https://fixture.example/token")!,
            responsesURL: URL(string: "https://fixture.example/responses")!
        )
        let store = MemoryCredentialStore()
        _ = try await store.compareAndSwap(
            subject: "app-user",
            expectedVersion: 0,
            next: TokenSet(
                accessToken: "access-old",
                refreshToken: "refresh-old",
                expiresAt: 9_999_999_999_999,
                accountID: "acct-1",
                version: 0
            )
        )
        let auth = AuthSession(
            store: store,
            session: urlSession,
            now: { 1_000 },
            sleep: { _ in },
            protocolConfiguration: protocolConfiguration
        )
        return (
            auth,
            SubscriptionAI(
                auth: auth,
                subject: "app-user",
                session: urlSession,
                protocolConfiguration: protocolConfiguration
            )
        )
    }
}

private final class ClientFixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        if request.url?.path == "/token" {
            respond(status: 200, body: #"{"access_token":"access-new","refresh_token":"refresh-new","id_token":"e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig","expires_in":3600}"#)
            return
        }
        guard request.value(forHTTPHeaderField: "openai-beta") == "responses=experimental",
              request.value(forHTTPHeaderField: "originator") == "codex_cli_rs",
              request.value(forHTTPHeaderField: "content-type") == "application/json",
              request.value(forHTTPHeaderField: "chatgpt-account-id") == "acct-1",
              let sessionID = request.value(forHTTPHeaderField: "session_id"),
              UUID(uuidString: sessionID) != nil,
              let body = requestBodyData(),
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              object["model"] as? String == "gpt-test",
              // Bare-string input must arrive wrapped as one user message; the backend rejects raw strings.
              (object["input"] as? [[String: Any]])?.first?["role"] as? String == "user",
              ((((object["input"] as? [[String: Any]])?.first?["content"]) as? [[String: Any]])?.first?["text"]) as? String == "hello",
              object["parallel_tool_calls"] as? Bool == false,
              object["store"] as? Bool == false,
              object["stream"] as? Bool == true else {
            respond(status: 418, body: "invalid request shape")
            return
        }
        if request.value(forHTTPHeaderField: "authorization") == "Bearer access-old" {
            respond(status: 401, body: "unauthorized")
        } else {
            let event = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"\(sessionID)\"}\n\n"
                + "data: {\"type\":\"response.completed\"}\n\n"
                + "data: [DONE]\n\n"
            respond(status: 200, body: event, headers: ["x-codex-primary-used-percent": "25.5"])
        }
    }

    private func requestBodyData() -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class AlwaysUnauthorizedProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        if request.url?.path == "/token" {
            respond(status: 200, body: #"{"access_token":"access-new","refresh_token":"refresh-new","id_token":"e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig","expires_in":3600}"#)
        } else {
            respond(status: 401, body: "unauthorized")
        }
    }
}

private final class SecretFailureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        respond(status: 500, body: "failure Authorization: Bearer sk-transport-secret")
    }
}

private extension URLProtocol {
    func respond(status: Int, body: String, headers: [String: String] = [:]) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
