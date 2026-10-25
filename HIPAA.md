# Murmur and HIPAA — Safeguards Map & Deployment Guide

Murmur stores protected health information (PHI) for US practices, so it is built
around the HIPAA Security Rule's safeguards (45 CFR Part 164, Subpart C). This
document maps each relevant safeguard to what the software does, and — just as
important — what remains the covered entity's own responsibility. Software alone
cannot make a practice "HIPAA compliant"; compliance is the combination of this
tool's technical safeguards and your organization's policies, training, and risk
management. Nothing here is legal advice.

## Why the architecture helps

Murmur runs entirely on the clinician's own computer. There is no Murmur cloud,
no vendor server, no account with the developer, and no telemetry. Session
audio, transcripts, and notes never leave the device, so the developer is never
in possession of PHI and **no Business Associate Agreement with the developer is
needed** — there is no business-associate relationship because there is no access.
The only network activity in the product is the one-time download of speech and
language models from their public distribution points, over HTTPS; no client
data is ever sent anywhere.

## Technical safeguards — 45 CFR 164.312

### (a)(1) Access control — unique user identification
- Every user signs in with their own username and password. Shared sign-ins are
  technically possible but defeat accountability; give each person their own
  account (Settings → Security & HIPAA safeguards → User accounts, Admin only).
- Accounts have roles (Admin / Clinician). Only administrators can create or
  disable accounts, and the app refuses to disable the last active admin or the
  account you are signed in with.
- Disabling an account takes effect immediately for sign-in.

### (a)(2)(i) / (d) Person or entity authentication
- Passwords are never stored. Sign-in is verified against a scrypt-based
  verifier; the database key is additionally wrapped per user with AES-256-GCM.
- Minimum password length: 10 characters, enforced when accounts are created
  and when passwords change.
- Sign-in throttling: 5 failed attempts lock that username out for 5 minutes.
  Failed attempts are counted and recorded in the audit log at the next
  successful sign-in.

### (a)(2)(iii) Automatic logoff
- The app locks itself after a period of inactivity. Default: **10 minutes**,
  adjustable (5 / 10 / 15 / 30 minutes, or off — not recommended) in
  Settings → Security & HIPAA safeguards.
- Locking drops the database key from memory; the encrypted database cannot be
  read again without a password. The manual **Lock** button in the header does
  the same immediately.

### (a)(2)(iv) Encryption and decryption
- All stored client data — clients, notes, transcripts kept in the database,
  drafts, and settings — lives in a **SQLCipher database (AES-256)**. The key is
  random per installation and wrapped separately for each user's password.
- Backups are copies of that same encrypted database file, so backups are
  encrypted at rest too. Automatic backup: once a day on sign-in, newest 30
  kept; manual backups are integrity-verified when created.
- Session recordings exist as audio files only inside the app's data folder and
  only until transcription finishes or you discard them. Use the
  "delete recording after transcription" option (on by default in the AI
  Studio). Deleted recordings are **overwritten with zeros before unlinking**,
  so they are not trivially recoverable from the raw disk.

### (b) Audit controls
- A tamper-evident, hash-chained audit log (HMAC-SHA256 chain keyed from the
  database key) records: sign-ins (including a count of preceding failed
  attempts), sign-outs/locks, account creation and enable/disable, password
  changes, data saves, backups, audit-log verification, and note
  copy / plain-text export / print actions taken from the note editor.
- Review it in Settings → Security & HIPAA safeguards → Audit log, and run
  **Verify log integrity** to recompute the chain. A failed verification means
  the log was altered outside the app and should be investigated.

### (c) Integrity controls
- Backup files are opened and integrity-checked at creation; a corrupt backup
  is rejected and deleted rather than kept.
- The audit chain above doubles as an integrity mechanism for the log itself.

### (e) Transmission security
- PHI is never transmitted. The app works fully offline after model download.
  Model and engine downloads use HTTPS (TLS) and carry no client data.

## Exports are the weak point — handle with care

Copying a note, exporting a `.txt`, or printing creates **unencrypted** PHI
outside the app's protection. Murmur warns before copy/export and records each
of these actions in the audit log. Your policies should cover where exported
files may be stored (encrypted drives only), and printed notes should be filed
or securely destroyed.

## What remains yours (administrative & physical safeguards)

The Security Rule also requires things no app can do for you, including:

- **Risk analysis** (164.308(a)(1)) — document that you assessed risks to ePHI,
  including the device Murmur runs on.
- **Workstation security** (164.310(b–c)) — use a computer with full-disk
  encryption (BitLocker / FileVault), an OS screen lock, current OS updates,
  and restricted physical access. Murmur's encryption protects its database;
  full-disk encryption protects everything else, including exported files and
  temporary audio.
- **Workforce training & policies** (164.308(a)(5), 164.312(a)(2)(iii)
  procedures) — who may use the app, password rules, what to do with exports
  and printouts, and how recordings consent is obtained (the app ships a
  printable bilingual consent form for this).
- **Contingency plan** (164.308(a)(6–7)) — Murmur's automatic encrypted backups
  support this; decide where backup copies live and test a restore. Remember:
  a backup restored on another machine still needs a user's password.
- **Breach procedures** — if a device is lost or stolen, the encrypted database
  and per-user passwords are your main mitigation; document the incident
  process in advance.

## A note on "HIPAA compliant" claims

No software product is certified by HHS, and Murmur does not claim certification.
The accurate statement is: *Murmur implements technical safeguards designed to
support a covered entity's HIPAA compliance program, in a fully offline
architecture where the vendor never accesses PHI.*
