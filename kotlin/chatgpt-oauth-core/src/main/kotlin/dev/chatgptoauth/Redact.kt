package dev.chatgptoauth

private const val REDACTED = "[REDACTED]"

private val bearerPattern = Regex("\\bBearer\\s+[^\\s,;\\\"']+", RegexOption.IGNORE_CASE)
private val jwtPattern = Regex("\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b")
private val doubleQuotedPattern = Regex(
    "(\\\"(?:access_?token|refresh_?token|id_?token|authorization)\\\"\\s*:\\s*\\\")((?:\\\\.|[^\\\"\\\\])*(?:\\\\(?=$))?)(\\\"|$)",
    RegexOption.IGNORE_CASE,
)
private val singleQuotedPattern = Regex(
    "('(?:access_?token|refresh_?token|id_?token|authorization)'\\s*:\\s*')((?:\\\\.|[^'\\\\])*(?:\\\\(?=$))?)('|$)",
    RegexOption.IGNORE_CASE,
)
private val formPattern = Regex(
    "\\b(access_?token|refresh_?token|id_?token|authorization)=([^&\\s]+)",
    RegexOption.IGNORE_CASE,
)

/** Scrubs bearer, JWT, JSON, and form-shaped credentials from untrusted text. */
public fun redact(value: String): String = value
    .replace(bearerPattern) { "Bearer $REDACTED" }
    .replace(jwtPattern, REDACTED)
    .replace(doubleQuotedPattern) { "${it.groupValues[1]}$REDACTED${it.groupValues[3]}" }
    .replace(singleQuotedPattern) { "${it.groupValues[1]}$REDACTED${it.groupValues[3]}" }
    .replace(formPattern) { "${it.groupValues[1]}=$REDACTED" }
