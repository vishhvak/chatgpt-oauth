import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.SonatypeHost

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.maven.publish)
}

android {
    namespace = "dev.chatgptoauth.android"
    compileSdk = 36

    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // chatgpt-oauth-core uses java.util.Base64 (Pkce.kt) and java.util.UUID.randomUUID
        // (Client.kt). java.util.Base64 only exists from API 26, so without desugaring every
        // beginLogin() on an API 23-25 device dies with NoSuchMethodError — and minSdk here is 23.
        isCoreLibraryDesugaringEnabled = true
    }
    buildFeatures { compose = true }
    testOptions { unitTests.all { it.useJUnitPlatform() } }
}

kotlin { jvmToolchain(17) }

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    api(project(":chatgpt-oauth-core"))
    // Transitional: read-only, used solely by LegacyEncryptedPreferences to migrate records written
    // before the Keystore envelope. Google deprecated this library in April 2025 at 1.1.0-alpha07.
    // Drop it once no install can still hold a legacy record.
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(kotlin("test"))
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

mavenPublishing {
    configure(AndroidSingleVariantLibrary("release", sourcesJar = true, publishJavadocJar = true))
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL)
    signAllPublications()

    // group + version come from the root build's allprojects block.
    coordinates(artifactId = "chatgpt-oauth-android")

    pom {
        name.set("chatgpt-oauth-android")
        description.set("Sign in with ChatGPT (OAuth) for Android.")
        url.set("https://github.com/vishhvak/chatgpt-oauth")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://github.com/vishhvak/chatgpt-oauth/blob/main/LICENSE")
            }
        }
        developers {
            developer {
                id.set("vishhvak")
                name.set("Vishhvak Srinivasan")
                email.set("vishhvak@outlook.com")
            }
        }
        scm {
            url.set("https://github.com/vishhvak/chatgpt-oauth")
            connection.set("scm:git:git://github.com/vishhvak/chatgpt-oauth.git")
            developerConnection.set("scm:git:ssh://git@github.com/vishhvak/chatgpt-oauth.git")
        }
    }
}
