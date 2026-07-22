import AuthenticationServices
import ChatGPTOAuth
import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Selects the native authorization-session redirect flow or the device-code flow.
public enum ChatGPTSignInMode: Sendable {
    /// Opens the authorization URL in an `ASWebAuthenticationSession`.
    case redirect(redirectURI: URL)
    /// Opens the device verification page and presents its user code.
    case device
}

/// Presents subject-scoped ChatGPT sign-in, connected, and error states without handling tokens.
public struct SignInWithChatGPT: View {
    private let auth: AuthSession
    private let subject: String
    private let mode: ChatGPTSignInMode
    private let label: String
    private let showDisclaimer: Bool
    private let onConnected: (@Sendable (Session) -> Void)?

    @StateObject private var model = SignInModel()

    /// Creates a sign-in view whose credential identity is always the explicit application subject.
    public init(
        auth: AuthSession,
        subject: String,
        mode: ChatGPTSignInMode,
        label: String = "Sign in with ChatGPT",
        showDisclaimer: Bool = true,
        onConnected: (@Sendable (Session) -> Void)? = nil
    ) {
        self.auth = auth
        self.subject = subject
        self.mode = mode
        self.label = label
        self.showDisclaimer = showDisclaimer
        self.onConnected = onConnected
    }

    /// Renders the current login, device-code, connected, or error state.
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
            if showDisclaimer {
                Text("Experimental: this uses OpenAI’s Codex OAuth client for ChatGPT subscription access. It may violate OpenAI ToS for non-Codex use and can break at any time.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: subject) { await refreshStatus() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            progressButton("Checking ChatGPT…")
        case .signedOut:
            Button(label) { Task { await signIn() } }
                .buttonStyle(.borderedProminent)
        case .connecting:
            progressButton("Waiting for ChatGPT…")
        case .deviceCode(let code, let verificationURL):
            VStack(alignment: .leading, spacing: 8) {
                Text("Enter this code at ChatGPT").font(.headline)
                Text(code).font(.system(.title2, design: .monospaced).weight(.semibold)).textSelection(.enabled)
                Link("Open ChatGPT", destination: verificationURL)
                ProgressView("Waiting for approval…")
            }
        case .connected(let session):
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.email ?? "Connected to ChatGPT").font(.headline)
                    if let plan = session.planType { Text(plan).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                Button("Sign out", role: .destructive) { Task { await signOut() } }
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Text(message).foregroundStyle(.red).accessibilityLabel("ChatGPT sign-in error: \(message)")
                Button("Try again") { Task { await signIn() } }.buttonStyle(.borderedProminent)
            }
        }
    }

    private func progressButton(_ title: String) -> some View {
        HStack { ProgressView(); Text(title) }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
    }

    @MainActor
    private func refreshStatus() async {
        model.state = .loading
        do {
            if let session = try await auth.status(subject: subject) {
                model.state = .connected(session)
                onConnected?(session)
            } else {
                model.state = .signedOut
            }
        } catch {
            model.state = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func signIn() async {
        model.cancelBrowserSession()
        model.state = .connecting
        do {
            let token: TokenSet
            switch mode {
            case .redirect(let redirectURI):
                let pending = try await auth.beginLogin(subject: subject, redirectURI: redirectURI)
                let callbackURL = try await model.authenticate(at: pending.url, callbackScheme: pending.redirectURI.scheme)
                token = try await auth.completeLogin(subject: subject, callbackURL: callbackURL, pending: pending)
            case .device:
                let login = try await auth.startDeviceLogin(subject: subject)
                model.state = .deviceCode(login.userCode, login.verificationURL)
                token = try await login.wait()
            }
            _ = token // Tokens remain inside the subject-keyed session/store boundary.
            guard let session = try await auth.status(subject: subject) else {
                throw ChatGPTOAuthError.authentication(message: "Sign-in completed without a stored session.")
            }
            model.state = .connected(session)
            onConnected?(session)
        } catch is CancellationError {
            model.state = .signedOut
        } catch {
            model.state = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func signOut() async {
        model.cancelBrowserSession()
        model.state = .loading
        do {
            try await auth.logout(subject: subject)
            model.state = .signedOut
        } catch {
            model.state = .failed(error.localizedDescription)
        }
    }
}

@MainActor
private final class SignInModel: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    enum State {
        case loading
        case signedOut
        case connecting
        case deviceCode(String, URL)
        case connected(Session)
        case failed(String)
    }

    @Published var state: State = .loading
    private var browserSession: ASWebAuthenticationSession?

    func authenticate(at url: URL, callbackScheme: String?) async throws -> URL {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let oneShot = AuthenticationContinuation(continuation)
                let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callbackURL, error in
                    Task { @MainActor in
                        self.browserSession = nil
                        if let callbackURL {
                            oneShot.resume(returning: callbackURL)
                        } else if let error {
                            oneShot.resume(throwing: error)
                        } else {
                            oneShot.resume(throwing: CancellationError())
                        }
                    }
                }
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = false
                browserSession = session
                if !session.start() {
                    browserSession = nil
                    oneShot.resume(throwing: ChatGPTOAuthError.authentication(message: "The system could not start ChatGPT sign-in."))
                }
            }
        } onCancel: {
            Task { @MainActor in self.cancelBrowserSession() }
        }
    }

    func cancelBrowserSession() {
        browserSession?.cancel()
        browserSession = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(iOS)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        #elseif os(macOS)
        return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
        #endif
    }
}

@MainActor
private final class AuthenticationContinuation {
    private var continuation: CheckedContinuation<URL, Error>?

    init(_ continuation: CheckedContinuation<URL, Error>) {
        self.continuation = continuation
    }

    func resume(returning url: URL) {
        continuation?.resume(returning: url)
        continuation = nil
    }

    func resume(throwing error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
