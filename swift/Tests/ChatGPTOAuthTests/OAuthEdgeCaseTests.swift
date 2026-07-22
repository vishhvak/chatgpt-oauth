import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import ChatGPTOAuth

final class OAuthEdgeCaseTests: XCTestCase {
    func testBeginLoginIncludesEveryFixedParameter() async throws {
        let oauth = OAuth()
        let redirect = try XCTUnwrap(URL(string: "myapp://oauth/callback"))
        let pending = try await oauth.beginLogin(redirectURI: redirect)
        let items = try XCTUnwrap(URLComponents(url: pending.url, resolvingAgainstBaseURL: false)?.queryItems)
        let values = Dictionary(uniqueKeysWithValues: items.compactMap { item in item.value.map { (item.name, $0) } })
        XCTAssertEqual(values["response_type"], "code")
        XCTAssertEqual(values["client_id"], ProtocolConfiguration.production.clientID)
        XCTAssertEqual(values["redirect_uri"], redirect.absoluteString)
        XCTAssertEqual(values["scope"], ProtocolConfiguration.production.scopes)
        XCTAssertEqual(values["code_challenge_method"], "S256")
        XCTAssertEqual(values["id_token_add_organizations"], "true")
        XCTAssertEqual(values["codex_cli_simplified_flow"], "true")
    }

    func testStateMismatchWinsBeforeCodeOrOAuthError() async throws {
        let oauth = OAuth(runtime: runtime(protocolClass: TokenFixtureProtocol.self))
        let pending = PendingLogin(
            url: URL(string: "https://auth.example/authorize")!,
            state: "expected-state",
            verifier: "verifier",
            redirectURI: URL(string: "https://app.example/callback")!
        )
        do {
            _ = try await oauth.completeLogin(
                callbackURL: URL(string: "https://app.example/callback?state=wrong&error=access_denied&code=secret")!,
                pending: pending
            )
            XCTFail("Expected state mismatch")
        } catch let error as ChatGPTOAuthError {
            XCTAssertEqual(error, .stateMismatch)
            XCTAssertEqual(error.code, .stateMismatch)
        }
    }

    func testStringAndUntrustedExpiryValuesMatchReferenceNormalization() async throws {
        let pending = PendingLogin(
            url: URL(string: "https://auth.example/authorize")!,
            state: "expected-state",
            verifier: "verifier",
            redirectURI: URL(string: "https://app.example/callback")!
        )
        let stringExpiry = try await OAuth(runtime: runtime(protocolClass: StringExpiryProtocol.self, now: 1_000)).completeLogin(
            callbackURL: URL(string: "https://app.example/callback?state=expected-state&code=string")!, pending: pending
        )
        let invalidExpiry = try await OAuth(runtime: runtime(protocolClass: InvalidExpiryProtocol.self, now: 1_000)).completeLogin(
            callbackURL: URL(string: "https://app.example/callback?state=expected-state&code=invalid")!, pending: pending
        )
        let overflowExpiry = try await OAuth(runtime: runtime(protocolClass: OverflowExpiryProtocol.self, now: 1_000)).completeLogin(
            callbackURL: URL(string: "https://app.example/callback?state=expected-state&code=overflow")!, pending: pending
        )
        XCTAssertEqual(stringExpiry.expiresAt, 3_601_000)
        XCTAssertEqual(invalidExpiry.expiresAt, 1_000)
        XCTAssertEqual(overflowExpiry.expiresAt, 1_000)
    }

    func testRefreshClassifiesInvalidGrantAsTerminal() async throws {
        let oauth = OAuth(runtime: runtime(protocolClass: TerminalRefreshProtocol.self))
        do {
            _ = try await oauth.refresh(token())
            XCTFail("Expected terminal failure")
        } catch let failure as TokenEndpointFailure {
            XCTAssertEqual(failure.status, 400)
            XCTAssertEqual(failure.errorCode, "invalid_grant")
            XCTAssertTrue(failure.terminal)
        }
    }

