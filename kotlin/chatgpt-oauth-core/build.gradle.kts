import com.vanniktech.maven.publish.SonatypeHost

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.maven.publish)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(libs.coroutines.core)
    api(libs.serialization.json)
    api(libs.okhttp)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.coroutines.test)
    // Gradle ships its own junit-platform-launcher; pin it to the BOM so engine and launcher align.
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}

mavenPublishing {
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL)
    signAllPublications()

    // group + version come from the root build's allprojects block.
    coordinates(artifactId = "chatgpt-oauth-core")

    pom {
        name.set("chatgpt-oauth-core")
        description.set("Sign in with ChatGPT (OAuth) for Kotlin/JVM.")
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
