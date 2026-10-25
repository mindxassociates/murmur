# Changelog — Murmur

## V1.4.0 — 2026-10-25 (Android)

- **Android support (arm64)**: Murmur now builds for Android with the same encrypted database, accounts, audit log, bilingual UI, and offline AI. See `ANDROID.md`.
- **Bundled engines on Android**: Android forbids executing downloaded binaries, so the transcription and note engines ship inside the APK as native libraries (`jniLibs` → the app's native library directory, which the backend now resolves on Android). `llama-cli` comes from the official llama.cpp Android release (pinned b11887); `whisper-cli` is cross-compiled from source with the NDK by `scripts/fetch-android-engines.sh`, since no official Android binary exists. Models still download over HTTPS as on desktop; engine downloads are disabled on Android with an explanation.
- **Telehealth source is desktop-only**: Android has no WebView system-audio capture path, so the telehealth recording source is disabled in the Android UI with a note; microphone recording, audio import, and summary mode work as on desktop.
- **Build tooling**: `build-android.sh` (toolchain checks, Tauri Android project generation, RECORD_AUDIO manifest patch, engine staging, signed/unsigned release APK) and this changelog discipline extended to the Android artifacts.

## V1.3.0 — 2026-10-25 (telehealth recording)

- **Recording sources**: the AI Studio now offers *In-person · microphone* and *Telehealth · microphone + system audio*. Telehealth mode captures the system audio through screen sharing (share the entire screen, enable system audio) and mixes it with your microphone into the same local recording; the shared video is discarded immediately and never stored.
- **Audio input device picker**: choose any microphone or loopback device (Stereo Mix / VB-CABLE on Windows, BlackHole on macOS) — on systems where direct system-audio capture is unavailable, selecting a loopback device as the input covers telehealth recording. The source and device choices are remembered.
- Fully bilingual for the new controls (EN / 中文）, with an on-screen hint explaining each mode.

## V1.2.0 — 2026-10-25 (bilingual UI + developer credit)

- **Fully bilingual interface (English / 中文）**: every screen, dialog, toast, and table is translated — not just the navigation. The app **detects the system language on first run** (Chinese systems start in Chinese, everything else in English), remembers a manual choice per device, and the header button switches instantly, re-rendering all views. The recording-consent form now defaults to the UI language (its own EN/中文 toggle remains).
- **Developer credit**: the sidebar now credits the developer — **Mind X Associates** (https://mind.us), shown as **Mind X社区** linking to https://mind.us/zh in the Chinese UI. It is the only external link the app permits; all other external links remain disabled.
- Note section headings inside the editor localize with the UI; the saved note text and the AI generation prompts keep their canonical wording.

## V1.1.0 — 2026-10-25 (HIPAA safeguards release)

Murmur is used in the US as well as internationally, so this release hardens the app around the HIPAA Security Rule's technical safeguards (45 CFR 164.312). Full mapping and deployment guidance: `HIPAA.md`.

- **Automatic logoff**: inactivity auto-lock (default 10 minutes; 5/10/15/30 or off in Settings → Security & HIPAA safeguards). Locking drops the database key from memory.
- **User accounts UI**: administrators can now create and enable/disable per-person accounts (Admin / Clinician) from inside the app; every user can change their own password there. Backend rules unchanged (10+ character passwords, scrypt verifiers, 5-failure sign-in lockout).
- **Failed sign-in tracking**: failed attempts before a successful sign-in are now counted into the audit log.
- **Audit log in the app**: view recent entries and run the hash-chain integrity verification from Settings; the log also records note copy / plain-text export / print actions.
- **Export safeguards**: copying or exporting a note now warns that the result is unencrypted PHI and requires confirmation.
- **Secure audio deletion**: discarded/deleted session recordings are overwritten with zeros before unlinking.
- **HIPAA.md**: safeguards map (access control, authentication, automatic logoff, encryption, audit controls, transmission security), the export weak point, and the organizational checklist that remains the practice's responsibility. No certification is claimed — the app implements safeguards that support a covered entity's compliance program.

## V1.0.0 — 2026-10-25 (first release)

Named **Murmur** at release (working title during development was a generic descriptive name).

Standalone, fully offline AI progress-notes desktop app (Tauri 2 + SQLCipher), Windows & macOS.

- **Clients**: local list with add / edit / delete; deleting a client cascades to their saved notes. All data in a local encrypted database behind a per-user sign-in; daily automatic encrypted backups (30 kept) + manual backup; tamper-evident audit log inherited from the shared backend.
- **AI Studio — ambient mode**: consent-gated in-app recording (WebAudio → 16 kHz WAV) or audio-file import; local Whisper transcription; editable transcript.
- **AI Studio — summary mode**: brief typed summary generates the same structured note draft.
- **Transcription**: whisper.cpp engine; models Base / Small / Medium / **Large v3 Turbo**; language selector with Auto-detect + 34 languages （含普通话、粤语）.
- **Note generation**: llama.cpp engine with Qwen2.5 1.5B / 3B; drafts open in an editable section editor and are **never auto-saved**.
- **Formats**: SOAP / DAP / BIRP / Narrative, with per-note format switching in the editor.
- **Output language selector**: Follow transcript / English / 简体中文 / 繁體中文 / Español / 日本語 / 한국어 / Français / Deutsch / Português — the generation prompt instructs the model to write in the chosen language and format structure.
- **Orientation / style** free-text field fed into the prompt (plus a practice-level default in Settings).
- **Custom template / instructions** free-text area: paste your own template or instructions; auto-saved to the local preference store, applied to both generation modes, and injected into the prompt as the highest-priority framing (overrides the preset format on conflict). Covered by a smoke-test assertion that the typed text appears verbatim in the generated prompt.
- **Speaker-segment aids**: insert Therapist:/Client: markers, one-click relabel of the current line, auto-segment alternating speakers.
- **Cleanup options**: auto-delete the recording after transcription; auto-delete transcript + summary after the generated note is saved.
- **Notes view**: per-client filter + search; open / edit / delete; copy, `.txt` export, print / PDF.
- **Consent view**: printable recording-consent form in English and 中文.
- **Models & Settings view**: engine/model status and downloads with progress + cancel, custom engine paths, model import (.bin / .gguf), practitioner/practice settings, backup + storage info.
- **Interface**: English-first with a 中文 toggle for main labels.
- Everything runs offline after the one-time model downloads; external links are disabled in the app.

### Verification
- Frontend smoke test (jsdom, fake Tauri bridge): **45/45 passed** — account setup, client CRUD, studio controls, transcription flow, speaker aids, custom-template persistence + verbatim prompt injection, output-language + format prompt checks, draft → save flow with transcript auto-delete, brief-summary generation, format switching, consent forms (EN/中文）, models view, delete cascades, no-product-name / no-localStorage guards.
- Extracted JS: `node --check` clean.
- Not yet done: a full Tauri compile and a real-engine (Whisper/LLM) end-to-end run — neither is possible in the build sandbox (no Rust toolchain; model downloads blocked by the sandbox proxy). First on-device build via `build-windows.bat` / `build-macos.command` is the remaining verification step, as with the shared backend's other apps.
