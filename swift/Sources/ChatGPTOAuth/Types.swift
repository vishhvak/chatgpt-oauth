import Foundation

/// A recursively typed, Codable, and Sendable JSON value.
public enum JSONValue: Sendable, Equatable, Codable {
    /// A JSON null value.
    case null
    /// A JSON Boolean value.
    case bool(Bool)
    /// A JSON number value.
    case number(Double)
    /// A JSON string value.
    case string(String)
    /// A JSON array value.
    case array([JSONValue])
    /// A JSON object value.
    case object([String: JSONValue])

    /// Decodes one recursively typed JSON value.
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    /// Encodes one recursively typed JSON value.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// Stores one subject's credential generation and unverified display or routing metadata.
public struct TokenSet: Codable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    /// The bearer access token.
    public var accessToken: String
    /// The rotating refresh token.
    public var refreshToken: String
    /// The optional ID token used only for unverified metadata extraction.
    public var idToken: String?
    /// The raw token expiry as epoch milliseconds with no refresh margin subtracted.
    public var expiresAt: Int64
    /// The unverified account routing identifier, never an application subject.
    public var accountID: String?
    /// The unverified plan label for display.
    public var planType: String?
    /// The unverified email address for display.
    public var email: String?
    /// The monotonically increasing compare-and-swap version.
    public var version: Int
    /// The epoch milliseconds at which this generation was quarantined.
    public var quarantinedAt: Int64?
    /// The non-secret reason this generation was quarantined.
    public var quarantineReason: String?

    /// Creates one credential generation without inferring its owning subject.
    public init(
        accessToken: String,
        refreshToken: String,
        idToken: String? = nil,
        expiresAt: Int64,
        accountID: String? = nil,
        planType: String? = nil,
        email: String? = nil,
        version: Int,
        quarantinedAt: Int64? = nil,
        quarantineReason: String? = nil
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
        self.expiresAt = expiresAt
        self.accountID = accountID
        self.planType = planType
        self.email = email
        self.version = version
        self.quarantinedAt = quarantinedAt
        self.quarantineReason = quarantineReason
    }

    /// Describes credential metadata while always replacing every token with a redaction marker.
    public var description: String {
        "TokenSet([REDACTED])"
    }

    /// Reflects credential metadata while always replacing every token with a redaction marker.
    public var debugDescription: String { description }
}

/// Reports whether a compare-and-swap persisted and always returns the current winning value.
public struct CompareAndSwapResult: Sendable, Equatable {
    /// Whether the proposed value won the comparison.
    public let succeeded: Bool
    /// The value current after the operation, or nil when the row is absent.
    public let current: TokenSet?

    /// Creates a compare-and-swap result.
    public init(succeeded: Bool, current: TokenSet?) {
        self.succeeded = succeeded
        self.current = current
    }
}

/// Persists credentials only under an explicit trusted application subject.
public protocol CredentialStore: Sendable {
    /// Loads the credential generation for an explicit subject.
    func load(subject: String) async throws -> TokenSet?
    /// Atomically writes for an explicit subject only when its current version matches the expected version.
    func compareAndSwap(subject: String, expectedVersion: Int, next: TokenSet) async throws -> CompareAndSwapResult
    /// Deletes credentials for an explicit subject.
    func delete(subject: String) async throws
}

/// Retains the browser authorization request state until callback completion.
public struct PendingLogin: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    /// The URL to open in the system authentication session.
    public let url: URL
    /// The state value that must match the callback in constant time.
    public let state: String
    /// The PKCE verifier retained until token exchange.
    public let verifier: String
    /// The exact redirect URI included in both authorization and exchange requests.
    public let redirectURI: URL

    /// Creates a pending browser login.
    public init(url: URL, state: String, verifier: String, redirectURI: URL) {
        self.url = url
        self.state = state
        self.verifier = verifier
        self.redirectURI = redirectURI
    }

    /// Describes a pending login without exposing its URL query, state, or PKCE verifier.
    public var description: String { "PendingLogin([REDACTED])" }

    /// Reflects a pending login without exposing its URL query, state, or PKCE verifier.
    public var debugDescription: String { description }
}

