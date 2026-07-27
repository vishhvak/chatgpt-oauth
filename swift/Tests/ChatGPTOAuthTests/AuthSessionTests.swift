import Foundation
import XCTest
@testable import ChatGPTOAuth

final class AuthSessionTests: XCTestCase {
    private let subject = "app-user-42"

    func testMemoryStoreIsSubjectKeyedAndOwnsCASVersion() async throws {
        let store = MemoryCredentialStore()
        let proposed = token(accessToken: "subject-a", version: 99)

        let saved = try await store.compareAndSwap(subject: "a", expectedVersion: 0, next: proposed)
        let storedA = try await store.load(subject: "a")
        let storedB = try await store.load(subject: "b")

        XCTAssertTrue(saved.succeeded)
        XCTAssertEqual(saved.current?.version, 1)
        XCTAssertEqual(storedA?.accessToken, "subject-a")
        XCTAssertNil(storedB)

        let lost = try await store.compareAndSwap(
            subject: "a",
            expectedVersion: 0,
            next: token(accessToken: "loser", version: 50)
        )
        XCTAssertFalse(lost.succeeded)
        XCTAssertEqual(lost.current?.accessToken, "subject-a")
    }

    func testConcurrentExpiredCallsShareOneRefresh() async throws {
        let counter = RefreshURLProtocol.counter
        await counter.reset()
        let session = makeSession(
            store: MemoryCredentialStore(initial: [subject: token()]),
            now: { 10_000 }
        )

        let subject = subject
        let values = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<20 {
                group.addTask { try await session.getAccessToken(subject: subject) }
            }
            var values: [String] = []
            for try await value in group { values.append(value) }
            return values
        }

