# Murmur for Android

Murmur V1.4.0 adds Android support. The Android app is the same product —
same encrypted database format, accounts, audit log, bilingual UI, and
fully offline AI — with platform differences concentrated in one place:
how the AI engines are provided.

## Why Android is different: engines are bundled, not downloaded

On Windows/macOS, Murmur downloads `whisper-cli` / `llama-cli` executables
on first use and runs them from a data folder. Android forbids executing
downloaded binaries, so on Android the engines ship **inside the APK**:

- They are packaged as `jniLibs/arm64-v8a/libwhisper-cli.so` and
  `libllama-cli.so`, which Android extracts at install time into the app's
  native library directory — the one location app code may execute from.
- At runtime the Rust backend resolves engines from that directory
  (derived from `/proc/self/maps`), falling back to the app-data engines
  folder and the in-app custom path. Note Android 10+ may refuse to
  execute files from app-data folders; the bundled copies are the
  supported path.
- `llama-cli` comes from the official llama.cpp Android arm64 release
  (pinned at b11887 — the desktop build stays on its own pinned version;
  GGUF models are compatible). `whisper-cli` has **no official Android
  binary**, so `scripts/fetch-android-engines.sh` cross-compiles it from
  the whisper.cpp source with the Android NDK.
- In the app, Models & Settings on Android shows the engines as built-in
  (no download buttons); **models** (Whisper .bin / GGUF) still download
  normally over HTTPS, exactly like desktop.

## What works on Android

- Everything account-, data-, and notes-related: clients, notes, audit
  log, backups, bilingual UI with system-language detection.
- In-person **microphone recording** (the build script adds the
  `RECORD_AUDIO` permission to the generated manifest), audio import,
  local transcription and note drafting.
- Brief-summary mode, custom templates, output language, formats.

## What does not (yet)

- **Telehealth system-audio recording.** Android has no equivalent of
  the desktop screen-share audio capture in a WebView; capturing call
  audio needs native MediaProjection plumbing. The telehealth source is
  disabled in the Android UI with an explanation. Record telehealth
  sessions on a computer, or use the phone in person.
- Performance expectations: prefer Whisper Base/Small and the Qwen2.5
  1.5B note model on phones. Medium works on flagships; Large v3 Turbo
  is desktop territory.

## Building

Run `build-android.sh` on a macOS/Linux machine with Rust, the Tauri
CLI, JDK 17, and the Android SDK + NDK. It will:

1. Add the `aarch64-linux-android` Rust target.
2. Generate the Android project (`cargo tauri android init`, first run).
3. Patch the manifest with the microphone permissions.
4. Stage the engines (`scripts/fetch-android-engines.sh`).
5. Build the release APK; sign it if `MURMUR_ANDROID_KEYSTORE` and the
   related env vars are set.

The generated project under `src-tauri/gen/android/` is a build artifact
of the Tauri CLI — regenerate it with the script rather than editing it,
except where the script itself patches it.

## Distribution notes

- A signed APK can be installed directly (sideload) or uploaded to
  Google Play as an AAB (`cargo tauri android build --aab`).
- The database is compatible with desktop Murmur (same SQLCipher
  format); moving a backup file between phone and computer works,
  provided the app versions are the same.
