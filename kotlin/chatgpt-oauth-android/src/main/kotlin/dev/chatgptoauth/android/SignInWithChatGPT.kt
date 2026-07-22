package dev.chatgptoauth.android

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.chatgptoauth.AuthSession
import dev.chatgptoauth.PendingLogin
import dev.chatgptoauth.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Selects either the recommended device flow or a host-delivered Custom Tabs redirect flow. */
public sealed interface SignInMode {
    /** Uses device authorization and displays the user code while polling. */
    public data object Device : SignInMode

    /** Uses Custom Tabs with [redirectUri] and completes when the host supplies [callbackUrl]. */
    public data class Redirect(public val redirectUri: String, public val callbackUrl: String? = null) : SignInMode
}

private sealed interface AuthView {
    data object Loading : AuthView
    data object SignedOut : AuthView
    data class Connecting(val userCode: String? = null) : AuthView
    data class Connected(val session: Session) : AuthView
    data class Error(val message: String) : AuthView
}

/**
 * Renders login, connected, and error states without ever exposing credentials to Compose state.
 *
 * @param auth Subject-scoped lifecycle coordinator.
 * @param subject Explicit application-owned identity.
 * @param modifier Host layout modifier.
 * @param mode Device or host-delivered redirect flow.
 * @param showDisclaimer Whether to show the experimental Terms-of-Service warning.
 */
@Composable
public fun SignInWithChatGPT(
    auth: AuthSession,
    subject: String,
    modifier: Modifier = Modifier,
    mode: SignInMode = SignInMode.Device,
    showDisclaimer: Boolean = true,
) {
    require(subject.isNotBlank()) { "subject must be a nonempty server-derived identifier." }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var view: AuthView by remember(auth, subject) { mutableStateOf(AuthView.Loading) }
    var pending: PendingLogin? by remember(auth, subject) { mutableStateOf(null) }

    LaunchedEffect(auth, subject) {
        view = try {
            auth.status(subject)?.let(AuthView::Connected) ?: AuthView.SignedOut
        } catch (cause: CancellationException) {
            throw cause
        } catch (cause: Throwable) {
            AuthView.Error(cause.message ?: "Unable to check ChatGPT.")
        }
    }

    val callbackUrl = (mode as? SignInMode.Redirect)?.callbackUrl
    LaunchedEffect(callbackUrl, pending) {
        val callback = callbackUrl ?: return@LaunchedEffect
        val login = pending ?: return@LaunchedEffect
        view = try {
            auth.completeLogin(subject, callback, login)
            auth.status(subject)?.let(AuthView::Connected) ?: AuthView.SignedOut
        } catch (cause: CancellationException) {
            throw cause
        } catch (cause: Throwable) {
            AuthView.Error(cause.message ?: "Sign-in failed.")
        }
        pending = null
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val current = view) {
            AuthView.Loading -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator()
                Text("Checking ChatGPT…")
            }
            AuthView.SignedOut, is AuthView.Error -> {
                if (current is AuthView.Error) Text(current.message, color = MaterialTheme.colorScheme.error)
                Button(onClick = {
                    scope.launch {
                        view = AuthView.Connecting()
                        try {
                            when (val selected = mode) {
                                SignInMode.Device -> {
                                    val login = auth.startDeviceLogin(subject)
                                    view = AuthView.Connecting(login.userCode)
                                    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(login.verificationUrl))
                                    login.wait()
                                    view = auth.status(subject)?.let(AuthView::Connected) ?: AuthView.SignedOut
                                }
                                is SignInMode.Redirect -> {
                                    val login = auth.beginLogin(selected.redirectUri)
                                    pending = login
                                    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(login.url))
                                }
                            }
                        } catch (cause: Throwable) {
                            if (cause is CancellationException) throw cause
                            view = AuthView.Error(cause.message ?: "Sign-in failed.")
                        }
                    }
                }) { Text(if (current is AuthView.Error) "Try again" else "Sign in with ChatGPT") }
            }
            is AuthView.Connecting -> {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator()
                    Text("Waiting for ChatGPT…")
                }
                current.userCode?.let {
                    Text("Enter code")
                    Text(it, style = MaterialTheme.typography.headlineSmall)
                }
            }
            is AuthView.Connected -> {
                Text(current.session.email ?: "Connected to ChatGPT")
                current.session.planType?.let { Text(it) }
                OutlinedButton(onClick = {
                    scope.launch {
                        view = try {
                            auth.logout(subject)
                            AuthView.SignedOut
                        } catch (cause: CancellationException) {
                            throw cause
                        } catch (cause: Throwable) {
                            AuthView.Error(cause.message ?: "Sign-out failed.")
                        }
                    }
                }) { Text("Sign out") }
            }
        }
        if (showDisclaimer) {
            Spacer(Modifier.height(2.dp))
            Text(
                "Experimental: this uses OpenAI’s Codex OAuth client for ChatGPT subscription access. " +
                    "It may violate OpenAI ToS for non-Codex use and can break at any time.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