        XCTAssertEqual(Set(values), ["access-new"])
        await counter.waitForValue(1)
        let requestCount = await counter.value()
        XCTAssertEqual(requestCount, 1)
    }

    func testSeparateSessionsOverOneStoreShareOneRefresh() async throws {
        // Singleflight is scoped to (store, subject), not to one AuthSession. An app that builds a
        // session per request over a shared store must still issue exactly one refresh, or a
        // rotating refresh token gets spent twice.
        let counter = RefreshURLProtocol.counter
        await counter.reset()
        let store = MemoryCredentialStore(initial: [subject: token()])
        let sessions = (0..<8).map { _ in makeSession(store: store, now: { 10_000 }) }

        let subject = subject
        let values = try await withThrowingTaskGroup(of: String.self) { group in
            for session in sessions {
                group.addTask { try await session.getAccessToken(subject: subject) }
            }
            var values: [String] = []
            for try await value in group { values.append(value) }
            return values
        }

        XCTAssertEqual(values.count, 8)
        XCTAssertEqual(Set(values), ["access-new"])
        await counter.waitForValue(1)
        let requestCount = await counter.value()
        XCTAssertEqual(requestCount, 1, "eight sessions over one store must share a single refresh")
    }

    func testDistinctStoresDoNotShareARefreshFlight() async throws {
        // The converse: identity keying must not collapse genuinely separate stores together.
        let counter = RefreshURLProtocol.counter
        await counter.reset()
        let subject = subject
        let sessions = (0..<3).map { _ in
            makeSession(store: MemoryCredentialStore(initial: [subject: token()]), now: { 10_000 })
        }

        for session in sessions {
            _ = try await session.getAccessToken(subject: subject)
        }

        await counter.waitForValue(3)
        let requestCount = await counter.value()
        XCTAssertEqual(requestCount, 3, "three independent stores must each refresh")
    }

    func testForcedJoinDoesNotSettleOnSkippedNonForcedFlight() async throws {
        let store = ControlledStore(initial: token(expiresAt: 10_500))
        let counter = RefreshURLProtocol.counter
        await counter.reset()
        let session = makeSession(store: store, now: { 10_000 })
        let subject = subject

        let opportunistic = Task { try await session.getAccessToken(subject: subject) }
        await store.waitUntilFlightLoadStarts()
        let forced = Task { try await session.refreshAccessToken(subject: subject) }
        await store.rotate(to: token(
            accessToken: "access-rotated",
            refreshToken: "refresh-rotated",
            expiresAt: 9_999_999,
            version: 2
        ))
        await store.releaseFlightLoad()

        let opportunisticValue = try await opportunistic.value
        let forcedValue = try await forced.value
        await counter.waitForValue(1)
        let requestCount = await counter.value()
        XCTAssertEqual(opportunisticValue, "access-rotated")
        XCTAssertEqual(forcedValue, "access-new")
        XCTAssertEqual(requestCount, 1)
    }

    func testCASWinnerIsAdoptedInsteadOfClobbered() async throws {
        let winner = token(
            accessToken: "winner-access",
            refreshToken: "winner-refresh",
            expiresAt: 9_999_999,
            version: 2
        )
        let store = RotateDuringCASStore(initial: token(), winner: winner)
        let counter = RefreshURLProtocol.counter
        await counter.reset()
        let session = makeSession(store: store, now: { 10_000 })

        let accessToken = try await session.getAccessToken(subject: subject)
        let stored = try await store.load(subject: subject)
        XCTAssertEqual(accessToken, "winner-access")
        XCTAssertEqual(stored?.accessToken, "winner-access")
    }

    func testTerminalFailureQuarantinesButHealthyConcurrentRotationWins() async throws {
        let counter = RefreshURLProtocol.counter
        await counter.reset()
        let terminalConfiguration = ProtocolConfiguration(
            tokenURL: URL(string: "https://auth.example/terminal")!
        )
        let quarantinedStore = MemoryCredentialStore(initial: [subject: token()])
        let quarantinedSession = makeSession(
            store: quarantinedStore,
            protocolConfiguration: terminalConfiguration
        )

        do {
            _ = try await quarantinedSession.getAccessToken(subject: subject)
            XCTFail("Expected reauthentication")
        } catch let error as ChatGPTOAuthError {
            XCTAssertEqual(error, .reauthRequired(subject: subject, reason: "invalid_grant"))
        }
        let marker = try await quarantinedStore.load(subject: subject)
        XCTAssertEqual(marker?.quarantineReason, "invalid_grant")
        let requestsAfterMarker = await counter.value()
        do {
            _ = try await quarantinedSession.getAccessToken(subject: subject)
            XCTFail("Expected reauthentication")
        } catch {}
        let requestsAfterSecondCall = await counter.value()
        XCTAssertEqual(requestsAfterSecondCall, requestsAfterMarker)

        let winner = token(
            accessToken: "healthy-winner",
            refreshToken: "healthy-refresh",
            expiresAt: 9_999_999,
            version: 2
        )
        let conflictStore = TerminalConflictStore(initial: token(), winner: winner)
        let conflictSession = makeSession(
            store: conflictStore,
            protocolConfiguration: terminalConfiguration
        )
        let adopted = try await conflictSession.getAccessToken(subject: subject)
        let winningToken = try await conflictStore.load(subject: subject)
        XCTAssertEqual(adopted, "healthy-winner")
        XCTAssertNil(winningToken?.quarantinedAt)
    }

    func testDisabledStatusDoesNotTouchStoreAndLogoutRemainsAvailable() async throws {
        let store = CountingStore()
        let session = makeSession(store: store, disabled: { true })

        do {
            _ = try await session.status(subject: subject)
            XCTFail("Expected disabled")
        } catch {
            XCTAssertEqual(error as? ChatGPTOAuthError, .disabled)
        }
        let loads = await store.loads()
        XCTAssertEqual(loads, 0)
        try await session.logout(subject: subject)
        let deletes = await store.deletes()
        XCTAssertEqual(deletes, 1)
    }

    func testEmptySubjectsAreRejected() async throws {
        let store = MemoryCredentialStore()
        await XCTAssertThrowsErrorAsync(try await store.load(subject: ""))
        let session = makeSession(store: store)
        await XCTAssertThrowsErrorAsync(try await session.getAccessToken(subject: ""))
    }

    private func makeSession(
        store: any CredentialStore,
        now: @escaping @Sendable () -> Int64 = { 10_000 },
        disabled: @escaping @Sendable () -> Bool = { false },
        protocolConfiguration: ProtocolConfiguration = .production
    ) -> AuthSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RefreshURLProtocol.self]
        return AuthSession(
            store: store,
            session: URLSession(configuration: configuration),
            now: now,
            sleep: { _ in },
            disabled: disabled,
            protocolConfiguration: protocolConfiguration
        )
    }

    private func token(
        accessToken: String = "access-old",
        refreshToken: String = "refresh-old",
        expiresAt: Int64 = 1,
        version: Int = 1
    ) -> TokenSet {
        TokenSet(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: expiresAt,
            version: version
        )
    }
}

