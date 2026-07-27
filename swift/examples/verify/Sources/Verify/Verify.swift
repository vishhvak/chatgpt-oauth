import ChatGPTOAuth
import Foundation

/// Signs in and streams one response, to check the port against a live account.
///
///     cd swift/examples/verify && swift run Verify
///
/// Credentials land in the login Keychain, so a second run skips the sign-in and exercises refresh
/// instead. This is also the only coverage `KeychainCredentialStore` and the device flow have —
/// neither has a unit test.
@main
struct Verify {
    static let subject = "example-user"
    static let model = "gpt-5.4-mini"

    static func main() async throws {
        let store = KeychainCredentialStore(service: "com.openai.chatgpt-oauth.example")
        let auth = AuthSession(store: store)

        if try await auth.status(subject: subject) == nil {
            let device = try await auth.startDeviceLogin(subject: subject)
            print("Open \(device.verificationURL) and enter code \(device.userCode)\n")
            _ = try await device.wait()
        }

        let client = SubscriptionAI(auth: auth, subject: subject)
        let request = ResponseRequest(model: model, input: .text("Say hello in five words."))
        for try await event in client.stream(request) {
            if let delta = event.delta {
                print(delta, terminator: "")
                fflush(stdout)
            }
        }
        print()
    }
}
