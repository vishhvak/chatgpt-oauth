import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Supplies injectable transport, clock, sleep, and endpoints for OAuth operations and isolated tests.
struct OAuthRuntime: Sendable {
    /// The URL session used for every OAuth request.
    let session: URLSession
    /// The epoch-millisecond clock used for token and device deadlines.
    let now: @Sendable () -> Int64
    /// The cancellable asynchronous sleeper used for bounded retry and device polling.
    let sleep: @Sendable (Int64) async throws -> Void
    /// The complete wire-protocol configuration.
    let protocolConfiguration: ProtocolConfiguration

    /// Creates an OAuth runtime with production dependencies unless explicitly replaced.
    init(
        session: URLSession = .shared,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) },
        sleep: @escaping @Sendable (Int64) async throws -> Void = { milliseconds in
            try await Task.sleep(nanoseconds: UInt64(max(0, milliseconds)) * 1_000_000)
        },
        protocolConfiguration: ProtocolConfiguration = .production
    ) {
        self.session = session
        self.now = now
        self.sleep = sleep
        self.protocolConfiguration = protocolConfiguration
    }
}

/// Exposes a refresh token-endpoint failure so lifecycle code can quarantine only terminal generations.
struct TokenEndpointFailure: Error, Sendable, Equatable, LocalizedError {
    /// The token endpoint HTTP status.
    let status: Int
    /// The parsed OAuth error code when present.
    let errorCode: String?
    /// Whether the exact failed credential generation requires quarantine.
    let terminal: Bool
    /// The already-redacted diagnostic message.
    let message: String

    /// Creates a classified and redacted token endpoint failure.
    init(status: Int, errorCode: String?, terminal: Bool, message: String) {
        self.status = status
        self.errorCode = errorCode
        self.terminal = terminal
        self.message = redact(message)
    }

    /// Returns the already-redacted endpoint diagnostic.
    var errorDescription: String? { message }
}

/// Owns OAuth browser, token, refresh, and device-flow wire operations without persisting credentials.
struct OAuth: Sendable {
    /// The complete protocol configuration used by this OAuth client.
    let protocolConfiguration: ProtocolConfiguration
    private let session: URLSession
    private let now: @Sendable () -> Int64
    private let sleep: @Sendable (Int64) async throws -> Void

    /// Creates an OAuth client from injectable runtime dependencies.
    init(runtime: OAuthRuntime = OAuthRuntime()) {
        session = runtime.session
        now = runtime.now
        sleep = runtime.sleep
        protocolConfiguration = runtime.protocolConfiguration
    }

    /// Generates PKCE and returns the system-browser authorization URL.
    func beginLogin(redirectURI: URL? = nil) async throws -> PendingLogin {
        let redirectURI = redirectURI ?? protocolConfiguration.loopbackRedirectURL
        let generated = try PKCE.generate()
        var components = URLComponents(url: protocolConfiguration.authorizationURL, resolvingAgainstBaseURL: false)
        var parameters = protocolConfiguration.extraAuthorizationParameters
        parameters.merge([
            "response_type": "code",
            "client_id": protocolConfiguration.clientID,
            "redirect_uri": redirectURI.absoluteString,
            "scope": protocolConfiguration.scopes,
            "code_challenge": generated.challenge,
            "code_challenge_method": "S256",
            "state": generated.state,
        ]) { _, required in required }
        components?.queryItems = parameters.keys.sorted().map { URLQueryItem(name: $0, value: parameters[$0]) }
        guard let url = components?.url else {
            throw ChatGPTOAuthError.transport(message: "Authorization endpoint URL was invalid.")
        }
        return PendingLogin(url: url, state: generated.state, verifier: generated.verifier, redirectURI: redirectURI)
    }