/// Represents a device authorization that can be shown now and awaited later.
public struct DeviceLogin: Sendable {
    /// The user code displayed by the application.
    public let userCode: String
    /// The fixed verification page opened by the user.
    public let verificationURL: URL
    /// The device authorization deadline as epoch milliseconds.
    public let expiresAt: Int64
    private let waitAction: @Sendable () async throws -> TokenSet

    /// Creates a device login backed by one polling operation.
    public init(
        userCode: String,
        verificationURL: URL,
        expiresAt: Int64,
        wait: @escaping @Sendable () async throws -> TokenSet
    ) {
        self.userCode = userCode
        self.verificationURL = verificationURL
        self.expiresAt = expiresAt
        self.waitAction = wait
    }

    /// Polls until authorization succeeds, fails, or reaches its deadline.
    public func wait() async throws -> TokenSet { try await waitAction() }
}

/// Describes whether a stored subject is connected or quarantined.
public enum SessionStatus: String, Codable, Sendable {
    /// The subject has a usable credential generation.
    case connected
    /// The subject must complete a fresh sign-in.
    case quarantined
}

/// Exposes non-secret status for one explicit subject.
public struct Session: Codable, Sendable, Equatable {
    /// The trusted application subject used for the lookup.
    public let subject: String
    /// Whether this generation is connected or quarantined.
    public let status: SessionStatus
    /// The raw access-token expiry as epoch milliseconds.
    public let expiresAt: Int64
    /// The unverified account routing identifier.
    public let accountID: String?
    /// The unverified plan label.
    public let planType: String?
    /// The unverified email address.
    public let email: String?
    /// The quarantine reason when status is quarantined.
    public let reason: String?

    /// Creates a non-secret subject status snapshot.
    public init(subject: String, status: SessionStatus, expiresAt: Int64, accountID: String? = nil, planType: String? = nil, email: String? = nil, reason: String? = nil) {
        self.subject = subject
        self.status = status
        self.expiresAt = expiresAt
        self.accountID = accountID
        self.planType = planType
        self.email = email
        self.reason = reason
    }
}

/// Supplies either text or structured response input.
public enum ResponseContent: Sendable, Equatable, Codable {
    /// Plain text input.
    case text(String)
    /// Structured Responses API input items.
    case items([[String: JSONValue]])

    /// Decodes text or structured input.
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) { self = .text(value) }
        else { self = .items(try container.decode([[String: JSONValue]].self)) }
    }

    /// Encodes text or structured input.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let value): try container.encode(value)
        case .items(let value): try container.encode(value)
        }
    }
}

/// Describes one ChatGPT Responses request while fixed safety fields remain library-owned.
public struct ResponseRequest: Sendable, Equatable {
    /// The required model identifier.
    public var model: String
    /// Text or structured response input.
    public var input: ResponseContent
    /// Optional system instructions.
    public var instructions: String?
    /// Optional tool declarations.
    public var tools: [[String: JSONValue]]?
    /// Optional tool selection policy.
    public var toolChoice: JSONValue?
    /// Optional reasoning configuration.
    public var reasoning: [String: JSONValue]?
    /// Optional response fields to include.
    public var include: [String]?

    /// Creates a response request without exposing fixed transport flags.
    public init(model: String, input: ResponseContent, instructions: String? = nil, tools: [[String: JSONValue]]? = nil, toolChoice: JSONValue? = nil, reasoning: [String: JSONValue]? = nil, include: [String]? = nil) {
        self.model = model
        self.input = input
        self.instructions = instructions
        self.tools = tools
        self.toolChoice = toolChoice
        self.reasoning = reasoning
        self.include = include
    }
}

/// Carries one parsed SSE event, including output text deltas when present.
public struct ResponseEvent: Sendable, Equatable {
    /// The JSON type field or SSE event name.
    public let type: String
    /// Parsed JSON or opaque string event data.
    public let data: JSONValue
    /// The text delta for response.output_text.delta events.
    public let delta: String?

    /// Creates one response event.
    public init(type: String, data: JSONValue, delta: String? = nil) {
        self.type = type
        self.data = data
        self.delta = delta
    }
}

/// Collects streamed output, every event, and optional completion metadata.
public struct ResponseResult: Sendable, Equatable {
    /// The concatenated output-text deltas.
    public let outputText: String
    /// Every parsed event before completion.
    public let events: [ResponseEvent]
    /// The response.completed payload when supplied.
    public let response: JSONValue?

