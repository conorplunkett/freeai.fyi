// Encrypted storage for the device credentials. The deviceKey authenticates
// every earning/redemption call, so it belongs in the macOS Keychain (encrypted
// at rest, access-controlled to this app) rather than UserDefaults (a plaintext
// plist any process or backup can read). A single generic-password item holds
// the JSON-encoded DeviceCredentials.

import Foundation
import Security

enum Keychain {
    private static let service = "fyi.freeai.SponsorOverlay"
    private static let account = "deviceCredentials"

    private static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    /// Store (or replace) the credentials blob.
    @discardableResult
    static func save(_ data: Data) -> Bool {
        SecItemDelete(query() as CFDictionary) // replace any existing item
        var attrs = query()
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(attrs as CFDictionary, nil) == errSecSuccess
    }

    static func load() -> Data? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func delete() {
        SecItemDelete(query() as CFDictionary)
    }
}