    /// Validates state before callback fields, then exchanges a nonempty authorization code.
    func completeLogin(callbackURL: URL, pending: PendingLogin) async throws -> TokenSet {
        let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value }
        try PKCE.assertState(expected: pending.state, actual: value("state"))
        if let oauthError = value("error") {
            throw ChatGPTOAuthError.authentication(message: "Authorization failed: \(redact(oauthError))")
        }
        guard let code = value("code"), !code.isEmpty else {
            throw ChatGPTOAuthError.authentication(message: "Authorization callback omitted the code.")
        }
        return try await exchange(code: code, verifier: pending.verifier, redirectURI: pending.redirectURI)
    }

    /// Refreshes a credential generation with at most three transient attempts and preserves an omitted refresh token.
    func refresh(_ previous: TokenSet) async throws -> TokenSet {
        for attempt in 0..<3 {
            let request = formRequest(url: protocolConfiguration.tokenURL, values: [
                "grant_type": "refresh_token",
                "client_id": protocolConfiguration.clientID,
                "refresh_token": previous.refreshToken,
                "scope": protocolConfiguration.scopes,
            ])
            let data: Data
            let response: HTTPURLResponse
            do {
                (data, response) = try await send(request)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if attempt < 2 {
                    try await sleep(250 * Int64(1 << attempt))
                    continue
                }
                throw ChatGPTOAuthError.tokenRefresh(message: "Token refresh failed due to a network error.")
            }
            if response.statusCode >= 500, attempt < 2 {
                try await sleep(250 * Int64(1 << attempt))
                continue
            }
            if response.statusCode == 429, attempt < 2 {
                try await sleep(retryAfterMilliseconds(response) ?? 250 * Int64(1 << attempt))
                continue
            }
            guard (200..<300).contains(response.statusCode) else {
                try endpointFailure(data: data, response: response, context: "refresh")
            }
            do {
                return try normalizeToken(data: data, previous: previous)
            } catch {
                throw ChatGPTOAuthError.tokenRefresh(message: "Token refresh returned an invalid response.")
            }
        }
        throw ChatGPTOAuthError.tokenRefresh(message: "Token refresh failed transiently.")
    }

    /// Starts device authorization and returns a value that polls and persists only after successful exchange.
    func startDeviceLogin(
        onComplete: @escaping @Sendable (TokenSet) async throws -> TokenSet
    ) async throws -> DeviceLogin {
        var request = URLRequest(url: protocolConfiguration.deviceUserCodeURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["client_id": protocolConfiguration.clientID])
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await send(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ChatGPTOAuthError.transport(message: "Device authorization failed due to a network error.")
        }
        guard (200..<300).contains(response.statusCode) else {
            try endpointFailure(data: data, response: response, context: "device authorization")
        }
        let payload = try jsonObject(data, context: "OAuth endpoint")
        let userCode = payload["user_code"] as? String ?? payload["usercode"] as? String
        guard let userCode, let deviceAuthID = payload["device_auth_id"] as? String else {
            throw ChatGPTOAuthError.transport(message: "Device authorization returned an invalid response.")
        }
        var initialInterval = deviceMilliseconds(from: payload["interval"], defaultSeconds: 5)
        if initialInterval < 0 { initialInterval = 0 }
        let pollingInterval = initialInterval
        let expiresAt = addingMilliseconds(deviceMilliseconds(from: payload["expires_in"], defaultSeconds: 900), to: now())
        let pollURL = protocolConfiguration.devicePollURL
        let redirectURL = protocolConfiguration.deviceRedirectURL
        let clientID = protocolConfiguration.clientID
        let oauthSession = session
        let clock = now
        let sleeper = sleep
        return DeviceLogin(
            userCode: userCode,
            verificationURL: protocolConfiguration.deviceVerificationURL,
            expiresAt: expiresAt
        ) {
            var interval = pollingInterval
            while clock() < expiresAt {
                try await sleeper(interval)
                if clock() >= expiresAt { break }
                var pollRequest = URLRequest(url: pollURL)
                pollRequest.httpMethod = "POST"
                pollRequest.setValue("application/json", forHTTPHeaderField: "Accept")
                pollRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                pollRequest.httpBody = try JSONSerialization.data(withJSONObject: [
                    "device_auth_id": deviceAuthID,
                    "user_code": userCode,
                ])
                let pollData: Data
                let pollResponse: HTTPURLResponse
                do {
                    let result = try await oauthSession.data(for: pollRequest)
                    guard let http = result.1 as? HTTPURLResponse else {
                        throw ChatGPTOAuthError.transport(message: "Device authorization poll returned a non-HTTP response.")
                    }
                    (pollData, pollResponse) = (result.0, http)
                } catch is CancellationError {
                    throw CancellationError()
                } catch let error as ChatGPTOAuthError {
                    throw error
                } catch {
                    throw ChatGPTOAuthError.transport(message: "Device authorization poll failed due to a network error.")
                }
                let pollBody = (try? jsonObject(pollData, context: "OAuth endpoint")) ?? [:]
                let pollError = pollBody["error"] as? String
                if pollError == "authorization_pending" || pollResponse.statusCode == 403 || pollResponse.statusCode == 404 {
                    continue
                }
                if pollError == "slow_down" {
                    interval += 5_000
                    continue
                }
                guard (200..<300).contains(pollResponse.statusCode) else {
                    throw ChatGPTOAuthError.authentication(message: "Device authorization failed (\(pollResponse.statusCode)).")
                }
                guard let authorizationCode = pollBody["authorization_code"] as? String,
                      let codeVerifier = pollBody["code_verifier"] as? String
                else {
                    throw ChatGPTOAuthError.transport(message: "Device poll returned an invalid success response.")
                }
                let exchangeRequest = formRequest(url: protocolConfiguration.tokenURL, values: [
                    "grant_type": "authorization_code",
                    "client_id": clientID,
                    "code": authorizationCode,
                    "code_verifier": codeVerifier,
                    "redirect_uri": redirectURL.absoluteString,
                ])
                let exchangeData: Data
                let exchangeResponse: HTTPURLResponse
                do {
                    let result = try await oauthSession.data(for: exchangeRequest)
                    guard let http = result.1 as? HTTPURLResponse else {
                        throw ChatGPTOAuthError.transport(message: "Authorization code exchange returned a non-HTTP response.")
                    }
                    (exchangeData, exchangeResponse) = (result.0, http)
                } catch is CancellationError {
                    throw CancellationError()
                } catch let error as ChatGPTOAuthError {
                    throw error
                } catch {
                    throw ChatGPTOAuthError.transport(message: "Authorization code exchange failed due to a network error.")
                }
                guard (200..<300).contains(exchangeResponse.statusCode) else {
                    try endpointFailure(data: exchangeData, response: exchangeResponse, context: "code exchange")
                }
                return try await onComplete(normalizeTokenPayload(data: exchangeData, now: clock(), previous: nil))
            }
            throw ChatGPTOAuthError.authentication(message: "Device authorization expired.")
        }
    }

    private func exchange(code: String, verifier: String, redirectURI: URL) async throws -> TokenSet {
        let request = formRequest(url: protocolConfiguration.tokenURL, values: [
            "grant_type": "authorization_code",
            "client_id": protocolConfiguration.clientID,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirectURI.absoluteString,
        ])
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await send(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ChatGPTOAuthError.transport(message: "Authorization code exchange failed due to a network error.")
        }
        guard (200..<300).contains(response.statusCode) else {
            try endpointFailure(data: data, response: response, context: "code exchange")
        }
        return try normalizeToken(data: data, previous: nil)
    }

    private func normalizeToken(data: Data, previous: TokenSet?) throws -> TokenSet {
        try normalizeTokenPayload(data: data, now: now(), previous: previous)
    }
}