    /// Creates a collected response result.
    public init(outputText: String, events: [ResponseEvent], response: JSONValue? = nil) {
        self.outputText = outputText
        self.events = events
        self.response = response
    }
}

/// Describes one backend rate-limit window.
public struct RateLimitWindow: Sendable, Equatable {
    /// The percentage of the window already used.
    public let usedPercent: Double
    /// The optional window length in minutes.
    public let windowMinutes: Double?
    /// The optional reset instant as epoch seconds.
    public let resetsAt: Int64?

    /// Creates a rate-limit window snapshot.
    public init(usedPercent: Double, windowMinutes: Double? = nil, resetsAt: Int64? = nil) {
        self.usedPercent = usedPercent
        self.windowMinutes = windowMinutes
        self.resetsAt = resetsAt
    }
}

/// Collects primary and secondary backend rate-limit metadata.
public struct RateLimitSnapshot: Sendable, Equatable {
    /// The primary limit window.
    public let primary: RateLimitWindow?
    /// The secondary limit window.
    public let secondary: RateLimitWindow?
    /// The optional plan label returned by the backend.
    public let planType: String?
    /// The optional backend limit name.
    public let limitName: String?

    /// Creates a rate-limit snapshot.
    public init(primary: RateLimitWindow? = nil, secondary: RateLimitWindow? = nil, planType: String? = nil, limitName: String? = nil) {
        self.primary = primary
        self.secondary = secondary
        self.planType = planType
        self.limitName = limitName
    }
}

/// Provides stable machine-readable error codes independent of human-readable descriptions.
public enum ChatGPTOAuthErrorCode: String, Sendable, Equatable {
    /// The callback state did not match.
    case stateMismatch = "state_mismatch"
    /// Fresh sign-in is required.
    case reauthRequired = "reauth_required"
    /// A transient token refresh failed.
    case tokenRefresh = "token_refresh"
    /// The service rate limit was reached.
    case rateLimit = "rate_limit"
    /// Authentication was rejected.
    case authentication = "auth"
    /// Network or response transport failed.
    case transport
    /// Subscription access is disabled.
    case disabled
    /// Credential storage failed.
    case store
}

/// Defines typed, redacted failures without carrying access or refresh tokens.
public enum ChatGPTOAuthError: Error, Sendable, Equatable, LocalizedError, CustomStringConvertible, CustomDebugStringConvertible {
    /// The callback state did not match the pending login.
    case stateMismatch
    /// The subject has no healthy credential generation.
    case reauthRequired(subject: String, reason: String)
    /// A transient refresh failed after bounded retries.
    case tokenRefresh(message: String)
    /// The service rate limit was reached.
    case rateLimit(retryAfterMilliseconds: Int64?)
    /// Authentication was rejected.
    case authentication(message: String)
    /// A network or response transport failed.
    case transport(message: String)
    /// ChatGPT subscription access is disabled by the application.
    case disabled
    /// Credential storage failed.
    case store(message: String)

    /// Returns the stable machine-readable code for this failure.
    public var code: ChatGPTOAuthErrorCode {
        switch self {
        case .stateMismatch: .stateMismatch
        case .reauthRequired: .reauthRequired
        case .tokenRefresh: .tokenRefresh
        case .rateLimit: .rateLimit
        case .authentication: .authentication
        case .transport: .transport
        case .disabled: .disabled
        case .store: .store
        }
    }

    /// Returns a non-secret human-readable failure description.
    public var errorDescription: String? {
        switch self {
        case .stateMismatch: "OAuth state did not match."
        case .reauthRequired(let subject, let reason): "Fresh sign-in required for subject \(String(reflecting: subject)): \(redact(reason))"
        case .tokenRefresh(let message), .authentication(let message), .transport(let message), .store(let message): redact(message)
        case .rateLimit: "The service rate limit was reached."
        case .disabled: "ChatGPT subscription access is disabled."
        }
    }

    /// Describes the failure only through its redacted human-readable message.
    public var description: String { errorDescription ?? code.rawValue }

    /// Reflects the failure only through its redacted human-readable message.
    public var debugDescription: String { description }
}
