import Foundation

/// Incrementally frames UTF-8 server-sent events across arbitrary transport chunk boundaries.
struct SSEParser: Sendable {
    /// Below this many consumed-but-unparsed leading bytes, compaction is skipped so a single large
    /// event delivered in many small chunks does not pay an O(n) `removeFirst` on every appended byte.
    private static let compactionThreshold = 8_192

    private var buffer: [UInt8] = []
    /// The count of leading bytes in `buffer` already folded into parsed or discarded blocks.
    /// Bytes before this index are dead weight kept only until the next compaction.
    private var consumed = 0
    /// The index up to which `buffer[consumed...]` has already been scanned for a blank-line
    /// boundary without success, so a growing single-event buffer is not rescanned from the start
    /// on every appended chunk.
    private var scanned = 0
    /// Whether the previously appended byte was an unresolved `\r` awaiting the next byte to decide
    /// whether it pairs with a following `\n`.
    private var pendingCR = false
    private var finished = false

    /// Creates an empty incremental SSE parser.
    init() {}

    /// Consumes one byte chunk and returns every complete event framed by it.
    mutating func consume(_ chunk: Data) throws -> [ResponseEvent] {
        guard !finished else { return [] }
        normalizeAndAppend(chunk, atEOF: false)
        return try drainCompleteBlocks()
    }

    /// Parses a final nonempty block even when the stream omitted its terminating blank line.
    mutating func finish() throws -> [ResponseEvent] {
        guard !finished else { return [] }
        finished = true
        normalizeAndAppend(Data(), atEOF: true)
        var events = try drainCompleteBlocks()
        if consumed < buffer.count, let event = try parseBlock(Array(buffer[consumed...])) {
            if event.done {
                buffer.removeAll()
                consumed = 0
                scanned = 0
                return events
            }
            events.append(event.value)
        }
        buffer.removeAll()
        consumed = 0
        scanned = 0
        return events
    }

    /// Appends one chunk's bytes to `buffer`, collapsing `\r\n` and lone `\r` into `\n` as it goes.
    /// Only the newly appended bytes are touched — the already-normalized prefix is never revisited —
    /// so framing one large event across many small chunks stays linear instead of quadratic. A `\r`
    /// landing on a chunk boundary is deferred via `pendingCR` until the next byte (or `atEOF`) is known,
    /// so a `\r` in one chunk followed by `\n` in the next still collapses to a single `\n`.
    private mutating func normalizeAndAppend(_ chunk: Data, atEOF: Bool) {
        for byte in chunk {
            if pendingCR {
                pendingCR = false
                if byte == 10 {
                    buffer.append(10)
                    continue
                }
                buffer.append(10)
            }
            if byte == 13 {
                pendingCR = true
            } else {
                buffer.append(byte)
            }
        }
        if atEOF, pendingCR {
            buffer.append(10)
            pendingCR = false
        }
    }

    private mutating func drainCompleteBlocks() throws -> [ResponseEvent] {
        var events: [ResponseEvent] = []
        while let boundary = blankLineBoundary() {
            let block = Array(buffer[consumed..<boundary])
            consumed = boundary + 2
            scanned = consumed
            compactIfNeeded()
            guard let event = try parseBlock(block) else { continue }
            if event.done {
                finished = true
                buffer.removeAll()
                consumed = 0
                scanned = 0
                break
            }
            events.append(event.value)
        }
        return events
    }

    /// Finds the next blank-line boundary at or after `consumed`, resuming from `scanned` so a
    /// buffer that never reaches a boundary (one large event trickling in byte by byte) is scanned
    /// once overall rather than once per appended chunk.
    private mutating func blankLineBoundary() -> Int? {
        guard buffer.count >= consumed + 2 else { return nil }
        var index = max(scanned, consumed)
        while index < buffer.count - 1 {
            if buffer[index] == 10 && buffer[index + 1] == 10 {
                return index
            }
            index += 1
        }
        scanned = max(consumed, buffer.count - 1)
        return nil
    }

    /// Drops the dead, already-consumed prefix only once it grows past a threshold, so memory stays
    /// bounded without paying an O(n) `removeFirst` shift on every single parsed event.
    private mutating func compactIfNeeded() {
        guard consumed >= Self.compactionThreshold else { return }
        buffer.removeFirst(consumed)
        scanned = max(0, scanned - consumed)
        consumed = 0
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
func parseSSE(_ data: Data) throws -> [ResponseEvent] {
    var parser = SSEParser()
    var events = try parser.consume(data)
    events.append(contentsOf: try parser.finish())
    return events
}

/// Parses an asynchronous byte stream into response events and stops at `[DONE]`.
func parseSSE(
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
