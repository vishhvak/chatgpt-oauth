package dev.chatgptoauth

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class OAuthEdgeCaseTest {
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
    fun `validates state before exchange`() = runTest {
        val oauth = OAuth(OkHttpClient(), testProtocol())
        val pending = PendingLogin("unused", "expected", "verifier", "https://app.example/callback")
        assertThrows(StateMismatchError::class.java) {
            kotlinx.coroutines.runBlocking {
                oauth.completeLogin("https://app.example/callback?state=wrong&code=secret", pending)
            }
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `coerces string expiry and expires non-finite values immediately`() = runTest {
        server.enqueue(MockResponse().setBody("""{"access_token":"a","refresh_token":"r","expires_in":"3600"}"""))
        server.enqueue(MockResponse().setBody("""{"access_token":"b","refresh_token":"r","expires_in":"not-a-number"}"""))
        val oauth = OAuth(OkHttpClient(), testProtocol(), now = { 1_000L })
        val pending = PendingLogin("unused", "expected", "verifier", "https://app.example/callback")
        assertEquals(3_601_000L, oauth.completeLogin("https://app.example/callback?state=expected&code=one", pending).expiresAt)
        assertEquals(1_000L, oauth.completeLogin("https://app.example/callback?state=expected&code=two", pending).expiresAt)
    }

    @Test
    fun `device flow honors pending slow down and success`() = runTest {
        server.enqueue(MockResponse().setBody("""{"user_code":"ABCD-EFGH","device_auth_id":"device-1","interval":1,"expires_in":60}"""))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"authorization_pending"}"""))
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"slow_down"}"""))
        server.enqueue(MockResponse().setBody("""{"authorization_code":"code","code_verifier":"verifier"}"""))
        server.enqueue(MockResponse().setBody("""{"access_token":"new","refresh_token":"refresh","expires_in":3600}"""))
        val sleeps = mutableListOf<Long>()
        var clock = 0L
        val oauth = OAuth(OkHttpClient(), testProtocol(), now = { clock }, sleep = { sleeps += it; clock += it })
        val login = oauth.startDeviceLogin { it }
        assertEquals("new", login.wait().accessToken)
        assertEquals(listOf(1_000L, 1_000L, 6_000L), sleeps)
        assertTrue(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8().contains(Protocol.CLIENT_ID))
    }

    @Test
    fun `responses transport retries one 401 with forced refresh`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("unauthorized"))
        server.enqueue(MockResponse().setBody("""{"access_token":"access-new","refresh_token":"refresh-new","expires_in":3600}"""))
        server.enqueue(MockResponse().setBody(
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n" +
                "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
        ))
        val store = dev.chatgptoauth.store.MemoryCredentialStore(
            mapOf("subject" to TokenSet("access-old", "refresh-old", expiresAt = 9_999_999L, version = 1L)),
        )
        val protocol = testProtocol().copy(responsesUrl = server.url("/responses").toString())
        val auth = AuthSession(store, OkHttpClient(), now = { 1_000L }, sleep = {}, protocol = protocol)
        val client = SubscriptionAI(auth, "subject", OkHttpClient(), protocol, sessionId = "session-test")
        assertEquals("Hi", client.respond(ResponseRequest("gpt-test", "hello")).outputText)

        val first = server.takeRequest(1, TimeUnit.SECONDS)!!
        val refresh = server.takeRequest(1, TimeUnit.SECONDS)!!
        val retried = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("Bearer access-old", first.getHeader("authorization"))
        assertEquals("false", first.body.readUtf8().let { oauthJsonBody ->
            Regex("\\\"parallel_tool_calls\\\":(false)").find(oauthJsonBody)?.groupValues?.get(1)
        })
        assertTrue(refresh.body.readUtf8().contains("grant_type=refresh_token"))
        assertEquals("Bearer access-new", retried.getHeader("authorization"))
        assertEquals("session-test", retried.getHeader("session_id"))
    }

    private fun testProtocol(): ProtocolConfig = ProtocolConfig(
        tokenUrl = server.url("/token").toString(),
        deviceUserCodeUrl = server.url("/usercode").toString(),
        devicePollUrl = server.url("/deviceauth/token").toString(),
    )
}
