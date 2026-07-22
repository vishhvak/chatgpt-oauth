import Foundation

private let redactedMarker = "[REDACTED]"

/// Scrubs bearer, JWT, JSON, and form-shaped credentials before text reaches errors or logs.
public func redact(_ value: String) -> String {
    let replacements: [(String, String)] = [
        (#"\bBearer\s+[^\s,;\"']+"#, "Bearer \(redactedMarker)"),
        (#"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"#, redactedMarker),
        (#"(\"(?:access_?token|refresh_?token|id_?token|authorization)\"\s*:\s*\")((?:\\.|[^\"\\])*(?:\\(?=$))?)(\"|$)"#, "$1\(redactedMarker)$3"),
        (#"('(?:access_?token|refresh_?token|id_?token|authorization)'\s*:\s*')((?:\\.|[^'\\])*(?:\\(?=$))?)('|$)"#, "$1\(redactedMarker)$3"),
        (#"\b(access_?token|refresh_?token|id_?token|authorization)=([^&\s]+)"#, "$1=\(redactedMarker)"),
    ]
    return replacements.reduce(value) { current, replacement in
        guard let expression = try? NSRegularExpression(pattern: replacement.0, options: [.caseInsensitive]) else { return current }
        return expression.stringByReplacingMatches(
            in: current,
            range: NSRange(current.startIndex..., in: current),
            withTemplate: replacement.1
        )
    }
}
