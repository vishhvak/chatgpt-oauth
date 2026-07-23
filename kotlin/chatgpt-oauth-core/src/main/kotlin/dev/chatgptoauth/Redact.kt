package dev.chatgptoauth

import okhttp3.Response
import okio.Buffer

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
internal fun redact(value: String): String = value
    .replace(bearerPattern) { "Bearer $REDACTED" }
    .replace(jwtPattern, REDACTED)
    .replace(doubleQuotedPattern) { "${it.groupValues[1]}$REDACTED${it.groupValues[3]}" }
    .replace(singleQuotedPattern) { "${it.groupValues[1]}$REDACTED${it.groupValues[3]}" }
    .replace(formPattern) { "${it.groupValues[1]}=$REDACTED" }

/**
 * Reads up to [readLimit] bytes from this OkHttp response body, closes the response, and returns
 * redacted text truncated to [outputLimit] characters.
 */
internal fun Response.readRedactedSnippet(readLimit: Long = 4_096L, outputLimit: Int = readLimit.toInt()): String = use { response ->
    val value = runCatching {
        val source = response.body?.source() ?: return@runCatching ""
        val sink = Buffer()
        while (sink.size < readLimit) {
            val read = source.read(sink, minOf(8_192L, readLimit - sink.size))
            if (read == -1L) break
        }
        sink.readByteArray().toString(Charsets.UTF_8)
    }
        .getOrElse { " [response read failed: ${redact(it.message.orEmpty())}]" }
    redact(value).take(outputLimit)
}
