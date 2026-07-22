package dev.chatgptoauth

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class JwtTest {
    @Test
    fun `extracts unverified claims and falls back to access token`() {
        val payload = """{"https://api.openai.com/auth":{"chatgpt_account_id":"acct","chatgpt_plan_type":"pro"},"email":"a@example.com"}"""
        val token = "x.${base64Url(payload.toByteArray())}.y"
        assertEquals(UnverifiedClaims("acct", "pro", "a@example.com"), extractUnverifiedClaims("malformed", token))
    }

    @Test
    fun `ignores non-string and malformed claims`() {
        val payload = """{"https://api.openai.com/auth":{"chatgpt_account_id":42},"email":false}"""
        val token = "x.${base64Url(payload.toByteArray())}.y"
        assertEquals(UnverifiedClaims(), extractUnverifiedClaims(token, null))
        assertEquals(UnverifiedClaims(), extractUnverifiedClaims("not-a-jwt", "also-bad"))
    }

    @Test
    fun `redacts bearer JSON form and JWT-shaped secrets`() {
        val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature_value"
        val scrubbed = redact(
            "Authorization: Bearer access-secret {\"access_token\":\"json-secret\"} " +
                "refresh_token=form-secret $jwt",
        )
        assertFalse(scrubbed.contains("access-secret"))
        assertFalse(scrubbed.contains("json-secret"))
        assertFalse(scrubbed.contains("form-secret"))
        assertFalse(scrubbed.contains(jwt))
        assertTrue(scrubbed.contains("[REDACTED]"))
    }
}
