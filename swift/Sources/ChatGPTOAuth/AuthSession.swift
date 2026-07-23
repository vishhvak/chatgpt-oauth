import Foundation

/// Coordinates subject-scoped OAuth lifecycle operations, refresh singleflight, CAS persistence, and quarantine.
public actor AuthSession {
    private struct RefreshResult: Sendable {
        let token: TokenSet
        let refreshed: Bool
    }

    private struct RefreshFlight: Sendable {
        let id: UUID
        let force: Bool
        let task: Task<RefreshResult, Error>
    }

    private let store: any CredentialStore
    private let oauth: OAuth
    private let now: @Sendable () -> Int64
    private let disabled: @Sendable () -> Bool
    private let refreshMarginMilliseconds: Int64
    private var flights: [String: RefreshFlight] = [:]

    /// Creates an auth session whose credential operations always require an explicit subject.
    public init(
        store: any CredentialStore,
        session: URLSession = .shared,
        now: @escaping @Sendable () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        },
        sleep: @escaping @Sendable (Int64) async throws -> Void = { milliseconds in
            try await Task.sleep(for: .milliseconds(milliseconds))
        },
        disabled: @escaping @Sendable () -> Bool = { false },
        protocolConfiguration: ProtocolConfiguration = .production
    ) {
        self.store = store
        self.oauth = OAuth(runtime: OAuthRuntime(
            session: session,
            now: now,
            sleep: sleep,
            protocolConfiguration: protocolConfiguration
        ))
        self.now = now
        self.disabled = disabled
        self.refreshMarginMilliseconds = protocolConfiguration.refreshMarginMilliseconds
    }

    /// Begins a redirect login without reading or writing any ambient credential.
    public func beginLogin(subject: String, redirectURI: URL? = nil) async throws -> PendingLogin {
        try requireSubject(subject)
        return try await oauth.beginLogin(redirectURI: redirectURI)
    }

    /// Completes redirect login and persists its token only for the explicit subject.
    public func completeLogin(
        subject: String,
        callbackURL: URL,
        pending: PendingLogin
    ) async throws -> TokenSet {
        try requireSubject(subject)
        if disabled() { throw ChatGPTOAuthError.disabled }
        let token = try await oauth.completeLogin(callbackURL: callbackURL, pending: pending)
        return try await persistFresh(subject: subject, token: token)
    }

    /// Starts device login and persists its eventual token only for the explicit subject.
    public func startDeviceLogin(subject: String) async throws -> DeviceLogin {
        try requireSubject(subject)
        if disabled() { throw ChatGPTOAuthError.disabled }
        return try await oauth.startDeviceLogin { [weak self] token in
            guard let self else {
                throw ChatGPTOAuthError.authentication(message: "The auth session ended before sign-in completed.")
            }
            return try await self.persistFresh(subject: subject, token: token)
        }
    }

    /// Returns the current token set for the explicit subject in one store read, opportunistically
    /// refreshing near expiry, or forcing a network refresh (including after a skipped non-forced
    /// flight) when `forceRefresh` is set.
    public func tokenSet(for subject: String, forceRefresh: Bool = false) async throws -> TokenSet {
        try requireSubject(subject)
        if disabled() { throw ChatGPTOAuthError.disabled }
        if forceRefresh {
            return try await inFlight(subject: subject, force: true).token
        }
        guard let token = try await store.load(subject: subject) else {
            throw ChatGPTOAuthError.reauthRequired(subject: subject, reason: "missing_credentials")
        }
        if token.quarantinedAt != nil {
            throw ChatGPTOAuthError.reauthRequired(
                subject: subject,
                reason: token.quarantineReason ?? "quarantined"
            )
        }
        if token.expiresAt - now() >= refreshMarginMilliseconds {
            return token
        }
        return try await inFlight(subject: subject, force: false).token
    }

    /// Returns a usable access token for the explicit subject, opportunistically refreshing near expiry.
    public func getAccessToken(subject: String) async throws -> String {
        try await tokenSet(for: subject).accessToken
    }

    /// Forces a network refresh for the explicit subject, including after a skipped non-forced flight.
    public func refreshAccessToken(subject: String) async throws -> String {
        try await tokenSet(for: subject, forceRefresh: true).accessToken
    }

    /// Reports connected or quarantined status for exactly one explicit subject.
    public func status(subject: String) async throws -> Session? {
        try requireSubject(subject)
        if disabled() { throw ChatGPTOAuthError.disabled }
        guard let token = try await store.load(subject: subject) else { return nil }
        return Session(
            subject: subject,
            status: token.quarantinedAt == nil ? .connected : .quarantined,
            expiresAt: token.expiresAt,
            accountID: token.accountID,
            planType: token.planType,
            email: token.email,
            reason: token.quarantineReason
        )
    }

    /// Deletes credentials for exactly one explicit subject.
    public func logout(subject: String) async throws {
        try requireSubject(subject)
        try await store.delete(subject: subject)
    }

    private func persistFresh(subject: String, token: TokenSet) async throws -> TokenSet {
        let current = try await store.load(subject: subject)
        let expectedVersion = current?.version ?? 0
        var next = token
        next.version = expectedVersion + 1
        let saved = try await store.compareAndSwap(
            subject: subject,
            expectedVersion: expectedVersion,
            next: next
        )
        if saved.succeeded { return next }
        if let winner = saved.current { return winner }
        throw ChatGPTOAuthError.authentication(message: "Credentials changed while sign-in completed.")
    }

    private func quarantine(subject: String, token: TokenSet, reason: String) async throws -> TokenSet {
        var marker = token
        marker.version = token.version + 1
        marker.quarantinedAt = now()
        marker.quarantineReason = reason
        let result = try await store.compareAndSwap(
            subject: subject,
            expectedVersion: token.version,
            next: marker
        )
        if !result.succeeded, let current = result.current, current.quarantinedAt == nil {
            // A concurrent healthy rotation wins over a stale terminal response.
            return current
        }
        throw ChatGPTOAuthError.reauthRequired(
            subject: subject,
            reason: result.current?.quarantineReason ?? reason
        )
    }

    private func refreshOne(subject: String, force: Bool) async throws -> RefreshResult {
        guard let current = try await store.load(subject: subject) else {
            throw ChatGPTOAuthError.reauthRequired(subject: subject, reason: "missing_credentials")
        }
        if current.quarantinedAt != nil {
            throw ChatGPTOAuthError.reauthRequired(
                subject: subject,
                reason: current.quarantineReason ?? "quarantined"
            )
        }
        if !force, current.expiresAt - now() >= refreshMarginMilliseconds {
            return RefreshResult(token: current, refreshed: false)
        }

        do {
            let next = try await oauth.refresh(current)
            let swapped = try await store.compareAndSwap(
                subject: subject,
                expectedVersion: current.version,
                next: next
            )
            if swapped.succeeded { return RefreshResult(token: next, refreshed: true) }
            if let winner = swapped.current {
                if winner.quarantinedAt != nil {
                    throw ChatGPTOAuthError.reauthRequired(
                        subject: subject,
                        reason: winner.quarantineReason ?? "quarantined"
                    )
                }
                return RefreshResult(token: winner, refreshed: true)
            }
            throw ChatGPTOAuthError.reauthRequired(
                subject: subject,
                reason: "credentials_deleted_during_refresh"
            )
        } catch let failure as TokenEndpointFailure where failure.terminal {
            let reason = failure.errorCode ?? "http_\(failure.status)"
            return RefreshResult(
                token: try await quarantine(subject: subject, token: current, reason: reason),
                refreshed: true
            )
        } catch let failure as TokenEndpointFailure {
            throw ChatGPTOAuthError.tokenRefresh(message: "Token refresh failed (\(failure.status)).")
        }
    }

    private func inFlight(subject: String, force: Bool) async throws -> RefreshResult {
        if let existing = flights[subject] {
            if !force || existing.force { return try await existing.task.value }
            // A forced retry may share a real refresh but cannot settle on a flight that skipped the network.
            let joined = try await existing.task.value
            return joined.refreshed ? joined : try await inFlight(subject: subject, force: true)
        }

        let id = UUID()
        let task = Task { [weak self] in
            guard let self else {
                throw ChatGPTOAuthError.authentication(message: "The auth session ended during refresh.")
            }
            do {
                let result = try await self.refreshOne(subject: subject, force: force)
                await self.clearFlight(subject: subject, id: id)
                return result
            } catch {
                await self.clearFlight(subject: subject, id: id)
                throw error
            }
        }
        flights[subject] = RefreshFlight(id: id, force: force, task: task)
        return try await task.value
    }

    private func clearFlight(subject: String, id: UUID) {
        if flights[subject]?.id == id { flights.removeValue(forKey: subject) }
    }
}
