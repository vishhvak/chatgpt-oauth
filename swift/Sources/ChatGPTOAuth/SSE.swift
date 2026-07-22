import Foundation

/// Incrementally frames UTF-8 server-sent events across arbitrary transport chunk boundaries.
public struct SSEParser: Sendable {
    private var buffer: [UInt8] = []
    private var finished = false

    /// Creates an empty incremental SSE parser.
    public init() {}

    /// Consumes one byte chunk and returns every complete event framed by it.
    public mutating func consume(_ chunk: Data) throws -> [ResponseEvent] {
        guard !finished else { return [] }
        buffer.append(contentsOf: chunk)
        normalizeNewlines(atEOF: false)
        return try drainCompleteBlocks()
    }

    /// Parses a final nonempty block even when the stream omitted its terminating blank line.
    public mutating func finish() throws -> [ResponseEvent] {
        guard !finished else { return [] }
        finished = true
        normalizeNewlines(atEOF: true)
        var events = try drainCompleteBlocks()
        if !buffer.isEmpty, let event = try parseBlock(buffer) {
            if event.done { buffer.removeAll(); return events }
            events.append(event.value)
        }
        buffer.removeAll()
        return events
    }

    private mutating func normalizeNewlines(atEOF: Bool) {
        var normalized: [UInt8] = []
        normalized.reserveCapacity(buffer.count)
        var index = 0
        while index < buffer.count {
            guard buffer[index] == 13 else {
                normalized.append(buffer[index])
                index += 1
                continue
            }
            if index + 1 < buffer.count {
                normalized.append(10)
                index += buffer[index + 1] == 10 ? 2 : 1
            } else if atEOF {
                normalized.append(10)
                index += 1
            } else {
                normalized.append(13)
                index += 1
            }
        }
        buffer = normalized
    }

    private mutating func drainCompleteBlocks() throws -> [ResponseEvent] {
        var events: [ResponseEvent] = []
        while let boundary = blankLineBoundary() {
            let block = Array(buffer[..<boundary])
            buffer.removeFirst(boundary + 2)
            guard let event = try parseBlock(block) else { continue }
            if event.done {
                finished = true
                buffer.removeAll()
                break
            }
            events.append(event.value)
        }
        return events
    }

    private func blankLineBoundary() -> Int? {
        guard buffer.count >= 2 else { return nil }
        for index in 0..<(buffer.count - 1) where buffer[index] == 10 && buffer[index + 1] == 10 {
            return index
        }
        return nil
    }

    private func parseBlock(_ bytes: [UInt8]) throws -> ParsedEvent? {
        let block = String(decoding: bytes, as: UTF8.self)
        var eventName = "message"
        var dataLines: [String] = []
        for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix(":") { continue }
            let components = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            let field = String(components[0])
            var value = components.count == 1 ? "" : String(components[1])
            if value.first == " " { value.removeFirst() }
            if field == "event" { eventName = value }
            if field == "data" { dataLines.append(value) }
        }
        guard !dataLines.isEmpty else { return nil }
        let joined = dataLines.joined(separator: "\n")
        if joined == "[DONE]" { return .done }

        let parsed: JSONValue
        if let encoded = joined.data(using: .utf8), let json = try? JSONDecoder().decode(JSONValue.self, from: encoded) {
            parsed = json
        } else {
            parsed = .string(joined)
        }
        let object: [String: JSONValue]?
        if case .object(let value) = parsed { object = value } else { object = nil }
        let type: String
        if case .string(let value)? = object?["type"] { type = value } else { type = eventName }
        let delta: String?
        if case .string(let value)? = object?["delta"] { delta = value } else { delta = nil }
        return .event(ResponseEvent(type: type, data: parsed, delta: delta))
    }
}

private enum ParsedEvent {
    case done
    case event(ResponseEvent)

    var done: Bool {
        if case .done = self { return true }
        return false
    }

    var value: ResponseEvent {
        guard case .event(let value) = self else { preconditionFailure("A done marker has no event value.") }
        return value
    }
}

/// Parses a complete SSE payload while preserving opaque and unknown event types.
public func parseSSE(_ data: Data) throws -> [ResponseEvent] {
    var parser = SSEParser()
    var events = try parser.consume(data)
    events.append(contentsOf: try parser.finish())
    return events
}

/// Parses an asynchronous byte stream into response events and stops at `[DONE]`.
public func parseSSE(
    _ chunks: AsyncThrowingStream<Data, Error>
) -> AsyncThrowingStream<ResponseEvent, Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            do {
                var parser = SSEParser()
                for try await chunk in chunks {
                    for event in try parser.consume(chunk) { continuation.yield(event) }
                }
                for event in try parser.finish() { continuation.yield(event) }
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
