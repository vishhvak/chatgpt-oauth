package dev.chatgptoauth

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PkceTest {
    @Test
    fun `computes known S256 vector and generates unpadded material`() {
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        )
        val generated = createPkce()
        assertTrue(generated.verifier.matches(Regex("^[A-Za-z0-9_-]{86}$")))
        assertTrue(generated.challenge.matches(Regex("^[A-Za-z0-9_-]{43}$")))
        assertTrue(generated.state.matches(Regex("^[A-Za-z0-9_-]{43}$")))
    }

    @Test
    fun `rejects null and mismatched state`() {
        assertThrows(StateMismatchError::class.java) { assertState("expected", null) }
        assertThrows(StateMismatchError::class.java) { assertState("expected", "wrong") }
        assertState("expected", "expected")
    }
}
