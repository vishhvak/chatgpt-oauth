package dev.chatgptoauth

import dev.chatgptoauth.store.MemoryCredentialStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class AuthSessionTest {
    private val subject = "app-user-42"
    private lateinit var server: MockWebServer

    @BeforeEach
    fun startServer() {
        server = MockWebServer()
        server.start()
    }

    @AfterEach
    fun stopServer() {
        server.shutdown()
    }

    @Test
    fun `twenty expired callers share one refresh`() = runTest {
        server.enqueue(tokenResponse())
        val store = MemoryCredentialStore(mapOf(subject to token()))
        val auth = session(store)
        val values = List(20) { async { auth.getAccessToken(subject) } }.awaitAll()
        assertEquals(setOf("access-new"), values.toSet())
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `forced caller does not settle on skipped non-forced flight`() = runTest {
        var current = token(expiresAt = 10_500L)
        var loads = 0
        val flightLoadStarted = CompletableDeferred<Unit>()
        val unblockFlightLoad = CompletableDeferred<Unit>()
        val store = object : CredentialStore {
            override suspend fun load(subject: String): TokenSet {
                loads += 1
                if (loads == 2) {
                    flightLoadStarted.complete(Unit)
                    unblockFlightLoad.await()
                }
                return current
            }

            override suspend fun compareAndSwap(subject: String, expectedVersion: Long, next: TokenSet): CompareAndSwapResult {
                if (current.version != expectedVersion) return CompareAndSwapResult(false, current)
                current = next.copy(version = expectedVersion + 1)
                return CompareAndSwapResult(true, current)
            }

            override suspend fun delete(subject: String) = Unit
        }
        server.enqueue(tokenResponse(access = "access-forced"))
        val auth = session(store)
        val opportunistic = async { auth.getAccessToken(subject) }
        flightLoadStarted.await()
        val forced = async { auth.refreshAccessToken(subject) }
        current = token(access = "access-rotated", refresh = "refresh-rotated", expiresAt = 9_999_999L, version = 2L)
        unblockFlightLoad.complete(Unit)

        assertEquals(listOf("access-rotated", "access-forced"), awaitAll(opportunistic, forced))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `CAS loser adopts healthy winner`() = runTest {
        val winner = token(access = "winner", refresh = "winner-refresh", expiresAt = 9_999_999L, version = 2L)
        val delegate = MemoryCredentialStore(mapOf(subject to token()))
        val store = object : CredentialStore {
            var firstCas = true
            override suspend fun load(subject: String): TokenSet? = delegate.load(subject)
            override suspend fun compareAndSwap(subject: String, expectedVersion: Long, next: TokenSet): CompareAndSwapResult {
                if (firstCas) {
                    firstCas = false
                    delegate.compareAndSwap(subject, 1L, winner)
                }
                return delegate.compareAndSwap(subject, expectedVersion, next)
            }
            override suspend fun delete(subject: String) = delegate.delete(subject)
        }
        server.enqueue(tokenResponse(access = "loser"))
        assertEquals("winner", session(store).getAccessToken(subject))
    }

    @Test
    fun `refresh retains the old refresh token when rotation is omitted`() = runTest {
        val store = MemoryCredentialStore(mapOf(subject to token()))
        server.enqueue(MockResponse().setBody("""{"access_token":"access-new","expires_in":3600}"""))
        assertEquals("access-new", session(store).getAccessToken(subject))
        assertEquals("refresh-old", store.load(subject)?.refreshToken)
    }

    @Test
    fun `transient server failures retry without quarantine`() = runTest {
        val store = MemoryCredentialStore(mapOf(subject to token()))
        server.enqueue(MockResponse().setResponseCode(503).setBody("unavailable"))
        server.enqueue(MockResponse().setResponseCode(500).setBody("unavailable"))
        server.enqueue(tokenResponse())
        assertEquals("access-new", session(store, sleep = {}).getAccessToken(subject))
        assertEquals(null, store.load(subject)?.quarantinedAt)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `terminal refresh quarantines while 429 never does`() = runTest {
        val terminalStore = MemoryCredentialStore(mapOf(subject to token()))
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"invalid_grant"}"""))
        val terminal = session(terminalStore)
        assertThrows(ReauthRequiredError::class.java) {
            kotlinx.coroutines.runBlocking { terminal.getAccessToken(subject) }
        }
        assertEquals("invalid_grant", terminalStore.load(subject)?.quarantineReason)
        assertEquals(1, server.requestCount)

        val limitedStore = MemoryCredentialStore(mapOf(subject to token()))
        repeat(3) { server.enqueue(MockResponse().setResponseCode(429).setHeader("retry-after", "0")) }
        val limited = session(limitedStore, sleep = {})
        assertThrows(RateLimitError::class.java) {
            kotlinx.coroutines.runBlocking { limited.getAccessToken(subject) }
        }
        assertEquals(null, limitedStore.load(subject)?.quarantinedAt)
        assertEquals(4, server.requestCount)
    }

    @Test
    fun `healthy rotation wins over a concurrent quarantine marker`() = runTest {
        val healthy = token(access = "healthy", refresh = "healthy-refresh", expiresAt = 9_999_999L, version = 2L)
        var current = token()
        val store = object : CredentialStore {
            override suspend fun load(subject: String): TokenSet = current
            override suspend fun compareAndSwap(subject: String, expectedVersion: Long, next: TokenSet): CompareAndSwapResult {
                if (next.quarantinedAt != null) {
                    current = healthy
                    return CompareAndSwapResult(false, healthy)
                }
                if (current.version != expectedVersion) return CompareAndSwapResult(false, current)
                current = next.copy(version = expectedVersion + 1L)
                return CompareAndSwapResult(true, current)
            }
            override suspend fun delete(subject: String) = Unit
        }
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"invalid_grant"}"""))
        assertEquals("healthy", session(store).getAccessToken(subject))
        assertEquals(null, current.quarantinedAt)
    }

    @Test
    fun `kill switch blocks custody reads and network`() = runTest {
        val store = MemoryCredentialStore(mapOf(subject to token()))
        val auth = AuthSession(
            store,
            client = OkHttpClient(),
            disabled = { true },
            protocol = ProtocolConfig(tokenUrl = server.url("/token").toString()),
        )
        assertThrows(DisabledError::class.java) { kotlinx.coroutines.runBlocking { auth.getAccessToken(subject) } }
        assertThrows(DisabledError::class.java) { kotlinx.coroutines.runBlocking { auth.status(subject) } }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `token and pending string forms never expose secrets`() {
        val token = token(access = "access-secret", refresh = "refresh-secret").copy(idToken = "id-secret")
        val rendered = token.toString()
        assertFalse(rendered.contains("access-secret"))
        assertFalse(rendered.contains("refresh-secret"))
        assertFalse(rendered.contains("id-secret"))
        assertTrue(rendered.contains("[REDACTED]"))
        assertFalse(PendingLogin("url", "state-secret", "verifier-secret", "redirect").toString().contains("verifier-secret"))
    }

    @Test
    fun `every credential operation rejects a blank subject`() = runTest {
        val auth = session(MemoryCredentialStore())
        assertThrows(IllegalArgumentException::class.java) { kotlinx.coroutines.runBlocking { auth.status("") } }
        assertThrows(IllegalArgumentException::class.java) { kotlinx.coroutines.runBlocking { auth.logout(" ") } }
        assertThrows(IllegalArgumentException::class.java) { kotlinx.coroutines.runBlocking { auth.getAccessToken("") } }
    }

    private fun session(store: CredentialStore, sleep: suspend (Long) -> Unit = {}): AuthSession = AuthSession(
        store = store,
        client = OkHttpClient(),
        now = { 10_000L },
        sleep = sleep,
        protocol = ProtocolConfig(tokenUrl = server.url("/token").toString()),
    )

    private fun token(
        access: String = "access-old",
        refresh: String = "refresh-old",
        expiresAt: Long = 1L,
        version: Long = 1L,
    ): TokenSet = TokenSet(access, refresh, expiresAt = expiresAt, version = version)

    private fun tokenResponse(access: String = "access-new"): MockResponse = MockResponse().setBody(
        """{"access_token":"$access","refresh_token":"refresh-new","expires_in":3600}""",
    )
}
