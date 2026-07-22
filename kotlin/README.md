# chatgpt-oauth for Kotlin

Experimental, unofficial OAuth and subscription transport for Android and JVM apps whose users bring their own ChatGPT account. Tokens are credentials: derive every `subject` from your trusted application session, never from JWT claims or client input.

## JVM server

```kotlin
val subject = requireAppSession(request).userId
val store: CredentialStore = applicationCredentialStore() // encrypted, atomic CAS
val auth = AuthSession(store)

val pending = auth.beginLogin("https://app.example/chatgpt/callback")
saveEncryptedPendingLogin(subject, pending)
redirect(pending.url)

// In the callback route:
auth.completeLogin(subject, request.url, takeEncryptedPendingLogin(subject))
val ai = SubscriptionAIClient(auth, subject)
println(ai.respond(ResponseRequest("gpt-5.4-mini", "Explain CAS in one sentence.")).outputText)
```

## Android device flow

```kotlin
val subject = authenticatedProfile.id // app-owned identity
val auth = AuthSession(EncryptedCredentialStore(applicationContext))

setContent {
    SignInWithChatGPT(auth, subject) // opens a Custom Tab, shows the device code, then polls
}
```

The Compose component shows the experimental Terms-of-Service warning by default. Set `showDisclaimer = false` only when the host UI presents it elsewhere. For an authorization redirect instead, pass `SignInMode.Redirect(redirectUri, callbackUrl)` and deliver the callback URL from your Activity intent. Never place access or refresh tokens in Compose state, logs, exceptions, or a WebView.

`EncryptedCredentialStore` serializes CAS across store instances in one Android process. If multiple app processes share one vault, keep custody in one process or provide a cross-process `CredentialStore`; `EncryptedSharedPreferences` does not provide cross-process transactions.
