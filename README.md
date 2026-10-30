# Murmur

*Progress notes that never leave the room.*

**Version 1.11.0** · Desktop app for Windows & macOS · Tauri 2 + SQLCipher + local AI engines

Murmur turns therapy sessions into progress notes without anything leaving the computer it runs on. Record a session (with the client's consent) or type a brief summary, transcribe and draft locally, review and edit, then save — the only network use in the whole product is the one-time download of the speech and language models you choose.

## Why offline

- Session audio, transcripts, and notes are **never uploaded** anywhere. There is no account server, no cloud sync, no analytics, and no model training on your data.
- All client data lives in a **local encrypted database** (SQLCipher), protected by your own sign-in. Daily automatic encrypted backups (newest 30 kept) plus manual backup.
- After the first model download, the app works completely offline — on a plane, in a rural clinic, anywhere.

## Features

### Home
- **Sessions awaiting notes**: every finished transcription — and every summary you generate from — lands in a queue on the Home view. An item stays there until its note is actually **saved** (drafts are still never auto-saved), so nothing falls through the cracks between sessions.
- **Write all**: generate drafts for the whole queue in one run, then review them one at a time in the editor.
- **Drafts to review**: every generated draft also lands in a review list on Home until you save or discard it. The Home headline counts both sides — "N notes to write, M to review." — and filter tabs switch between All / To write / To review.
- **Global search**: one box searches the text of every saved note plus the pending queue's source material, with the matched term highlighted; pending items are labeled as such.
- **First-run setup wizard**: a skippable six-step guided setup — note style, recording defaults, engine/model status, your first client, and a fictional sample session you can generate a real note from — with a **Finish setup** reminder on Home until it is done, and a **Run setup again** button in Models & Settings.

### Clients
- Simple local client list: add, edit, delete (deleting a client also deletes their saved notes).
- **Client workspace**: opening a client shows their workspace — a client list with pending-count dots on the left; in the center, a **case overview** (generated locally from that client's *finalized* notes only, regenerated on demand and after each finalize), a **Diagnosis** card (structured code + description entries you enter yourself — diagnoses are never suggested by the AI), **treatment goals** as a list, and a merged **Sessions** list (needs-note, to-review, and finalized, with filters). The note panel for the selected session sits on the right.
- **Pronouns and per-client instructions**: each client record carries pronouns, and optional instructions that replace your global template for that client whenever they are set.
- Use real names, initials, or code names — it never leaves the device.
- **Per-client treatment goals and default format**: record each client's treatment goals and, if you like, their default note format. Selecting the client in AI Studio preselects their format, and generated drafts frame assessment and progress relative to the goals — only where the session source supports it.
- **Per-client recording-consent record**: each client's consent status, method (verbal or written), and date live on the client record itself, with a status pill in the client list.

### AI Studio
- **Ambient recording** in the app (consent checkbox required before the microphone opens), or **import an audio file**.
- **Recording sources for in-person and telehealth**: *In-person · microphone* (pick any audio input device, including loopback devices such as Stereo Mix / VB-CABLE / BlackHole that carry call audio), or *Telehealth · microphone + system audio* — share the entire screen with system audio on and Murmur mixes your mic with the computer audio (the shared video is discarded immediately). Where direct system-audio capture is unavailable (notably macOS), the loopback-device route covers telehealth.
- **Local transcription** with Whisper (whisper.cpp). Models: Base, Small, Medium, Large v3 Turbo — pick speed vs. accuracy.
- **Transcription language**: Auto-detect plus 34 languages, including English, 中文 (Mandarin), 粤语 (Cantonese), Español, 日本語， 한국어, Français, Deutsch, Português, Русский, العربية, हिन्दी, Tiếng Việt, ไทย, and more.
- **Transcription vocabulary**: give Whisper a list of terms to expect — medication names, proper names, technical vocabulary — and it recognizes them far more reliably. The selected client's name is added automatically; the combined list is passed to the engine as its initial prompt on every transcription.
- **Editable transcript with speaker aids**: insert `Therapist:` / `Client:` markers, relabel the current line with one click, or auto-segment speakers as a starting point and correct the labels.
- **Speaker separation with voice enrollment**: after transcription, an optional offline pass groups the session recording by voice and rewrites the transcript with `Therapist:` / `Client:` labels (extra voices become Client 2, Speaker 3, …). A 25–30 second sample of the clinician's own voice, recorded once in Models & Settings, identifies which speaker is the therapist; without a sample, a one-click **This is me** correction uses a sample line from each speaker. The original unlabeled transcript stays one toggle away.
- **Brief-summary mode**: no recording? Type a few sentences after the session and generate the same structured draft — or **dictate** them: the Dictate button records your voice alone (microphone only, no client present) and drops the transcription into the summary box for editing.
- **Mental Status Exam quick entry**: a tappable 11-domain MSE panel (appearance through judgment) with standard clinical descriptors, an "All normal" shortcut, and a free-text note per domain. The composed paragraph steers generation as clinician-observed fact, and can be inserted into the draft with one click.
- **Note format**: SOAP, DAP, BIRP, GIRP, PIRP, SIRP, or Narrative.
- **Detail level**: Brief / Standard / Detailed — controls how long and deep the drafted note runs (Brief ≈ half of Standard; Standard targets roughly 300–500 words, Comprehensive runs five to seven sentences per section).
- **Verbatim quotes**: None / Some / Many — how much of the client's own wording the draft may quote directly.
- **Session details**: session type (Individual / Couples / Family / Group), modality (In person / Telehealth), and start/end times are captured with the session and carried onto the queue item and the saved note. Brief mode shows a live word counter with a soft ~30-word hint.
- **For this session only**: one-shot instructions included in a single generation, then cleared.
- **Example of my writing**: paste one of your own finished notes in Settings and drafts will match its voice and formatting habits — never its content.
- **Recording auto-stop**: an optional safety net (30 / 45 / 60 / 90 minutes) that stops a recording at the limit.
- **Output language — your choice, independent of the session language**: follow the transcript, or write the note in English, 简体中文， 繁體中文， Español, 日本語， 한국어, Français, Deutsch, or Português.
- **Orientation / style field**: e.g. CBT, person-centered, concise — fed into the draft.
- **Custom template / instructions**: type or paste your own note template or natural-language instructions. It is saved on the device, applies to both recording and summary generation, and takes priority over the preset format wherever the two conflict.
- **Local note drafting** with an on-device language model (llama.cpp; Qwen2.5 1.5B fast / 3B recommended). The result opens as an **unsaved draft** in the note editor — nothing is ever saved without your review. Models & Settings labels each note model by the memory it suits (3B: 16 GB or more; 1.5B: better for 8 GB machines) and preselects the one that fits this device on a first choice — a downloaded or previously picked model is never overridden.
- **Verify note (faithfulness check)**: from the draft, one click runs a second pass of the same local model that compares the draft against its source (transcript or summary) and lists any factual statements the source does not support — each flag quotes the draft text and explains the problem, and can be dismissed. It is advisory only: the same model does the checking, so treat it as a second pair of eyes, not a guarantee. Verifying never changes the draft and is never required before saving.
- **Cleanup options**: delete the recording right after transcription, and/or delete the transcript (and brief summary) once the note is saved.

### Notes
- All saved notes in one list, filterable by client and searchable.
- Open and edit any note in its format's section editor; switch formats if needed.
- The note panel shows a four-step progress indicator (Recorded → Transcribed → Note → Finalized) and tabs for the **Note**, its retained **Transcript** (the source text is kept with the note), **Measures** (the session's MSE), and **Details** (session type, modality, times, origin, timestamps). Each section has its own Copy button.
- **Finalize**: lock a finished note read-only with one click; **Unlock** returns it to a draft when you need to edit. Finalized notes are the only notes the client case overview is built from.
- Copy, export as `.txt`, or print / save as PDF.

### Recording consent
- A printable **informed-consent form for audio recording and computer-generated notes**, in English and 中文， explaining the fully local processing, deletion, and the client's right to decline or withdraw. Open it from the **Consent form** button next to the recording consent checkbox in AI Studio, print it, and have it signed before recording; the signed record (status, method, date) is kept on the client's record under **Clients**.

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

## Clinical language corpus

Generated notes are phrased toward standard progress-note register (third person, past tense, clinical verbs) using a built-in corpus of phrasing patterns. Intervention language follows the modality named in the Orientation / style field, a problem-focused layer matches the session content to 11 problem frame sets (anxiety, depression, grief, OCD, panic, substance use, and more), and corpus phrasing is used only where the session content supports it — never to add content. The note editor's phrase library lets you insert any corpus phrase with one click, star favorites, and add your own phrases under **★ My phrases**; your saved phrases also steer generated notes toward your own wording. See `CORPUS.md`.

## Android

Murmur also runs on Android (arm64). The Android build bundles the AI engines inside the APK — Android forbids running downloaded executables — so engines are built in rather than downloaded; models still download normally. Telehealth system-audio capture is desktop-only; on Android, use the microphone source. Build with `build-android.sh`; full details in `ANDROID.md`.

## Developer

Murmur is developed by [Mind X Associates](https://mind.us) ([Mind X社区 — 中文](https://mind.us/zh)). The app itself carries the same credit in the sidebar; the link opens the developer site in your browser (the only external link the app allows).

## Version history
See `CHANGELOG.md`. Current: **V1.13.0**.
