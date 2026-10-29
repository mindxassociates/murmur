# Changelog — Murmur

## V1.7.0 — 2026-10-29 (note verification + transcription vocabulary)

- **Verify note — a faithfulness second pass**: with an AI-generated draft open in the note editor (from either the transcript or the brief-summary mode), a new **Verify note** button runs the same local note model a second time, this time as a checker. It compares the draft against the exact source it was generated from and lists factual statements the source does not support — interventions, symptoms, events, attributed statements, progress, risk content. Each flag quotes the draft text verbatim and explains why it appears unsupported, and can be dismissed individually; an empty result reports "No unsupported statements found". Phrasing, formatting, and standard clinical framing are explicitly out of scope for the checker. **Honest limits**: this is an advisory pass by the same local model that wrote the draft — it can miss unsupported statements and can flag statements that are in fact supported, so it is a second pair of eyes, not a guarantee. Verification never modifies the draft and is never required before saving.
- **Transcription vocabulary**: AI Studio gains a **Transcription vocabulary** field (saved on this device) for terms Whisper should expect — medication names, proper names, technical vocabulary, separated by commas or new lines. At transcription time the selected client's name is prepended automatically, duplicates are removed, and the combined list (capped at 400 characters) is passed to whisper-cli as its initial prompt (`--prompt`), which noticeably improves recognition of exactly those names and terms. Applies on desktop and Android, in every transcription language.

## V1.6.0 — 2026-10-25 (problem-focused corpus + My Phrases)

- **Problem-focused corpus**: on top of the modality layer, the corpus now carries 11 problem-focused frame sets (anxiety, depression, anger, grief & loss, OCD, relationship conflict, self-esteem, family conflict, parenting, panic & phobias, substance use — 4 frames each). During generation, the session source (transcript or brief summary) is keyword-matched and the top two matching problems add a "Problem focus" subsection to the prompt, so phrasing follows what the session was actually about. No keyword hits → no problem subsection.
- **My phrases**: the note editor gains a collapsible **Phrase library** panel with every corpus group (standard sections, modality sets, and all 11 problem sets). Any phrase can be starred (☆/★) into a pinned **★ My phrases** section, and you can add your own custom phrases (and delete them). Favorites and custom phrases are stored per user on this device.
- **Your phrasing steers generation**: when favorites or custom phrases exist, the generation prompt appends a "Therapist's own preferred phrasing" subsection (favorites first, then custom, up to 30), so drafted notes prefer your wording where it fits the content. The clinician's custom template remains the highest-priority instruction.
- Fully bilingual for the new controls (EN / 中文）, on desktop and Android alike.

## V1.5.0 — 2026-10-25 (clinical language corpus)

- **Built-in clinical language corpus**: Murmur now carries a corpus of standard progress-note phrasing patterns (58 frames across presentation, assessment/progress, general interventions, per-modality interventions, client response, and plan), distilled from professional documentation references. See `CORPUS.md`.
- **Standard register**: generated notes now phrase toward standard progress-note register — third person, past tense, formal clinical verbs (assisted, explored, facilitated, processed, reinforced, validated, normalized, challenged, provided psychoeducation) — filling the frames' slots from the session material.
- **Modality-matched intervention language**: the intervention frames follow the Orientation / style field (DBT, motivational interviewing, psychodynamic, trauma-focused, addiction, CBT, behavioral, family/systems; supportive/person-centered by default), matched in English or Chinese.
- **Content stays source-bound**: corpus phrasing is used only where the session content supports it — the prompt explicitly forbids adding interventions, symptoms, risk statements, or progress that the transcript or summary does not support.
- **Both generation modes, all platforms**: the corpus is part of the generation prompt for recording/transcript mode and brief-summary mode alike, on desktop and Android. The clinician's custom template remains the highest-priority instruction, ahead of the corpus.

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
