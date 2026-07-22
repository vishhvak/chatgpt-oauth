plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `maven-publish`
}

kotlin {
    jvmToolchain(17)
}

java { withSourcesJar() }

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

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifactId = "chatgpt-oauth-core"
        }
    }
}
