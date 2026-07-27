package dev.chatgptoauth.android

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File

/**
 * Transitional reader for records written by the previous `EncryptedSharedPreferences` store.
 *
 * Google deprecated `androidx.security:security-crypto` in April 2025 at `1.1.0-alpha07`; it never
 * reached stable and receives no further fixes. [EncryptedCredentialStore] now writes an Android
 * Keystore + AES-256-GCM envelope instead, and calls in here once per subject to carry an existing
 * record across so upgrading does not sign anyone out.
 *
 * Everything deprecated is confined to this file. Once enough releases have passed that no install
 * can still hold a legacy record, delete this file and drop `libs.androidx.security.crypto` from
 * `chatgpt-oauth-android/build.gradle.kts` — nothing else references either.
 *
 * The legacy preference file is never created here: each entry point returns early unless the file
 * is already on disk, so a fresh install never initializes the deprecated library at all.
 */
internal object LegacyEncryptedPreferences {
    fun read(context: Context, fileName: String, key: String): String? =
        withLegacyPreferences(context, fileName) { it.getString(key, null) }

    fun remove(context: Context, fileName: String, key: String) {
        withLegacyPreferences(context, fileName) { it.edit().remove(key).commit() }
    }

    private fun <T> withLegacyPreferences(
        context: Context,
        fileName: String,
        block: (android.content.SharedPreferences) -> T,
    ): T? {
        if (!legacyFileExists(context, fileName)) return null
        return try {
            @Suppress("DEPRECATION")
            val preferences = EncryptedSharedPreferences.create(
                context,
                fileName,
                MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            block(preferences)
        } catch (cause: Exception) {
            // A corrupt or unreadable legacy keyset — one of the failure modes that motivated the
            // deprecation — must not block the new store. Treat it as "nothing to migrate" and let
            // the caller fall through to a normal re-authentication.
            null
        }
    }

    private fun legacyFileExists(context: Context, fileName: String): Boolean =
        File(File(context.applicationInfo.dataDir, "shared_prefs"), "$fileName.xml").exists()
}
