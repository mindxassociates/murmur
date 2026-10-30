# Start Here — Murmur V1.8.0

## Build the app (first time)

- **Windows**: double-click `build-windows.bat`. It installs Node.js / Rust if missing, builds the app, and places the installer + portable zip in `release/`.
- **macOS**: run `build-macos.command` (right-click → Open the first time). It installs missing tools, builds the app, and places the .dmg / app zip / portable zip in `release/`. The macOS build is unsigned; on first launch use right-click → Open.
- **Android**: run `build-android.sh` on a macOS/Linux machine with the Android SDK + NDK — see `ANDROID.md`. The Android app bundles its AI engines in the APK (no engine downloads) and does not offer telehealth system-audio recording.

## First run

1. Launch the app and create your local account (username + a password of at least 10 characters). This password unlocks the encrypted database — there is no way to recover it, so keep it somewhere safe.
2. Go to **Models & Settings** and download, in order: the Whisper engine (Windows auto-download; on macOS install `whisper-cpp` via Homebrew or set its path), one Whisper model (Small is a good start; Large v3 Turbo is the most accurate), the note engine, and one note model (Qwen2.5 3B recommended).
3. Add a client under **Clients**.
4. In **Recording Consent**, print the consent form (English or 中文） and have it signed before you record anyone.
5. In **AI Studio**: pick the client, tick the consent box, record (or import audio), transcribe, tidy the transcript/speaker labels if needed, then generate the draft. Review and edit it in the note editor, then **Save**.

Everything after the model downloads works fully offline.

## Handy options in AI Studio

- **Output language** is independent of the session language — e.g. hold the session in Spanish, write the note in English.
- **Custom template / instructions**: paste your own template once; it is remembered and takes priority over the preset formats.
- **Phrase library / My phrases**: in the note editor, open the phrase library to insert standard corpus phrasing (including problem-focused sets) with one click. Star (☆) the phrases you use most, or add your own — they stay pinned under **★ My phrases**, and generated notes prefer them where they fit.
- **Transcription vocabulary**: list medication names, proper names, and technical terms in AI Studio (the client's name is added automatically) so Whisper spells them correctly the first time.
- **Verify note**: with an AI draft open, click **Verify note** to have the same local model re-check the draft against its source and flag statements the source does not support. Advisory only — review the flags yourself; the draft is never changed automatically.
- **Home queue**: finished transcriptions and generated-from summaries wait under **Home → Sessions awaiting notes** until their note is saved. **Write all** drafts the whole queue in one run for one-by-one review; the search box on Home searches saved notes and pending items together.
- **Mental Status Exam**: tap through the 11-domain MSE panel in AI Studio (use **All normal** for the routine case); the composed paragraph guides generation and can be inserted into the draft from the note editor.
- **Client goals & default format**: set them on the client record — the Studio preselects the client's format, and drafts frame progress against the goals where the source supports it. **Detail level** (Brief / Standard / Detailed) sits next to the format selector.
- **Dictate a summary**: in Mode 2, **Dictate** records your own voice and transcribes it straight into the summary box.
- Tick **Delete transcript after the note is saved** if you want the working text wiped as soon as the note is stored.

## Run the frontend smoke test (developers)

```sh
mkdir -p /tmp/oan-smoke && cd /tmp/oan-smoke && npm i jsdom
cd <this folder>
NODE_PATH=/tmp/oan-smoke/node_modules node scripts/smoke-test.cjs
# Expected: SMOKE TEST: 45/45 passed
```
