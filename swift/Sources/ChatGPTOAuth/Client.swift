import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Sends subject-scoped ChatGPT Responses requests with one reactive authentication retry.
public final class SubscriptionAI: Sendable {
    private actor RateLimitState {
        var latest: RateLimitSnapshot?
        func set(_ value: RateLimitSnapshot) { latest = value }
    }

    private let auth: AuthSession
    private let subject: String
    private let session: URLSession
    private let endpoint: URL
    private let sessionID: String
    private let onRateLimits: (@Sendable (RateLimitSnapshot) -> Void)?
    private let rateLimits = RateLimitState()

    /// Creates a client permanently bound to one explicit application subject.
    public init(
        auth: AuthSession,
        subject: String,
        session: URLSession = .shared,
        protocolConfiguration: ProtocolConfiguration = .production,
        sessionID: UUID = UUID(),
        onRateLimits: (@Sendable (RateLimitSnapshot) -> Void)? = nil
    ) {
        self.auth = auth
        self.subject = subject
        self.session = session
        // The backend rejects requests without client_version (400 missing query param).
        var components = URLComponents(url: protocolConfiguration.responsesURL, resolvingAgainstBaseURL: false)!
        var query = components.queryItems ?? []
        if !query.contains(where: { $0.name == "client_version" }) {
            query.append(URLQueryItem(name: "client_version", value: protocolConfiguration.clientVersion))
        }
        components.queryItems = query
        self.endpoint = components.url!
        self.sessionID = sessionID.uuidString.lowercased()
        self.onRateLimits = onRateLimits
    }

    /// Returns the rate-limit headers from the latest successful response, when any request has completed.
    public var lastRateLimits: RateLimitSnapshot? {
        get async { await rateLimits.latest }
    }

    /// Streams parsed response events while forwarding unknown event types unchanged.
    public func stream(_ request: ResponseRequest) -> AsyncThrowingStream<ResponseEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await send(request, retried: false)
                    let snapshot = Self.parseRateLimitHeaders(response)
                    do {
                        var parser = SSEParser()
                        var chunk = Data()
                        for try await byte in bytes {
                            chunk.append(byte)
                            if byte == 10 {
                                for event in try parser.consume(chunk) { continuation.yield(event) }
                                chunk.removeAll(keepingCapacity: true)
                            }
                        }
                        if !chunk.isEmpty {
                            for event in try parser.consume(chunk) { continuation.yield(event) }
                        }
                        for event in try parser.finish() { continuation.yield(event) }
                    } catch {
                        await rateLimits.set(snapshot)
                        onRateLimits?(snapshot)
                        let message = String(redact(error.localizedDescription).prefix(1_024))
                        throw ChatGPTOAuthError.transport(message: "Subscription stream failed: \(message)")
                    }
                    await rateLimits.set(snapshot)
                    onRateLimits?(snapshot)
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    /// Collects output-text deltas and response completion metadata from the streaming API.
    public func respond(_ request: ResponseRequest) async throws -> ResponseResult {
        var events: [ResponseEvent] = []
        var outputText = ""
        var completed: JSONValue?
        for try await event in stream(request) {
            events.append(event)
            if event.type == "response.output_text.delta", let delta = event.delta { outputText += delta }
            if event.type == "response.completed" { completed = event.data }
        }
        return ResponseResult(outputText: outputText, events: events, response: completed)
    }

