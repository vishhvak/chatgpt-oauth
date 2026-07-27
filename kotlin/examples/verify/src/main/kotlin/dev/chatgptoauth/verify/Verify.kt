package dev.chatgptoauth.verify

import dev.chatgptoauth.AuthSession
import dev.chatgptoauth.ResponseContent
import dev.chatgptoauth.ResponseRequest
import dev.chatgptoauth.SubscriptionAI
import dev.chatgptoauth.store.MemoryCredentialStore
import kotlinx.coroutines.runBlocking

/**
 * Signs in and streams one response, to check the port against a live account.
 *
 * ```
 * cd kotlin && ./gradlew :examples:verify:run --console=plain
 * ```
 *
 * The JVM core ships no persistent store — the encrypted one is Android-only — so this signs in
 * every run.
 */
private const val SUBJECT = "example-user"
private const val MODEL = "gpt-5.4-mini"

public fun main(): Unit = runBlocking {
    val auth = AuthSession(store = MemoryCredentialStore())

    val device = auth.startDeviceLogin(SUBJECT)
    println("Open ${device.verificationUrl} and enter code ${device.userCode}\n")
    device.wait()

    val client = SubscriptionAI(auth, SUBJECT)
    val request = ResponseRequest(model = MODEL, input = ResponseContent.Text("Say hello in five words."))
    client.stream(request).collect { event ->
        event.delta?.let { print(it); System.out.flush() }
    }
    println()
}
