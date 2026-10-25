# Murmur

*Progress notes that never leave the room.*

**Version 1.4.0** · Desktop app for Windows & macOS · Tauri 2 + SQLCipher + local AI engines

Murmur turns therapy sessions into progress notes without anything leaving the computer it runs on. Record a session (with the client's consent) or type a brief summary, transcribe and draft locally, review and edit, then save — the only network use in the whole product is the one-time download of the speech and language models you choose.

## Why offline

- Session audio, transcripts, and notes are **never uploaded** anywhere. There is no account server, no cloud sync, no analytics, and no model training on your data.
- All client data lives in a **local encrypted database** (SQLCipher), protected by your own sign-in. Daily automatic encrypted backups (newest 30 kept) plus manual backup.
- After the first model download, the app works completely offline — on a plane, in a rural clinic, anywhere.

## Features

### Clients
- Simple local client list: add, edit, delete (deleting a client also deletes their saved notes).
- Use real names, initials, or code names — it never leaves the device.

### AI Studio
- **Ambient recording** in the app (consent checkbox required before the microphone opens), or **import an audio file**.
- **Recording sources for in-person and telehealth**: *In-person · microphone* (pick any audio input device, including loopback devices such as Stereo Mix / VB-CABLE / BlackHole that carry call audio), or *Telehealth · microphone + system audio* — share the entire screen with system audio on and Murmur mixes your mic with the computer audio (the shared video is discarded immediately). Where direct system-audio capture is unavailable (notably macOS), the loopback-device route covers telehealth.
- **Local transcription** with Whisper (whisper.cpp). Models: Base, Small, Medium, Large v3 Turbo — pick speed vs. accuracy.
- **Transcription language**: Auto-detect plus 34 languages, including English, 中文 (Mandarin), 粤语 (Cantonese), Español, 日本語， 한국어, Français, Deutsch, Português, Русский, العربية, हिन्दी, Tiếng Việt, ไทย, and more.
- **Editable transcript with speaker aids**: insert `Therapist:` / `Client:` markers, relabel the current line with one click, or auto-segment speakers as a starting point and correct the labels.
- **Brief-summary mode**: no recording? Type a few sentences after the session and generate the same structured draft.
- **Note format**: SOAP, DAP, BIRP, or Narrative.
- **Output language — your choice, independent of the session language**: follow the transcript, or write the note in English, 简体中文， 繁體中文， Español, 日本語， 한국어, Français, Deutsch, or Português.
- **Orientation / style field**: e.g. CBT, person-centered, concise — fed into the draft.
- **Custom template / instructions**: type or paste your own note template or natural-language instructions. It is saved on the device, applies to both recording and summary generation, and takes priority over the preset format wherever the two conflict.
- **Local note drafting** with an on-device language model (llama.cpp; Qwen2.5 1.5B fast / 3B recommended). The result opens as an **unsaved draft** in the note editor — nothing is ever saved without your review.
- **Cleanup options**: delete the recording right after transcription, and/or delete the transcript (and brief summary) once the note is saved.

### Notes
- All saved notes in one list, filterable by client and searchable.
- Open and edit any note in its format's section editor; switch formats if needed.
- Copy, export as `.txt`, or print / save as PDF.

### Recording consent
- A printable **informed-consent form for audio recording and computer-generated notes**, in English and 中文， explaining the fully local processing, deletion, and the client's right to decline or withdraw. Print it from the app and have it signed before recording.

### Models & Settings
- Engine and model status, one-click downloads with progress, cancel, custom engine paths, and importing model files you downloaded yourself (Whisper `.bin`, LLM `.gguf`).
- Practitioner / practice names (used on the consent form and printed notes), a default orientation/style, database backup, and storage information.

## Interface language
The interface is English-first, with a **中文** toggle in the header for the main labels.

## Security & HIPAA safeguards (V1.1.0)

Murmur is used with PHI in the US as well as internationally, and is built around the HIPAA Security Rule's technical safeguards (45 CFR 164.312) — see `HIPAA.md` for the full safeguards map and deployment guide. In brief:

- **Encryption at rest**: SQLCipher (AES-256) database; the key is random per install and wrapped per user with AES-256-GCM. Backups are encrypted copies and are integrity-checked.
- **Personal accounts**: unique username + password per user (minimum 10 characters, scrypt verifier), Admin / Clinician roles, sign-in throttling (5 failures → 5-minute lockout), and failed attempts recorded in the audit log.
- **Automatic logoff**: the app locks after 10 minutes of inactivity by default (adjustable in Settings) and drops the database key from memory.
- **Audit controls**: a tamper-evident, hash-chained audit log covers sign-ins, account changes, saves, backups, and note copy/export/print. View and verify it in Settings → Security & HIPAA safeguards.
- **No transmission**: PHI is never sent anywhere; the app is fully offline after the one-time HTTPS model downloads, so the developer never accesses PHI and no BAA is involved.
- **Recording hygiene**: deleted session recordings are overwritten with zeros before unlinking; copy/export of notes warns that the result is unencrypted PHI and is audited.

## Data & privacy notes
- The database and backups are encrypted files on your own device. JSON exports are *not* offered by this app on purpose; use the in-app backup.
- Portable mode: place a `portable.mode` file next to the app (Windows: next to the `.exe`; macOS: next to the `.app`) and all data lives in `Data/` + `Backups/` folders beside it — handy for a dedicated device or encrypted USB drive.
- Generated notes are drafts. The clinician remains fully responsible for reviewing and finalizing every note.

## Tech
- **Shell**: Tauri 2 (Rust), single-file web UI (`web/index.html`).
- **Storage**: SQLCipher (bundled), per-user wrapped keys, tamper-evident audit log.
- **Speech**: whisper.cpp (`whisper-cli`) with GGML models from the whisper.cpp model repository.
- **Drafting**: llama.cpp (`llama-cli`) with Qwen2.5 Instruct GGUF models.
- Engines and models download on first use into the app data folder (`ai-engines/`, `ai-models/`); recordings pass through a temp folder (`ai-audio/`) and can be auto-deleted.

## Build
See `START-HERE.md`. In short: `build-windows.bat` (Windows) or `build-macos.command` (macOS) installs missing toolchains and builds the installer + portable zip into `release/`. Frontend smoke test (no browser needed): install `jsdom` once (`npm i jsdom` in a scratch folder) and run `NODE_PATH=<that folder>/node_modules node scripts/smoke-test.cjs`.

## Android

Murmur also runs on Android (arm64). The Android build bundles the AI engines inside the APK — Android forbids running downloaded executables — so engines are built in rather than downloaded; models still download normally. Telehealth system-audio capture is desktop-only; on Android, use the microphone source. Build with `build-android.sh`; full details in `ANDROID.md`.

## Developer

Murmur is developed by [Mind X Associates](https://mind.us) ([Mind X社区 — 中文](https://mind.us/zh)). The app itself carries the same credit in the sidebar; the link opens the developer site in your browser (the only external link the app allows).

## Version history
See `CHANGELOG.md`. Current: **V1.4.0**.
