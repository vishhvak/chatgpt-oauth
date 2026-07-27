pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "chatgpt-oauth-kotlin"
include(":chatgpt-oauth-core", ":chatgpt-oauth-android")
// Runnable example; never published.
include(":examples:verify")
