# Clinical Language Corpus

Murmur ships a built-in clinical language corpus (introduced in V1.5.0;
problem-focused layer and My Phrases added in V1.6.0): a compact set of
standard progress-note phrasing patterns ("frames") that is added to every
note-generation prompt, in both recording/transcript mode and
brief-summary mode. It was distilled from clinician-provided documentation
references (October 2025) and reduced to reusable sentence frames with
[bracketed slots] the model fills from the session material.

## Register

All frames follow standard progress-note register:

- Third person, past tense.
- Formal clinical verbs: assisted, explored, facilitated, processed,
  reinforced, validated, normalized, challenged, provided psychoeducation.

## Structure

The corpus lives in the app as the `CLINICAL_CORPUS` constant in
`web/index.html`, with six standard groups plus a problem-focused layer:

| Group | Contents |
|---|---|
| `presentation` | How the client presented: affect, reported concerns, stressors, thought process, and (only when the source records a risk assessment) denial of suicidal/homicidal ideation. |
| `assessmentProgress` | Progress and capacity statements: symptom reduction, insight, trigger identification, skill use outside session, remaining struggles. |
| `interventionsGeneral` | Orientation-neutral intervention language: active listening, trigger work, psychoeducation, planning, normalization, reinforcement, skills practice. |
| `interventionsByModality` | Intervention frames per modality (see matching below). |
| `response` | How the client responded: receptivity, insight, partial progress, difficulty, agreed practice. |
| `plan` | Next-step language: home practice, continued goal work, assignments, plan continuation, escalation steps. |

58 frames in the standard groups, plus 44 problem-focused frames (below)
— 102 in total.

## Modality matching

`corpusGuidance(orientationText)` picks **one** modality's intervention
frames based on the clinician's Orientation / style field, checking match
keys in this fixed order: DBT → Motivational Interviewing →
Psychodynamic → Trauma-focused → Addiction / substance use → CBT →
Behavioral → Family / systems → Supportive (default).

Keys include English terms (e.g. `cbt`, `cognitive`, `trauma`, `ptsd`,
`family`, `couple`) and Chinese terms (e.g. 认知， 创伤， 成瘾， 家庭， 人本）,
so both English and Chinese orientation entries match. If nothing
matches — including when the field is empty — the supportive /
person-centered frames are used. Only the matched modality's frames are
added, keeping the prompt compact.

## Problem-focused layer (V1.6.0)

Eleven problem sets, each with 4 frames that blend intervention,
progress, and remaining-difficulty phrasing for that presenting problem:
anxiety, depression, anger, grief & loss, OCD, relationship conflict,
self-esteem, family conflict, parenting, panic & phobias, and substance
use.

During generation, `matchProblems(sourceText)` scans the session source
(the transcript or the clinician's brief summary), counts keyword hits
per problem — keywords include English terms (`anxiety`, `depress`,
`panic`, `relapse`) and Chinese terms （焦虑， 抑郁， 惊恐， 复吸） — and
returns at most the **top 2** problems with at least one hit, ordered by
hit count (ties keep the corpus order above). Their frames are added to
the corpus block as a "Problem focus — <Problem>" subsection, after the
modality frames and before the client-response frames. When nothing
matches, no problem subsection is added. In the note editor's phrase
library (below), every problem set is its own always-browsable group —
no matching is needed there.

## My phrases (V1.6.0)

The note editor has a collapsible **Phrase library** panel listing every
corpus group — the standard sections, the modality sets, and all 11
problem sets. Clicking a phrase inserts it at the cursor of the note
section being edited.

- **Favorites**: every phrase has a star toggle (☆/★). Starred phrases
  are stored per user in the app preferences (`corpusFavorites`, a JSON
  array of phrase texts) and pinned at the top of the panel under
  **★ My phrases**.
- **Custom phrases**: an input + Add button at the end of the My phrases
  section stores your own phrasing (`corpusCustomPhrases`); each custom
  item can be deleted (×).
- **Effect on generation**: when favorites or custom phrases exist, the
  corpus block in the prompt ends with a "Therapist's own preferred
  phrasing — prefer these where they fit the content" subsection listing
  favorites first, then custom phrases, capped at 30 items. This steers
  drafts toward your own wording without overriding the safety rule, and
  the custom template still outranks it.

## Safety rule

The corpus block in the prompt always carries this instruction: prefer
the corpus phrasing **only where it accurately reflects the session**, and
**never add interventions, symptoms, risk statements, or progress that
are not supported by the session source** (the transcript or the
clinician's summary). The frames shape wording; they never add content.

## Priority order in the prompt

1. Note format, sections, and output language.
2. The clinician's orientation / style line.
3. The clinical language corpus block.
4. The clinician's custom template / instructions — **highest priority**;
   it overrides the preset format and the corpus wherever they conflict.

The corpus is prompt guidance only: it is not stored in the database, it
does not change saved notes, and it works fully offline like the rest of
the generation pipeline.
