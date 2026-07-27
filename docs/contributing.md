---
title: Contributing
description: Getting four toolchains running, and the rule that governs every change.
---

## The rule

`PROTOCOL.md` is the contract. All four ports implement it, and **a behaviour difference between
ports is a bug**.

So the first question for any behavioural change is not "does this work" but "do the other three do
it this way". Fixing a bug in one port without checking the other three leaves the repository less
consistent than it found it. When three ports agree and one differs, the odd one out is usually
wrong: that asymmetry is the sharpest bug-finding tool this repository has.

If a change alters behaviour the protocol specifies, update `PROTOCOL.md` in the same pull request.

## Toolchains

Each port is independent; you only need the one you are touching.

```sh
# TypeScript. Node 20+, pnpm 10
cd typescript && pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm typecheck:examples

# Python. 3.10+
cd python && python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/python -m mypy --strict src/chatgpt_oauth
.venv/bin/python -m ruff check .

# Kotlin. JDK 17, plus an Android SDK for the android module
cd kotlin
./gradlew :chatgpt-oauth-core:build :chatgpt-oauth-core:test
./gradlew :chatgpt-oauth-android:assembleRelease :chatgpt-oauth-android:testDebugUnitTest

# Swift. 5.9+
cd swift && swift build && swift test
```

These are exactly what CI runs. If they pass locally they pass there.

### Two environment traps

**`swift test` needs full Xcode, not the Command Line Tools.** If `xcode-select -p` points at
`/Library/Developer/CommandLineTools`, the test target fails to compile with `no such module
'XCTest'`. The build succeeds and only the tests break, which is a confusing signal. Fix without
`sudo`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
```

**Gradle needs `JAVA_HOME` and `ANDROID_HOME`.** The android module will not configure without an
SDK, and the JDK must be 17:

```sh
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
```

## What every change needs

- **Tests that fail without the fix.** The habit worth copying: apply the fix, write the test, then
  temporarily revert the fix and confirm the test goes red. A test that passes either way is
  decoration.
- **A check of the other three ports** for the same bug.
- **The port's full command list green**, not just its tests.

## Layout

```text
PROTOCOL.md          the contract every port implements
docs/                these pages
typescript/          published to npm; the most-used port
python/              published to PyPI
kotlin/              core + android module, published to Maven Central
swift/               SwiftPM; consumed by vendoring the swift/ subtree
video/               promo assets; not part of the library, not in CI
```

Each language directory is self-contained: its own README, examples, tests and build. Examples live
inside their port (`typescript/examples/`, `python/examples/`, …) so they can use that port's build
system directly.

## Running against a real account

Every test suite here talks to a mock, which proves the ports agree with the spec but never that the
spec still matches an undocumented backend. Each port has an `examples/verify` that signs in and
streams one response for real. Running one is the most useful contribution available for Python,
Swift and Kotlin, which have no confirmed production use.

## Publishing

Four packages across three registries, and their versions have drifted before. Bump them together,
tag the release, and remember that the Swift package is consumed by vendoring the `swift/` subtree, so a rename there breaks
vendored copies until they re-sync.
