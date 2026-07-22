import CryptoKit
import Foundation
#if canImport(Security)
import Security
#endif

/// A generated PKCE verifier, S256 challenge, and OAuth state value.
public struct PKCE: Sendable, Equatable {
    /// The high-entropy PKCE verifier retained until callback completion.
    public let verifier: String
    /// The base64url-encoded SHA-256 challenge sent to the authorization endpoint.
    public let challenge: String
    /// The high-entropy state value retained until callback completion.
    public let state: String

    /// Generates a verifier from 64 random bytes and state from 32 random bytes.
    public static func generate() throws -> PKCE {
        let verifier = base64URLEncode(try secureRandomBytes(count: 64))
        return PKCE(
            verifier: verifier,
            challenge: challenge(for: verifier),
            state: base64URLEncode(try secureRandomBytes(count: 32))
        )
    }

    /// Computes an RFC 7636 S256 challenge for a verifier.
    public static func challenge(for verifier: String) -> String {
        base64URLEncode(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// Compares OAuth state without a data-dependent early exit.
    public static func assertState(expected: String, actual: String?) throws {
        let left = Array(expected.utf8)
        let right = Array((actual ?? "").utf8)
        var difference = left.count ^ right.count
        for index in 0..<max(left.count, right.count) {
            difference |= Int(index < left.count ? left[index] : 0) ^ Int(index < right.count ? right[index] : 0)
        }
        guard difference == 0 else { throw ChatGPTOAuthError.stateMismatch }
    }
}

func base64URLEncode(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func base64URLDecode(_ value: String) -> Data? {
    var base64 = value
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
}

private func secureRandomBytes(count: Int) throws -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    #if canImport(Security)
    guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
        throw ChatGPTOAuthError.transport(message: "Secure random generation failed.")
    }
    #else
    var generator = SystemRandomNumberGenerator()
    for index in bytes.indices { bytes[index] = UInt8.random(in: .min ... .max, using: &generator) }
    #endif
    return Data(bytes)
}