private final class RefreshURLProtocol: URLProtocol {
    static let counter = RequestCounter()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let counter = Self.counter
        Task { await counter.increment() }
        let isTerminal = request.url?.path == "/terminal"
        let data = isTerminal
            ? Data(#"{"error":"invalid_grant"}"#.utf8)
            : Data(#"{"access_token":"access-new","refresh_token":"refresh-new","expires_in":3600}"#.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: isTerminal ? 400 : 200,
            httpVersion: nil,
            headerFields: ["content-type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private actor RequestCounter {
    private var count = 0
    func increment() { count += 1 }
    func value() -> Int { count }
    func reset() { count = 0 }
    func waitForValue(_ expected: Int) async {
        while count < expected { await Task.yield() }
    }
}

private actor ControlledStore: CredentialStore {
    private var current: TokenSet
    private var loadCount = 0
    private var startedContinuation: CheckedContinuation<Void, Never>?
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(initial: TokenSet) { current = initial }

    func load(subject: String) async throws -> TokenSet? {
        loadCount += 1
        if loadCount == 2 {
            startedContinuation?.resume()
            startedContinuation = nil
            await withCheckedContinuation { releaseContinuation = $0 }
        }
        return current
    }

    func compareAndSwap(subject: String, expectedVersion: Int, next: TokenSet) async throws -> CompareAndSwapResult {
        guard current.version == expectedVersion else {
            return CompareAndSwapResult(succeeded: false, current: current)
        }
        var stored = next
        stored.version = expectedVersion + 1
        current = stored
        return CompareAndSwapResult(succeeded: true, current: stored)
    }

    func delete(subject: String) async throws {}

    func waitUntilFlightLoadStarts() async {
        if loadCount >= 2 { return }
        await withCheckedContinuation { startedContinuation = $0 }
    }

    func rotate(to token: TokenSet) { current = token }

    func releaseFlightLoad() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor RotateDuringCASStore: CredentialStore {
    private var current: TokenSet
    private let winner: TokenSet
    private var shouldRotate = true

    init(initial: TokenSet, winner: TokenSet) {
        current = initial
        self.winner = winner
    }

    func load(subject: String) async throws -> TokenSet? { current }

    func compareAndSwap(subject: String, expectedVersion: Int, next: TokenSet) async throws -> CompareAndSwapResult {
        if shouldRotate {
            current = winner
            shouldRotate = false
        }
        return CompareAndSwapResult(succeeded: false, current: current)
    }

    func delete(subject: String) async throws {}
}

private actor TerminalConflictStore: CredentialStore {
    private var current: TokenSet
    private let winner: TokenSet

    init(initial: TokenSet, winner: TokenSet) {
        current = initial
        self.winner = winner
    }

    func load(subject: String) async throws -> TokenSet? { current }

    func compareAndSwap(subject: String, expectedVersion: Int, next: TokenSet) async throws -> CompareAndSwapResult {
        current = winner
        return CompareAndSwapResult(succeeded: false, current: current)
    }

    func delete(subject: String) async throws {}
}

private actor CountingStore: CredentialStore {
    private var loadCount = 0
    private var deleteCount = 0

    func load(subject: String) async throws -> TokenSet? {
        loadCount += 1
        return nil
    }

    func compareAndSwap(subject: String, expectedVersion: Int, next: TokenSet) async throws -> CompareAndSwapResult {
        CompareAndSwapResult(succeeded: true, current: next)
    }

    func delete(subject: String) async throws { deleteCount += 1 }
    func loads() -> Int { loadCount }
    func deletes() -> Int { deleteCount }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error", file: file, line: line)
    } catch {}
}
