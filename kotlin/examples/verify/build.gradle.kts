plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin { jvmToolchain(17) }

// Never published: an example, not a shipped artifact.
dependencies {
    implementation(project(":chatgpt-oauth-core"))
}

application {
    mainClass.set("dev.chatgptoauth.verify.VerifyKt")
}
