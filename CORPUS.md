# Clinical Language Corpus

Murmur V1.5.0 ships a built-in clinical language corpus: a compact set of
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
`web/index.html`, with six groups:

| Group | Contents |
|---|---|
| `presentation` | How the client presented: affect, reported concerns, stressors, thought process, and (only when the source records a risk assessment) denial of suicidal/homicidal ideation. |
| `assessmentProgress` | Progress and capacity statements: symptom reduction, insight, trigger identification, skill use outside session, remaining struggles. |
| `interventionsGeneral` | Orientation-neutral intervention language: active listening, trigger work, psychoeducation, planning, normalization, reinforcement, skills practice. |
| `interventionsByModality` | Intervention frames per modality (see matching below). |
| `response` | How the client responded: receptivity, insight, partial progress, difficulty, agreed practice. |
| `plan` | Next-step language: home practice, continued goal work, assignments, plan continuation, escalation steps. |

58 frames in total.

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
