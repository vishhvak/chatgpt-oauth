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
    }
    buildFeatures { compose = true }
}

kotlin { jvmToolchain(17) }

dependencies {
    api(project(":chatgpt-oauth-core"))
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
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
