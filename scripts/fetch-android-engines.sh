#!/usr/bin/env bash
# Fetches / builds the ARM64 Android engine executables for Murmur and stages
# them as jniLibs libraries (libwhisper-cli.so / libllama-cli.so) — the only
# form Android will extract to the app's native library directory and allow
# the app to execute.
#
#   llama-cli : downloaded from the official llama.cpp release that first
#               shipped Android builds (pinned below; verified 2026-10-25).
#   whisper-cli: whisper.cpp publishes NO Android binaries, so this script
#               cross-compiles it with the Android NDK (cmake). Requires
#               ANDROID_NDK_HOME (or ANDROID_NDK_ROOT) to be set.
#
# Usage: scripts/fetch-android-engines.sh [jniLibs-dir]
# Default output: src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a
set -euo pipefail
cd "$(dirname "$0")/.."

LLAMA_TAG="${LLAMA_TAG:-b11887}"
WHISPER_TAG="${WHISPER_TAG:-v1.7.6}"
OUT="${1:-src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a}"
WORK=".android-engines"
mkdir -p "$OUT" "$WORK"

# ---- llama-cli (official Android arm64 release) ----
if [ ! -f "$OUT/libllama-cli.so" ]; then
  echo ">> Downloading llama.cpp $LLAMA_TAG (Android arm64)…"
  curl -fL -o "$WORK/llama.tar.gz" \
    "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-android-arm64.tar.gz"
  tar -xzf "$WORK/llama.tar.gz" -C "$WORK"
  BIN="$(find "$WORK" -name 'llama-cli' -type f | head -1)"
  [ -n "$BIN" ] || { echo "!! llama-cli not found in the release archive"; exit 1; }
  cp "$BIN" "$OUT/libllama-cli.so"
  # llama-cli dynamically links the release's libllama.so / libggml*.so —
  # bundle them next to it so the loader finds them in the same directory.
  find "$WORK" -name 'libllama.so' -o -name 'libggml*.so' | while read -r so; do cp "$so" "$OUT/"; done
  echo ">> libllama-cli.so staged (+ its shared libraries)"
fi

# ---- whisper-cli (cross-compiled with the NDK) ----
if [ ! -f "$OUT/libwhisper-cli.so" ]; then
  NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
  if [ -z "$NDK" ] || [ ! -d "$NDK" ]; then
    cat <<EOF
!! whisper.cpp ships no Android binaries, and no NDK was found.
   Install the Android NDK (Android Studio > SDK Manager > SDK Tools > NDK),
   then re-run with:  ANDROID_NDK_HOME=/path/to/ndk $0
   Skipping whisper-cli for now — the app will install, but transcription
   needs this engine.
EOF
    exit 2
  fi
  echo ">> Cross-compiling whisper.cpp $WHISPER_TAG for arm64-v8a (NDK: $NDK)…"
  if [ ! -d "$WORK/whisper.cpp" ]; then
    curl -fL -o "$WORK/whisper.tar.gz" "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$WHISPER_TAG.tar.gz"
    tar -xzf "$WORK/whisper.tar.gz" -C "$WORK"
    mv "$WORK/whisper.cpp-${WHISPER_TAG#v}" "$WORK/whisper.cpp"
  fi
  cmake -S "$WORK/whisper.cpp" -B "$WORK/whisper-build" \
    -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 \
    -DCMAKE_BUILD_TYPE=Release -DWHISPER_SDL2=OFF -DBUILD_SHARED_LIBS=OFF
  cmake --build "$WORK/whisper-build" -j --target whisper-cli
  BIN="$(find "$WORK/whisper-build" -name 'whisper-cli' -type f | head -1)"
  [ -n "$BIN" ] || { echo "!! whisper-cli build produced no binary"; exit 1; }
  cp "$BIN" "$OUT/libwhisper-cli.so"
  echo ">> libwhisper-cli.so staged"
fi

chmod +x "$OUT"/*.so 2>/dev/null || true
echo ">> Engines ready in $OUT:"
ls -la "$OUT"