private func normalizeTokenPayload(data: Data, now: Int64, previous: TokenSet?) throws -> TokenSet {
    let payload = try jsonObject(data, context: "OAuth endpoint")
    guard let accessToken = payload["access_token"] as? String else {
        throw ChatGPTOAuthError.transport(message: "Token endpoint returned an invalid response.")
    }
    guard let refreshToken = payload["refresh_token"] as? String ?? previous?.refreshToken else {
        throw ChatGPTOAuthError.transport(message: "Token endpoint omitted the refresh token.")
    }
    let idToken = payload["id_token"] as? String ?? previous?.idToken
    let expiresAt: Int64
    if let seconds = numericValue(payload["expires_in"]), seconds.isFinite {
        let candidate = Double(now) + seconds * 1_000
        if candidate.isFinite, candidate < Double(Int64.max), candidate > Double(Int64.min) {
            expiresAt = Int64(candidate)
        } else {
            expiresAt = now
        }
    } else {
        expiresAt = now
    }
    let claims = extractUnverifiedClaims(idToken: idToken, accessToken: accessToken)
    return TokenSet(
        accessToken: accessToken,
        refreshToken: refreshToken,
        idToken: idToken,
        expiresAt: expiresAt,
        accountID: claims.accountID,
        planType: claims.planType,
        email: claims.email,
        version: (previous?.version ?? 0) + 1
    )
}