    private func send(
        _ responseRequest: ResponseRequest,
        retried: Bool
    ) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        let accessToken = retried
            ? try await auth.refreshAccessToken(subject: subject)
            : try await auth.getAccessToken(subject: subject)
        let status = try await auth.status(subject: subject)
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        if let accountID = status?.accountID { request.setValue(accountID, forHTTPHeaderField: "chatgpt-account-id") }
        request.setValue("responses=experimental", forHTTPHeaderField: "openai-beta")
        request.setValue("codex_cli_rs", forHTTPHeaderField: "originator")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(sessionID, forHTTPHeaderField: "session_id")
        request.httpBody = try JSONEncoder().encode(RequestBody(responseRequest))

        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch {
            let message = String(redact(error.localizedDescription).prefix(1_024))
            throw ChatGPTOAuthError.transport(message: "Subscription request failed: \(message)")
        }
        guard let http = response as? HTTPURLResponse else {
            throw ChatGPTOAuthError.transport(message: "Subscription transport returned a non-HTTP response.")
        }
        if http.statusCode == 401 {
            guard !retried else {
                throw ChatGPTOAuthError.authentication(message: "Authentication was rejected after one refresh retry.")
            }
            return try await send(responseRequest, retried: true)
        }
        if http.statusCode == 429 {
            throw ChatGPTOAuthError.rateLimit(retryAfterMilliseconds: Self.retryAfterMilliseconds(http))
        }
        guard (200..<300).contains(http.statusCode) else {
            // Redact before truncation so a long credential cannot lose its delimiter first.
            var previewBytes = Data()
            do {
                for try await byte in bytes {
                    previewBytes.append(byte)
                    if previewBytes.count == 4_096 { break }
                }
            } catch {
                let diagnostic = redact(error.localizedDescription)
                previewBytes.append(contentsOf: " [response read failed: \(diagnostic)]".utf8)
            }
            let preview = String(decoding: previewBytes, as: UTF8.self)
            let snippet = String(redact(preview).prefix(1_024))
            throw ChatGPTOAuthError.transport(
                message: "Subscription transport failed (\(http.statusCode)): \(snippet)"
            )
        }
        return (bytes, http)
    }

    private static func retryAfterMilliseconds(_ response: HTTPURLResponse) -> Int64? {
        guard let raw = response.value(forHTTPHeaderField: "retry-after")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        if let seconds = Double(raw), seconds.isFinite {
            let milliseconds = max(0, seconds * 1_000)
            guard milliseconds < Double(Int64.max) else { return Int64.max }
            return Int64(milliseconds)
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
        guard let date = formatter.date(from: raw) else { return nil }
        let milliseconds = max(0, date.timeIntervalSinceNow * 1_000)
        guard milliseconds < Double(Int64.max) else { return Int64.max }
        return Int64(milliseconds)
    }

    /// Parses finite primary and secondary rate-limit response headers while ignoring malformed windows.
    public static func parseRateLimitHeaders(_ response: HTTPURLResponse) -> RateLimitSnapshot {
        RateLimitSnapshot(
            primary: rateLimitWindow(response, prefix: "primary"),
            secondary: rateLimitWindow(response, prefix: "secondary")
        )
    }

    private static func rateLimitWindow(_ response: HTTPURLResponse, prefix: String) -> RateLimitWindow? {
        guard let usedPercent = finiteHeader(response, "x-codex-\(prefix)-used-percent") else { return nil }
        let windowMinutes = finiteHeader(response, "x-codex-\(prefix)-window-minutes")
        let resetsAt: Int64? = finiteHeader(response, "x-codex-\(prefix)-reset-at").flatMap { value -> Int64? in
            guard value >= Double(Int64.min), value < Double(Int64.max) else { return nil }
            return Int64(value)
        }
        return RateLimitWindow(usedPercent: usedPercent, windowMinutes: windowMinutes, resetsAt: resetsAt)
    }

    private static func finiteHeader(_ response: HTTPURLResponse, _ name: String) -> Double? {
        guard let raw = response.value(forHTTPHeaderField: name)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let value = Double(raw), value.isFinite else { return nil }
        return value
    }
}

private struct RequestBody: Encodable {
    let model: String
    let instructions: String?
    let input: ResponseContent
    let tools: [[String: JSONValue]]?
    let toolChoice: JSONValue?
    let parallelToolCalls = false
    let store = false
    let stream = true
    let reasoning: [String: JSONValue]?
    let include: [String]?

    init(_ request: ResponseRequest) {
        model = request.model
        instructions = request.instructions
        // The backend rejects bare-string input ("Input must be a list"); wrap it as one user message.
        switch request.input {
        case .text(let text):
            input = .items([[
                "type": .string("message"),
                "role": .string("user"),
                "content": .array([.object([
                    "type": .string("input_text"),
                    "text": .string(text),
                ])]),
            ]])
        case .items:
            input = request.input
        }
        tools = request.tools
        toolChoice = request.toolChoice
        reasoning = request.reasoning
        include = request.include
    }

    enum CodingKeys: String, CodingKey {
        case model, instructions, input, tools, reasoning, include, store, stream
        case toolChoice = "tool_choice"
        case parallelToolCalls = "parallel_tool_calls"
    }
}
