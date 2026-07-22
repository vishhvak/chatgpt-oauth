# ChatGPTOAuth for Swift

Experimental, unofficial OAuth and ChatGPT subscription transport for native Apple apps.

> This package uses OpenAI’s public Codex OAuth client and an undocumented backend API. It can change or stop working without notice. Treat refresh tokens like passwords, never pool credentials between users, and keep an API-key or local-model fallback.

## Quickstart

```swift
import ChatGPTOAuth

let store = KeychainCredentialStore(service: "com.example.my-app.chatgpt")
let auth = AuthSession(store: store)
let subject = "user-123" // replace with your trusted app-session identity; never token-derived

let login = try await auth.startDeviceLogin(subject: subject)
print("Open \(login.verificationURL) and enter \(login.userCode)")
_ = try await login.wait()

let ai = SubscriptionAI(auth: auth, subject: subject)
let result = try await ai.respond(.init(
    model: "gpt-5.4-mini",
    input: .text("Explain compare-and-swap in one sentence.")
))
print(result.outputText)
```

Every credential operation requires an explicit `subject` obtained from the app’s trusted session. There is no ambient credential and no subjectless store or auth overload. JWT account, plan, and email claims are unverified routing/display metadata and never authorization inputs.

For SwiftUI, use `SignInWithChatGPT` from `ChatGPTOAuthUI`. Redirect mode uses `ASWebAuthenticationSession`; device mode displays the user code. The experimental Terms-of-Service warning is visible by default.

```swift
import ChatGPTOAuthUI

SignInWithChatGPT(
    auth: auth,
    subject: signedInProfile.id,
    mode: .device
)
```

`MemoryCredentialStore` is for tests and development. Production Apple apps should use `KeychainCredentialStore`, which stores one compare-and-swap generation per subject with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
