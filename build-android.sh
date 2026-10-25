#!/usr/bin/env bash
# Murmur — one-click Android build (macOS / Linux development machine).
#
# Produces a release APK under src-tauri/gen/android/app/build/outputs/.
# First run installs nothing automatically; it checks for the toolchain and
# tells you exactly what is missing:
#   - Rust (rustup) + the Tauri CLI:   cargo install tauri-cli --version "^2"
#   - Android SDK + NDK (Android Studio > SDK Manager), JAVA_HOME (JDK 17)
#   - ANDROID_HOME / ANDROID_NDK_HOME environment variables
#
# Signing (optional): set MURMUR_ANDROID_KEYSTORE=/path/keystore.jks,
# MURMUR_ANDROID_KEY_ALIAS, MURMUR_ANDROID_KEY_PASS, MURMUR_ANDROID_STORE_PASS
# and the APK is signed after the build. Without them you get an unsigned
# release APK (fine for testing after signing with your own key; Android
# requires every APK to be signed before install).
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo "[FAIL] $*"; exit 1; }

command -v cargo >/dev/null || fail "cargo not found — install Rust from https://rustup.rs"
command -v cargo-tauri >/dev/null || fail "Tauri CLI not found — run: cargo install tauri-cli --version \"^2\""
[ -n "${JAVA_HOME:-}" ] || fail "JAVA_HOME is not set (point it at a JDK 17)"
[ -n "${ANDROID_HOME:-}" ] || fail "ANDROID_HOME is not set (Android SDK path)"
[ -n "${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}" ] || fail "ANDROID_NDK_HOME is not set (needed for the Rust Android targets and the whisper build)"

echo ">> Ensuring the Rust Android target…"
rustup target add aarch64-linux-android >/dev/null

if [ ! -d src-tauri/gen/android ]; then
  echo ">> Generating the Android project (first run only)…"
  cargo tauri android init
fi

echo ">> Patching AndroidManifest.xml (microphone permission for in-app recording)…"
python3 - <<'PY'
import pathlib
m = pathlib.Path("src-tauri/gen/android/app/src/main/AndroidManifest.xml")
t = m.read_text(encoding="utf-8")
add = ""
if "RECORD_AUDIO" not in t:
    add += '    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
if "MODIFY_AUDIO_SETTINGS" not in t:
    add += '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n'
if add:
    t = t.replace("</manifest>", add + "</manifest>")
    m.write_text(t, encoding="utf-8")
    print("   permissions added")
else:
    print("   already present")
PY

echo ">> Staging the bundled engines (jniLibs)…"
scripts/fetch-android-engines.sh

echo ">> Building the release APK (arm64)…"
cargo tauri android build --apk --target aarch64

APK="$(find src-tauri/gen/android/app/build/outputs/apk -name '*release*.apk' | head -1)"
[ -n "$APK" ] || fail "Build finished but no release APK was found."

if [ -n "${MURMUR_ANDROID_KEYSTORE:-}" ]; then
  echo ">> Signing the APK…"
  BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
  "$BT/zipalign" -f -p 4 "$APK" "${APK%.apk}-aligned.apk"
  APKSIGNER_PASS="pass:${MURMUR_ANDROID_STORE_PASS:-}" "$BT/apksigner" sign \
    --ks "$MURMUR_ANDROID_KEYSTORE" --ks-key-alias "${MURMUR_ANDROID_KEY_ALIAS:-murmur}" \
    --ks-pass "pass:${MURMUR_ANDROID_STORE_PASS:-}" --key-pass "pass:${MURMUR_ANDROID_KEY_PASS:-}" \
    --out "Murmur-Android.apk" "${APK%.apk}-aligned.apk"
  echo ">> Signed APK: Murmur-Android.apk"
else
  echo ">> Unsigned release APK: $APK"
  echo "   (Android requires a signature before install — set MURMUR_ANDROID_KEYSTORE to sign automatically.)"
fi
echo ">> Done."