private func formRequest(url: URL, values: [String: String]) -> URLRequest {
    var components = URLComponents()
    components.queryItems = values.keys.sorted().map { URLQueryItem(name: $0, value: values[$0]) }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
    return request
}

private func jsonObject(_ data: Data, context: String) throws -> [String: Any] {
    do {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ChatGPTOAuthError.transport(message: "\(context) returned invalid JSON.")
        }
        return object
    } catch let error as ChatGPTOAuthError {
        throw error
    } catch {
        throw ChatGPTOAuthError.transport(message: "\(context) returned invalid JSON.")
    }
}

private func endpointFailure(data: Data, response: HTTPURLResponse, context: String) throws -> Never {
    let body = String(decoding: data, as: UTF8.self)
    let redactedBody = redact(body)
    let snippet = String(redactedBody.prefix(1_024))
    let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let errorCode: String? = {
        if let value = parsed?["error"] as? String { return value }
        return (parsed?["error"] as? [String: Any])?["code"] as? String
    }()
    if response.statusCode == 429 {
        throw ChatGPTOAuthError.rateLimit(retryAfterMilliseconds: retryAfterMilliseconds(response))
    }
    let terminalCodes = ["invalid_grant", "invalid_token", "invalid_request"]
    let terminal = response.statusCode == 401 || response.statusCode == 403 ||
        ((400..<500).contains(response.statusCode) && terminalCodes.contains(errorCode ?? ""))
    if context == "refresh" {
        throw TokenEndpointFailure(
            status: response.statusCode,
            errorCode: errorCode,
            terminal: terminal,
            message: "\(context) failed (\(response.statusCode)): \(snippet)"
        )
    }
    throw ChatGPTOAuthError.authentication(message: "\(context) failed (\(response.statusCode)): \(snippet)")
}

private func numericValue(_ value: Any?) -> Double? {
    if let number = value as? NSNumber { return number.doubleValue }
    if let string = value as? String { return Double(string) }
    return nil
}

private func deviceMilliseconds(from value: Any?, defaultSeconds: Double) -> Int64 {
    let seconds = (value as? NSNumber)?.doubleValue ?? defaultSeconds
    guard seconds.isFinite else { return Int64(defaultSeconds * 1_000) }
    let milliseconds = seconds * 1_000
    if milliseconds >= Double(Int64.max) { return Int64.max }
    if milliseconds <= Double(Int64.min) { return Int64.min }
    return Int64(milliseconds)
}

private func addingMilliseconds(_ milliseconds: Int64, to instant: Int64) -> Int64 {
    if milliseconds > 0, instant > Int64.max - milliseconds { return Int64.max }
    if milliseconds < 0, instant < Int64.min - milliseconds { return Int64.min }
    return instant + milliseconds
}

private extension OAuth {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ChatGPTOAuthError.transport(message: "OAuth endpoint returned a non-HTTP response.")
        }
        return (data, http)
    }
}
