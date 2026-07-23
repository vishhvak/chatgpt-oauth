import Foundation

private let redactedMarker = "[REDACTED]"

/// The compiled redaction patterns, built once at first use instead of on every `redact()` call —
/// this runs on every error and retry path, so re-compiling five regular expressions per call was wasteful.
private let redactionPatterns: [(expression: NSRegularExpression, template: String)] = [
    (#"\bBearer\s+[^\s,;\"']+"#, "Bearer \(redactedMarker)"),
    (#"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"#, redactedMarker),
    (#"(\"(?:access_?token|refresh_?token|id_?token|authorization)\"\s*:\s*\")((?:\\.|[^\"\\])*(?:\\(?=$))?)(\"|$)"#, "$1\(redactedMarker)$3"),
    (#"('(?:access_?token|refresh_?token|id_?token|authorization)'\s*:\s*')((?:\\.|[^'\\])*(?:\\(?=$))?)('|$)"#, "$1\(redactedMarker)$3"),
    (#"\b(access_?token|refresh_?token|id_?token|authorization)=([^&\s]+)"#, "$1=\(redactedMarker)"),
].compactMap { pattern, template in
    (try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])).map { (expression: $0, template: template) }
}

/// Scrubs bearer, JWT, JSON, and form-shaped credentials before text reaches errors or logs.
func redact(_ value: String) -> String {
    redactionPatterns.reduce(value) { current, replacement in
        replacement.expression.stringByReplacingMatches(
            in: current,
            range: NSRange(current.startIndex..., in: current),
            withTemplate: replacement.template
        )
    }
}