    func testRefreshRetriesRateLimitAndSurfacesRetryAfter() async throws {
        let oauth = OAuth(runtime: runtime(protocolClass: RateLimitProtocol.self))
        do {
            _ = try await oauth.refresh(token())
            XCTFail("Expected rate limit")
        } catch let error as ChatGPTOAuthError {
            XCTAssertEqual(error, .rateLimit(retryAfterMilliseconds: 3_000))
            XCTAssertEqual(error.code, .rateLimit)
        }
    }

    func testRedactionAndTokenReflectionNeverExposeSecrets() {
        let access = "access-secret-value"
        let refresh = "refresh-secret-value"
        let id = "eyJheader.eyJpayload.signature"
        let tokens = TokenSet(accessToken: access, refreshToken: refresh, idToken: id, expiresAt: 1, version: 1)
        for rendered in [tokens.description, tokens.debugDescription, String(describing: tokens), String(reflecting: tokens)] {
            XCTAssertFalse(rendered.contains(access))
            XCTAssertFalse(rendered.contains(refresh))
            XCTAssertFalse(rendered.contains(id))
            XCTAssertTrue(rendered.contains("[REDACTED]"))
        }
        let scrubbed = redact("Bearer \(access) {\"refresh_token\":\"\(refresh)\"}")
        XCTAssertFalse(scrubbed.contains(access))
        XCTAssertFalse(scrubbed.contains(refresh))
        XCTAssertFalse(redact(#"{"access_token":"SECRET\"#).contains("SECRET"))
        XCTAssertTrue(redact("upstream eyJheader.eyJpayload.signature").contains("[REDACTED]"))
        let error = ChatGPTOAuthError.transport(message: "Bearer \(access)")
        XCTAssertFalse(String(reflecting: error).contains(access))

        let pending = PendingLogin(
            url: URL(string: "https://auth.example/authorize?state=state-secret")!,
            state: "state-secret",
            verifier: "verifier-secret",
            redirectURI: URL(string: "myapp://callback")!
        )
        for rendered in [pending.description, pending.debugDescription, String(describing: pending), String(reflecting: pending)] {
            XCTAssertFalse(rendered.contains("state-secret"))
            XCTAssertFalse(rendered.contains("verifier-secret"))
            XCTAssertFalse(rendered.contains("?"))
        }
    }

    private func runtime(protocolClass: URLProtocol.Type, now: Int64 = 10_000) -> OAuthRuntime {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        return OAuthRuntime(
            session: URLSession(configuration: configuration),
            now: { now },
            sleep: { _ in },
            protocolConfiguration: ProtocolConfiguration(
                authorizationURL: URL(string: "https://auth.example/authorize")!,
                tokenURL: URL(string: "https://auth.example/token")!
            )
        )
    }

    private func token() -> TokenSet {
        TokenSet(accessToken: "access-old", refreshToken: "refresh-old", expiresAt: 1, version: 1)
    }
}

private final class TokenFixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { respond(status: 200, body: #"{"access_token":"access-new","refresh_token":"refresh-new","expires_in":3600}"#) }
    override func stopLoading() {}
}

private final class StringExpiryProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { respond(status: 200, body: #"{"access_token":"access-new","refresh_token":"refresh-new","expires_in":"3600"}"#) }
    override func stopLoading() {}
}

private final class InvalidExpiryProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { respond(status: 200, body: #"{"access_token":"access-new","refresh_token":"refresh-new","expires_in":"not-a-number"}"#) }
    override func stopLoading() {}
}

private final class OverflowExpiryProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { respond(status: 200, body: #"{"access_token":"access-new","refresh_token":"refresh-new","expires_in":"1e308"}"#) }
    override func stopLoading() {}
}

private final class TerminalRefreshProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { respond(status: 400, body: #"{"error":"invalid_grant"}"#) }
    override func stopLoading() {}
}

private final class RateLimitProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { respond(status: 429, body: "limited", headers: ["Retry-After": "3"]) }
    override func stopLoading() {}
}

private extension URLProtocol {
    func respond(status: Int, body: String, headers: [String: String] = [:]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
