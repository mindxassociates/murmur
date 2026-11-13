/* Frontend smoke test for Auris (Tauri Web UI).
 * Runs web/index.html in jsdom with an in-memory fake of the Tauri bridge
 * (db_get_state / db_set_state behave like the SQLCipher workspace snapshot).
 * Uses ONLY fictional test data. Run: NODE_PATH=/tmp/oan-smoke/node_modules node scripts/smoke-test.cjs
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

// ---- Fake Tauri backend (mirrors src-tauri/src/lib.rs command semantics) ----
let workspaceJson = null;
let aiProc = null, aiDiscarded = '', lastPrompt = '';
let lastTranscribeArgs = null, verifyOutput = '[]';
let lastDiarizeArgs = null; const discardLog = [];
let genBehavior = null, procCancelCount = 0;
let audioSeq = 0; const snapshotLog = []; let previewOut = 'Preview line one from the snapshot.'; let failSnapshot = false;
const prefs = new Map();
const auditEvents = [];
let user = null;
const fakeInvoke = async (cmd, args = {}) => {
  switch (cmd) {
    case 'startup_status': return { needsSetup: workspaceJson === null, authenticated: false, user: null };
    case 'startup_setup': user = { id: 'u1', username: args.input.username, displayName: args.input.displayName || args.input.username, role: 'Admin' }; workspaceJson = '{}'; return { ok: true, user };
    case 'startup_login': return { ok: true, user };
    case 'auth_status': return { needsSetup: false, authenticated: !!user, user };
    case 'auth_lock': user = null; return { ok: true };
    case 'db_get_state': return workspaceJson;
    case 'db_set_state': workspaceJson = args.json; return true;
    case 'db_list_prefs': return Object.fromEntries(prefs);
    case 'db_get_pref': return prefs.has(args.key) ? prefs.get(args.key) : null;
    case 'db_set_pref': prefs.set(args.key, args.val); return true;
    case 'db_remove_pref': prefs.delete(args.key); return true;
    case 'db_info': return { dbPath: '/fake/Data/murmur.db', backupDir: '/fake/Backups', dataDir: '/fake/Data', portableMode: false, size: 1024, encrypted: true, integrity: 'ok' };
    case 'db_backup': return { ok: true, file: '/fake/Backups/notes_manual.db', verified: true };
    case 'audit_list': return [];
    case 'audit_verify': return { ok: true };
    case 'audit_event': auditEvents.push(args.input); return true;
    case 'users_list': return [{ id: 'u-admin', username: 'tester', display_name: 'Test Clinician', role: 'Admin', active: true, created_at: '', updated_at: '' }];
    case 'users_create': return { ok: true };
    case 'users_set_active': return { ok: true };
    case 'change_password': return { ok: true };
    case 'open_path': return true;
    case 'ai_status': return { whisper: { found: true, path: '/fake/whisper-cli' }, llama: { found: true, path: '/fake/llama-cli' }, diarize: { found: true, path: '/fake/sherpa-onnx-offline-speaker-diarization' }, models: [
      { id: 'base', kind: 'whisper', label: 'Base', file: 'ggml-base.bin', downloaded: false, bytes: 0 },
      { id: 'small', kind: 'whisper', label: 'Small', file: 'ggml-small.bin', downloaded: true, bytes: 487601967 },
      { id: 'medium', kind: 'whisper', label: 'Medium', file: 'ggml-medium.bin', downloaded: false, bytes: 0 },
      { id: 'turbo', kind: 'whisper', label: 'Large v3 Turbo', file: 'ggml-large-v3-turbo.bin', downloaded: false, bytes: 0 },
      { id: 'qwen15', kind: 'llm', label: 'Qwen2.5 1.5B', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', downloaded: false, bytes: 0 },
      { id: 'qwen3', kind: 'llm', label: 'Qwen2.5 3B', file: 'qwen2.5-3b-instruct-q4_k_m.gguf', downloaded: true, bytes: 2104049000 },
      { id: 'seg', kind: 'diarize', label: 'Speaker segmentation model', file: 'diarize-segmentation.onnx', downloaded: true, bytes: 5992913 },
      { id: 'emb', kind: 'diarize', label: 'Speaker embedding model', file: 'diarize-embedding.onnx', downloaded: true, bytes: 39593761 } ],
      modelsDir: '/fake/ai-models', enginesDir: '/fake/ai-engines', os: 'windows', download: null, proc: null };
    case 'ai_download': return true;
    case 'ai_download_cancel': return true;
    case 'ai_set_engine_path': return true;
    case 'ai_import_model': return 'imported.gguf';
    case 'audio_begin': audioSeq++; return { id: 'a' + audioSeq, path: '/fake/ai-audio/a' + audioSeq + '.wav' };
    case 'audio_append': return true;
    case 'audio_finish': return { path: '/fake/ai-audio/a1.wav', bytes: 1234 };
    case 'audio_snapshot': snapshotLog.push(args.id); if (failSnapshot) throw new Error('snapshot failed (simulated)'); return { path: '/fake/ai-audio/' + args.id + '-snap.wav', bytes: 4321 };
    case 'audio_discard': aiDiscarded = args.path; discardLog.push(args.path); return true;
    case 'transcribe_start': lastTranscribeArgs = args; aiProc = { kind: 'transcribe', n: 0 }; return true;
    case 'diarize_start': lastDiarizeArgs = args; aiProc = { kind: 'diarize', n: 0, combined: !!args.enrollPath }; return { input: args.enrollPath ? '/fake/ai-audio/diarize-combined.wav' : args.audioPath, combined: !!args.enrollPath };
    case 'generate_start': lastPrompt = args.prompt; aiProc = { kind: 'generate', n: 0, gen: genBehavior, out: args.prompt.includes('VERIFY NOTE AGAINST SOURCE') ? verifyOutput : undefined }; return true;
    case 'ai_proc_poll': { if (!aiProc) return { active: false, kind: '', done: true, output: '', progress: -1 };
      aiProc.n++; if (aiProc.gen) { const r = aiProc.gen(aiProc.n); if (r) { if (r.done) aiProc = null; return r; } }
      if (aiProc.n < 2) return { active: true, kind: aiProc.kind, done: false, progress: 50, output: '' };
      const kind = aiProc.kind; const customOut = aiProc.out; const aiProcCombined = !!aiProc.combined; aiProc = null;
      const output = kind === 'diarize'
        ? (aiProcCombined ? 'Started\n0.500 -- 27.500 speaker_00\n30.000 -- 34.000 speaker_00\n35.000 -- 39.000 speaker_01\n40.000 -- 44.000 speaker_00\n45.000 -- 49.000 speaker_01'
          : 'Started\n1.000 -- 5.000 speaker_01\n6.000 -- 10.000 speaker_00\n11.000 -- 15.000 speaker_01\n16.000 -- 20.000 speaker_00')
        : kind === 'transcribe'
        ? (lastTranscribeArgs && (lastTranscribeArgs.audioPath || '').includes('-snap')
          ? previewOut
          : lastTranscribeArgs && lastTranscribeArgs.timestamps
          ? '[00:00:01.000 --> 00:00:05.000]  I have not been sleeping well and work stress is high.\n[00:00:06.000 --> 00:00:10.000]  We talked about your sleep routine today.\n[00:00:11.000 --> 00:00:15.000]  I tried the wind-down routine twice this week.\n[00:00:16.000 --> 00:00:20.000]  That is good progress. Let us keep it going.'
          : 'I have not been sleeping well and work stress is high.\nWe talked about my sleep routine today.')
        : (customOut !== undefined ? customOut : 'noise<|im_start|>assistant\n{"subjective":"Client reported poor sleep and high work stress","objective":"Client appeared tired but engaged","assessment":"Stress-related insomnia, mild improvement in coping","plan":"Wind-down routine nightly; review sleep next session"}<|im_end|>\nllama_print_timings: total');
      return { active: false, kind, done: true, progress: 100, output }; }
    case 'ai_proc_cancel': procCancelCount++; aiProc = null; return true;
    case 'open_external': throw new Error('External links are disabled in this app');
    default: throw new Error('unknown command ' + cmd);
  }
};

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); if (!cond) console.error('FAIL:', name); };

(async () => {
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.__TAURI__ = { core: { invoke: fakeInvoke } };
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
      window.URL.createObjectURL = () => 'blob:fake'; window.URL.revokeObjectURL = () => {};
      window.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  await tick(); await tick();
  const flush = async () => { await w.desktopDB.flush(); await tick(); };
  const savedState = () => JSON.parse(workspaceJson);
  const $ = (id) => w.document.getElementById(id);

  check('bridge connected (desktopDB exists)', !!w.desktopDB);
  check('lock screen shows setup for first run', $('setupFields').style.display !== 'none' || $('lockScreen').classList.contains('show'));

  // First-run account creation through the real UI function
  $('setupUsername').value = 'tester';
  $('setupDisplayName').value = 'Test Clinician';
  $('setupPassword').value = 'test-password-123';
  $('setupPassword2').value = 'test-password-123';
  await w.setupFirstUser(); await tick();
  check('account created and lock screen hidden', !$('lockScreen').classList.contains('show'));

  // Client CRUD
  w.openClient();
  $('cName').value = 'Test Client A';
  $('cStatus').value = 'Active';
  $('cNotes').value = 'fictional test client';
  await w.saveClient(); await flush();
  let st = savedState();
  check('client persisted to encrypted-workspace snapshot', st.clients.length === 1 && st.clients[0].name === 'Test Client A');
  check('snapshot keeps backend-required collections', Array.isArray(st.sessions) && Array.isArray(st.events) && Array.isArray(st.tasks));
  check('client list renders', $('clientsTable').innerHTML.includes('Test Client A'));
  const clientId = st.clients[0].id;

  // V1.8.0: builtin template seeding for the new formats (once, never resurrects)
  check('new builtin format templates seeded once', ['girp', 'pirp', 'sirp'].every(f => savedState().templates.some(x => x.format === f && x.builtin)));
  w.eval("db.templates=db.templates.filter(x=>x.format!=='girp')");
  await w.persistWorkspace(); await flush();
  w.seedNoteTemplates(); await flush();
  check('deleted seeded template is not resurrected', !savedState().templates.some(x => x.format === 'girp'));
  // V1.8.0: per-client treatment goals (default format exercised later)
  w.openClient(clientId);
  check('client dialog has goals + default format fields', !!$('cGoals') && !!$('cDefaultFormat'));
  $('cGoals').value = 'Reduce panic episodes and rebuild a regular sleep routine.';
  $('cDefaultFormat').value = '';
  await w.saveClient(); await flush();
  check('client treatment goals persisted', (savedState().clients[0].goals || '').includes('panic episodes'));
  // V1.9.0: recording-consent record lives in the client dialog
  w.openClient(clientId);
  check('client dialog carries the consent record fields', !!$('cConsentStatus') && !!$('cConsentMethod') && !!$('cConsentDate'));
  $('cConsentStatus').value = 'recorded';
  $('cConsentMethod').value = 'written';
  $('cConsentDate').value = '2026-10-29';
  await w.saveClient(); await flush();
  const cc = savedState().clients[0];
  check('consent record persisted on the client', cc.consentStatus === 'recorded' && cc.consentMethod === 'written' && cc.consentDate === '2026-10-29');
  check('clients table shows the recorded-consent pill', $('clientsTable').innerHTML.includes('pill-sage') && $('clientsTable').innerHTML.includes('Consent recorded'));
  w.openClient(clientId);
  check('consent record re-opens populated in the dialog', $('cConsentStatus').value === 'recorded' && $('cConsentMethod').value === 'written' && $('cConsentDate').value === '2026-10-29');
  $('clientDialog').close();

  // Studio controls
  w.showView('studio'); await tick(); await tick();
  check('studio shows downloaded whisper model', $('aiWhisperModel').value === 'small');
  check('transcription language list is full (30+)', $('aiLang').options.length >= 30);
  check('transcription languages include yue + auto + ar', [...$('aiLang').options].some(o => o.value === 'yue') && [...$('aiLang').options].some(o => o.value === 'auto') && [...$('aiLang').options].some(o => o.value === 'ar'));
  check('format selector has SOAP/DAP/BIRP/Narrative', ['soap', 'dap', 'birp', 'narrative'].every(v => [...$('aiFormat').options].some(o => o.value === v)));
  check('format selector also has GIRP/PIRP/SIRP', ['girp', 'pirp', 'sirp'].every(v => [...$('aiFormat').options].some(o => o.value === v)));
  check('output language selector includes es/ja/ko/zh-TW', ['es', 'ja', 'ko', 'zh-TW', 'follow'].every(v => [...$('aiOutLang').options].some(o => o.value === v)));

  // Transcription flow (fake engine)
  w.eval("aiAudioPath='/fake/ai-audio/a1.wav'");
  $('aiClient').value = clientId;
  // Transcription vocabulary (V1.7.0): client name + user terms bias Whisper
  check('vocabulary field + builder exist', !!$('aiVocabulary') && typeof w.buildTranscriptionVocabulary === 'function');
  $('aiVocabulary').value = 'sertraline, melatonin\nSertraline';
  $('aiVocabulary').dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick(650); await flush();
  check('vocabulary persisted in pref store (aiVocabulary)', w.desktopDB.getPref('aiVocabulary') === 'sertraline, melatonin\nSertraline');
  check('effective vocabulary = client name first, terms deduped', w.buildTranscriptionVocabulary() === 'Test Client A, sertraline, melatonin');
  $('aiVocabulary').value = Array.from({ length: 60 }, (_, i) => 'term' + i + 'xxxxxxxxxx').join(', ');
  check('effective vocabulary capped at 400 chars', w.buildTranscriptionVocabulary().length <= 400);
  $('aiVocabulary').value = 'sertraline, melatonin';
  await w.startTranscribe();
  await w.aiPollOnce(); await w.aiPollOnce();
  check('transcript filled from engine output', $('aiTranscript').value.includes('sleeping well'));
  check('transcribe invocation received vocabulary prompt (client name + term)', !!lastTranscribeArgs && typeof lastTranscribeArgs.prompt === 'string' && lastTranscribeArgs.prompt.includes('Test Client A') && lastTranscribeArgs.prompt.includes('sertraline'));
  check('recording discarded after transcription (default on)', aiDiscarded === '/fake/ai-audio/a1.wav');

  // Speaker-segment aids
  w.insertSpeakerMarker('Therapist');
  check('speaker marker inserted', $('aiTranscript').value.includes('Therapist:'));
  w.autoSegmentTranscript();
  check('auto-segment labels speakers', $('aiTranscript').value.includes('Client:') && $('aiTranscript').value.includes('Therapist:'));
  check('relabel function exists', typeof w.relabelCurrentLine === 'function');

  // Custom template / instructions: persists via prefs + highest priority in prompt
  const CUSTOM = 'MY CUSTOM TEMPLATE: always end with a one-line risk check.';
  $('aiCustomTemplate').value = CUSTOM;
  $('aiCustomTemplate').dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick(650); await flush();
  check('custom template persisted in pref store', w.desktopDB.getPref('aiCustomTemplate') === CUSTOM);
  check('custom template status reports saved', $('aiCustomTplStatus').textContent.includes('Saved'));

  // V1.8.0: detail level, treatment goals in prompt, MSE, GIRP/PIRP/SIRP prompts
  check('detail level selector exists, defaulting to Standard', !!$('aiDetail') && $('aiDetail').value === 'standard');
  w.desktopDB.setPref('aiDetailLevel', 'brief');
  check('detail level BRIEF reaches the prompt', w.buildNotePrompt('Client reported poor sleep.', 'brief').includes('Detail level: BRIEF'));
  w.desktopDB.setPref('aiDetailLevel', 'detailed');
  check('detail level DETAILED reaches the prompt', w.buildNotePrompt('Client reported poor sleep.', 'brief').includes('Detail level: DETAILED'));
  w.desktopDB.setPref('aiDetailLevel', 'standard');
  const goalsPrompt = w.buildNotePrompt('Client reported poor sleep.', 'brief');
  check('client treatment goals reach the prompt with the framing instruction', goalsPrompt.includes('Reduce panic episodes and rebuild a regular sleep routine') && goalsPrompt.includes('treatment goals'));
  check('MSE panel + compose exist', !!$('msePanel') && typeof w.composeMse === 'function' && typeof w.mseAllNormal === 'function');
  w.mseAllNormal();
  const mseAll = w.composeMse();
  check('MSE all-normal composes standard wording across domains', mseAll.includes('Appropriately groomed') && mseAll.includes('goal-directed') && mseAll.includes('oriented to person, place, time') && mseAll.includes('No suicidal or homicidal ideation'));
  w.mseToggle('speech', 'Normal rate, rhythm, volume, and articulation; spontaneous and coherent');
  w.mseToggle('speech', 'Pressured speech');
  const mseChanged = w.composeMse();
  check('MSE changed domain overrides the normal descriptor', mseChanged.includes('Pressured speech') && !mseChanged.includes('Normal rate, rhythm'));
  const msePrompt = w.buildNotePrompt('Client reported poor sleep.', 'brief');
  check('composed MSE reaches the generation prompt', msePrompt.includes('MENTAL STATUS EXAM') && msePrompt.includes('Pressured speech'));
  $('aiFormat').value = 'girp';
  const girpPrompt = w.buildNotePrompt('Client worked on a sleep routine.', 'brief');
  check('GIRP prompt specifies goal/intervention/response/plan keys', girpPrompt.includes('"goal"') && girpPrompt.includes('"intervention"') && girpPrompt.includes('"response"') && girpPrompt.includes('"plan"'));
  $('aiFormat').value = 'pirp';
  check('PIRP prompt specifies the problem key', w.buildNotePrompt('Client worked on a sleep routine.', 'brief').includes('"problem"'));
  $('aiFormat').value = 'sirp';
  check('SIRP prompt specifies the situation key', w.buildNotePrompt('Client worked on a sleep routine.', 'brief').includes('"situation"'));
  $('aiFormat').value = 'soap';

  // Generation: output language = Spanish, format = SOAP
  $('aiOutLang').value = 'es';
  $('aiDelTranscript').checked = true;
  await w.generateNote('transcript');
  check('prompt carries the custom template verbatim', lastPrompt.includes(CUSTOM));
  check('prompt frames custom template as highest priority', lastPrompt.includes('highest priority'));
  check('prompt instructs output in chosen language (Español)', lastPrompt.includes('Español'));
  check('prompt specifies SOAP JSON keys', lastPrompt.includes('"subjective"') && lastPrompt.includes('"objective"') && lastPrompt.includes('"plan"'));
  check('prompt is ChatML + JSON-only', lastPrompt.includes('<|im_start|>system') && lastPrompt.includes('JSON'));

  // Clinical language corpus (V1.5.0): modality matching, default, ordering
  check('corpus helper exists', typeof w.corpusGuidance === 'function');
  $('aiOrientation').value = 'CBT';
  const cbtPrompt = w.buildNotePrompt('Therapist: We reviewed the thought record together. Client: The work meeting went better than I expected.', 'transcript');
  check('corpus: CBT orientation prompt carries a CBT frame (Socratic questioning)', cbtPrompt.includes('Socratic questioning'));
  check('corpus: prompt carries the never-add-unsupported-content warning', cbtPrompt.includes('never add interventions, symptoms, risk statements, or progress'));
  check('corpus: block appears before the custom-template block', cbtPrompt.indexOf('CLINICAL LANGUAGE CORPUS') >= 0 && cbtPrompt.indexOf('CLINICAL LANGUAGE CORPUS') < cbtPrompt.indexOf('CUSTOM TEMPLATE'));
  $('aiOrientation').value = '';
  const defaultPrompt = w.buildNotePrompt('Client reported poor sleep and work stress.', 'brief');
  check('corpus: no orientation falls back to supportive frames', defaultPrompt.includes('unconditional positive regard'));

  // Problem-focused corpus + My Phrases (V1.6.0)
  check('matchProblems helper exists', typeof w.matchProblems === 'function');
  check('matchProblems ranks by hit count and caps at 2', JSON.stringify(w.matchProblems('anxiety and worry and more worry, plus panic attacks')) === JSON.stringify(['anxiety', 'panic']));
  const probPrompt = w.buildNotePrompt('Client described constant anxiety and worry at work, and a depressed mood with anhedonia lasting for weeks. We practiced breathing skills today.', 'brief');
  check('problem focus: anxiety frames in prompt', probPrompt.includes('Problem focus') && probPrompt.includes('catastrophic predictions maintaining their anxiety'));
  check('problem focus: depression frames in prompt', probPrompt.includes('behavioral activation, scheduling pleasant and mastery activities'));
  check('problem focus: unrelated problems left out', !probPrompt.includes('exposure and response prevention principles') && !probPrompt.includes('anger triggers and early warning signs'));
  check('problem focus sits inside corpus after modality frames, before response', probPrompt.indexOf('Problem focus') > probPrompt.indexOf('CLINICAL LANGUAGE CORPUS') && probPrompt.indexOf('Problem focus') < probPrompt.indexOf('Client response:'));
  const calmPrompt = w.buildNotePrompt('Client talked about their week, weekend plans, and scheduling for next time.', 'brief');
  check('no keyword hits: no Problem focus subsection', !calmPrompt.includes('Problem focus'));
  await tick();
  check('phrase panel exists in note editor', !!$('phrasePanel'));
  w.togglePhrasePanel();
  check('phrase panel renders My phrases + standard + problem groups', $('phrasePanel').innerHTML.includes('My phrases') && $('phrasePanel').innerHTML.includes('Socratic questioning') && $('phrasePanel').innerHTML.includes('catastrophic predictions maintaining their anxiety'));
  const RELAX = 'Therapist taught the client relaxation and breathing skills to reduce physiological arousal when anxiety escalates.';
  const starBtn = [...w.document.querySelectorAll('#phrasePanel [data-act="star"]')].find(b => b.getAttribute('data-phrase') === RELAX);
  check('star toggle rendered for a corpus phrase', !!starBtn);
  starBtn.click(); await flush();
  check('starring persists phrase to corpusFavorites pref', (JSON.parse(w.desktopDB.getPref('corpusFavorites') || '[]')).includes(RELAX));
  check('favorite appears in My phrases section', $('myPhraseList').innerHTML.includes('relaxation and breathing skills'));
  $('customPhraseInput').value = 'Client smiled for the first time in several weeks.';
  w.addCustomPhrase(); await flush();
  check('custom phrase persists to corpusCustomPhrases pref (V1.15 object shape)', (JSON.parse(w.desktopDB.getPref('corpusCustomPhrases') || '[]')).some(e => (typeof e === 'string' ? e : e.text) === 'Client smiled for the first time in several weeks.'));
  check('custom phrase appears in My phrases section', $('myPhraseList').innerHTML.includes('Client smiled for the first time'));
  const minePrompt = w.buildNotePrompt('Client reported poor sleep and work stress.', 'brief');
  check('prompt carries preferred-phrasing subsection with favorite + custom', minePrompt.includes("Therapist's own preferred phrasing") && minePrompt.includes('relaxation and breathing skills') && minePrompt.includes('Client smiled for the first time in several weeks.'));
  check('preferred phrasing after corpus, before custom template', minePrompt.indexOf("Therapist's own preferred phrasing") > minePrompt.indexOf('CLINICAL LANGUAGE CORPUS') && minePrompt.indexOf("Therapist's own preferred phrasing") < minePrompt.indexOf('CUSTOM TEMPLATE'));
  const noteBox = $('nText');
  noteBox.focus();
  const chip = [...w.document.querySelectorAll('#phrasePanel [data-act="insert"]')].find(b => b.getAttribute('data-phrase') === RELAX);
  const caret = noteBox.value.indexOf('\n') + 1;
  noteBox.setSelectionRange(caret, caret);
  chip.click(); await tick();
  check('phrase click inserts into the single note box at the caret', noteBox.value.slice(caret, caret + 20).includes('Therapist taught') && noteBox.value.includes('relaxation and breathing skills to reduce physiological arousal'));
  check('i18n dictionaries keep EN/ZH key parity', JSON.stringify(Object.keys(w.eval('I18N.en')).sort()) === JSON.stringify(Object.keys(w.eval('I18N.zh')).sort()));
  $('aiOrientation').value = '';
  await tick();
  const subj = $('nText');
  check('generated note lands in ONE text box with section heading lines', subj && subj.value.includes('poor sleep') && subj.value.includes('Subjective (S):') && subj.value.includes('Plan (P):') && w.document.querySelectorAll('#nSections textarea').length === 1);
  check('note editor opened as unsaved draft', $('noteEditorWrap').style.display !== 'none' && savedState().sessions.length === 0);

  // V1.8.0: the composed MSE is offered as a one-click insert into the draft
  check('MSE insert offered for the AI draft', $('mseInsertWrap').style.display !== 'none');
  w.insertMseIntoDraft();
  const boxAfterMse = $('nText').value;
  const mseIdx = boxAfterMse.indexOf('Mental Status Exam:');
  check('MSE insert lands at the end of the Objective section block (SOAP mapping)', mseIdx > boxAfterMse.indexOf('Objective (O):') && mseIdx < boxAfterMse.indexOf('Assessment (A):') && boxAfterMse.includes('Pressured speech'));

  // Verify note (V1.7.0): second-pass faithfulness check over the draft.
  // The fake model distinguishes verification prompts by the marker
  // 'VERIFY NOTE AGAINST SOURCE' and answers with the planted verifyOutput.
  check('verify UI exists', typeof w.verifyNote === 'function' && !!$('verifyBtn') && !!$('verifyPanel'));
  check('verify row shown for the AI draft', $('verifyWrap').style.display !== 'none');
  verifyOutput = 'noise<|im_start|>assistant\n[{"quote":"mild improvement in coping","issue":"The source reports stress and poor sleep but never says coping has improved."}]<|im_end|>\nllama_print_timings: total';
  const assessBefore = $('nText').value;
  await w.verifyNote();
  check('verify prompt carries the verification marker + the draft', lastPrompt.includes('VERIFY NOTE AGAINST SOURCE') && lastPrompt.includes('mild improvement in coping'));
  await w.verifyPollOnce(); await w.verifyPollOnce();
  check('verify panel lists the planted flag (quote + issue)', $('verifyPanel').innerHTML.includes('mild improvement in coping') && $('verifyPanel').innerHTML.includes('never says coping has improved'));
  check('verification leaves the draft text unchanged', $('nText').value === assessBefore && subj.value.includes('poor sleep'));
  const dismissBtn = [...$('verifyPanel').querySelectorAll('button')].find(b => (b.getAttribute('onclick') || '').includes('dismissVerifyFlag'));
  check('flag has a dismiss button', !!dismissBtn);
  dismissBtn.click(); await tick();
  check('dismissing the flag removes it from the panel', !$('verifyPanel').innerHTML.includes('mild improvement in coping'));
  verifyOutput = '[]';
  await w.verifyNote(); await w.verifyPollOnce(); await w.verifyPollOnce();
  check('clean verification shows the success line', $('verifyPanel').innerHTML.includes('No unsupported statements found'));

  // Save the note -> persisted, transcript auto-deleted per option
  await w.saveNote(); await flush();
  st = savedState();
  check('note saved into sessions collection', st.sessions.length === 1 && st.sessions[0].clientId === clientId);
  check('saved note keeps format + output language', st.sessions[0].format === 'soap' && st.sessions[0].outputLanguage === 'es');
  check('saved note section content intact', st.sessions[0].sections.plan.includes('Wind-down routine'));
  check('saved note carries the canonical full text', (st.sessions[0].fullText || '').includes('Subjective (S):') && st.sessions[0].fullText.includes('Wind-down routine'));
  check('saved note legacy text still derived for search/overview/exports', (st.sessions[0].text || '').includes('Wind-down routine'));
  check('transcript auto-deleted after save (option on)', $('aiTranscript').value === '');
  check('notes list renders the saved note', $('notesList').innerHTML.includes('Test Client A'));

  // HIPAA safeguards (V1.1.0): security panel, auto-lock pref, audited export paths
  w.showView('models'); await tick(80); await flush();
  check('security panel shows auto-lock selector', !!$('autoLockSel'));
  check('auto-lock defaults to 10 minutes', $('autoLockSel') && $('autoLockSel').value === '10');
  w.setAutoLock('5');
  check('auto-lock choice persists to prefs', w.desktopDB.getPref('autoLockMinutes') === '5');
  check('admin user list renders with add-user form', $('usersPanel').innerHTML.includes('tester') && $('usersPanel').innerHTML.includes('Add user'));
  check('audit log + verify controls present', !!w.document.querySelector('[onclick="loadAuditLog()"]') && !!w.document.querySelector('[onclick="verifyAuditLog()"]'));
  check('auditNoteAction helper exists', typeof w.auditNoteAction === 'function');
  auditEvents.length = 0;
  w.copyNoteText();
  w.exportNoteText();
  try { w.printCurrentNote(); } catch (_) {}
  await tick(60); await flush();
  check('copying a note is audit-logged', auditEvents.some(e => e.action === 'Copy note'));
  check('plain-text export is audit-logged', auditEvents.some(e => e.action === 'Export note'));
  check('printing a note is audit-logged', auditEvents.some(e => e.action === 'Print note'));

  // Bilingual UI (V1.2.0): detection default, manual switch, persistence, dev credit
  check('UI language defaults to English on an en-US system', w.eval('uiLang') === 'en');
  check('developer credit shows Mind X Associates (EN)', $('devLink') && $('devLink').textContent === 'Mind X Associates' && $('devLink').href === 'https://mind.us/');
  w.toggleUiLang(); await tick(60); await flush();
  check('switching sets uiLang to zh + persists pref', w.eval('uiLang') === 'zh' && w.desktopDB.getPref('uiLang') === 'zh');
  check('nav renders Chinese after switch', w.document.querySelector('[data-i="navClients"]').textContent === '来访者');
  check('clients heading renders Chinese', $('clients').querySelector('[data-i="clientsTitle"]').textContent === '来访者');
  check('html lang attribute switches to zh-CN', w.document.documentElement.lang === 'zh-CN');
  check('developer credit switches to Mind X社区 + /zh URL', $('devLink').textContent === 'Mind X社区' && $('devLink').href === 'https://mind.us/zh');
  check('notes table headers render Chinese', $('notesList').innerHTML.includes('日期') && $('notesList').innerHTML.includes('来访者'));
  check('security panel renders Chinese', $('models').innerHTML.includes('安全与 HIPAA 保障'));
  check('note editor buttons render Chinese', w.document.querySelector('[data-i="saveNote"]').textContent === '保存记录' && w.document.querySelector('[data-i="copyNote"]').textContent === '复制' && w.document.querySelector('[data-i="printNote"]').textContent === '打印 / PDF');
  w.toggleUiLang(); await tick(60); await flush();
  check('switching back restores English + pref', w.eval('uiLang') === 'en' && w.desktopDB.getPref('uiLang') === 'en' && w.document.querySelector('[data-i="navClients"]').textContent === 'Clients');

  // Telehealth recording (V1.3.0): source modes + device picker
  check('recording source selector exists (mic default)', !!$('aiRecSource') && $('aiRecSource').value === 'mic');
  check('audio device picker exists with default option', !!$('aiAudioDevice') && $('aiAudioDevice').options.length >= 1);
  $('aiRecSource').value = 'tele'; w.onRecSourceChange();
  check('telehealth source persists + hint explains screen sharing', w.desktopDB.getPref('aiRecSource') === 'tele' && $('aiRecHint').textContent.includes('Entire screen'));
  await w.refreshAudioDevices(false);
  check('device refresh survives missing mediaDevices', $('aiAudioDevice').options.length >= 1);
  $('aiConsent').checked = false;
  await w.startRecording();
  check('recording gate: without consent, recording does not start', w.eval('recState') === null);
  $('aiConsent').checked = true;
  await w.startRecording();
  check('telehealth start without system-audio support alerts and does not record', w.eval('recState') === null);
  $('aiRecSource').value = 'mic'; w.onRecSourceChange();
  check('source switches back to microphone', w.desktopDB.getPref('aiRecSource') === 'mic');

  // Android adaptations (V1.4.0): bundled engines, telehealth source disabled
  const origAiStatus = w.desktopDB.aiStatus;
  w.desktopDB.aiStatus = async () => ({ os: 'android', whisper: { found: true, path: '/data/app/lib/libwhisper-cli.so' }, llama: { found: true, path: '/data/app/lib/libllama-cli.so' }, models: [], modelsDir: '/data/models', download: null, proc: null });
  await w.refreshAiStatus(); await tick(40);
  check('android: telehealth source option disabled', $('aiRecSource').querySelector('option[value="tele"]').disabled === true);
  check('android: hint explains telehealth unavailable', $('aiRecHint').textContent.includes('not available on Android'));
  w.showView('models'); await tick(60); await flush();
  check('android: models view shows bundled-engines note', $('modelsBody').innerHTML.includes('built into the app'));
  check('android: no engine download buttons offered', !$('modelsBody').innerHTML.includes('Download engine'));
  w.desktopDB.aiStatus = origAiStatus;
  w.eval("window.__murmurOs=''");
  $('aiRecSource').querySelector('option[value="tele"]').disabled = false;
  await w.refreshAiStatus(); await tick(40);
  check('desktop state restored after android simulation (llm model selectable)', !!$('aiLlmModel').value);

  // Brief-summary mode also generates (and also carries the custom template)
  w.showView('studio');
  $('aiBrief').value = 'Client reports work stress and two weeks of poor sleep.';
  lastPrompt = '';
  await w.generateNote('brief');
  check('brief mode prompt also carries custom template verbatim', lastPrompt.includes(CUSTOM));
  await w.aiPollOnce(); await w.aiPollOnce();
  await w.saveNote(); await flush();
  check('brief-generated note saved as second note', savedState().sessions.length === 2);

  // Manual note + format switch in the editor
  w.openNote();
  check('manual note editor opens as ONE document with SOAP headings', $('nText').value.includes('Subjective (S):') && $('nText').value.includes('Plan (P):'));
  $('nFormat').value = 'dap'; w.changeNoteFormat();
  check('switching format re-composes the document with DAP headings', $('nText').value.includes('Data (D):') && !$('nText').value.includes('Subjective (S):'));
  $('nFormat').value = 'girp'; w.changeNoteFormat();
  check('switching format re-composes GIRP headings', $('nText').value.includes('Goal (G):') && $('nText').value.includes('Intervention (I):') && $('nText').value.includes('Response (R):'));
  $('nFormat').value = 'pirp'; w.changeNoteFormat();
  check('switching format re-composes PIRP headings', $('nText').value.includes('Problem (P):'));
  $('nFormat').value = 'sirp'; w.changeNoteFormat();
  check('switching format re-composes SIRP headings', $('nText').value.includes('Situation (S):'));
  w.closeNoteEditor();

  // Consent (V1.9.0): no standalone tab; the form lives in a Studio-opened dialog,
  // the per-client record lives in the client dialog.
  check('nav has exactly five views and no consent tab', w.document.querySelectorAll('nav button[data-view]').length === 5 && !w.document.querySelector('nav button[data-view="consent"]') && !$('consent'));
  w.openConsentForm();
  check('consent form opens from Studio into its dialog', $('consentDialog').open === true && $('consentBody').innerHTML.includes('Informed Consent') && $('consentBody').innerHTML.includes('Client signature'));
  w.setConsentLang('zh');
  check('consent form dialog switches to the Chinese form', $('consentBody').innerHTML.includes('来访者签字'));
  w.setConsentLang('en');
  check('consentHtml zh version exists', w.consentHtml('zh').includes('知情同意') && w.consentHtml('zh').includes('来访者签字'));
  check('consent states fully local / offline handling', w.consentHtml('en').includes('fully local, offline'));
  $('consentDialog').close();

  // Models view renders engine + turbo model row
  w.showView('models'); await tick();
  check('models view lists large-v3-turbo', $('modelsBody').innerHTML.includes('ggml-large-v3-turbo.bin'));
  check('models view shows ready small + qwen3', $('modelsBody').innerHTML.includes('ggml-small.bin') && $('modelsBody').innerHTML.includes('qwen2.5-3b'));

  // Standing rules: no third-party product names in the UI, no localStorage business data
  check('no borrowed-product names appear in UI/docs strings', !new RegExp(['Confi','dant'].join('') + '|' + ['Open','Evidence'].join(''), 'i').test(html));
  check('no localStorage used', !/localStorage/.test(html));
  const rustSrc = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
  check('rust: transcribe_start accepts an optional prompt parameter', /fn transcribe_start\([^)]*prompt: Option<String>/.test(rustSrc));
  check('rust: whisper-cli invocation passes --prompt when a vocabulary is present', rustSrc.includes('arg("--prompt")'));
  check('design tokens: warm cream background variable', html.includes('--bg:#f6f3ec'));
  check('design tokens: portal teal accent variable', html.includes('--accent:#4a778b'));
  check('design tokens: teal dark + deep variables', html.includes('--accent-dark:#355564') && html.includes('--accent-deep:#132228'));
  check('design tokens: serif display stack variable', html.includes('--font-display:Georgia'));
  check('rust: deprecated whisper main binary is not a candidate', !rustSrc.includes('"main.exe"') && !rustSrc.includes('"main"'));
  check('rust: whisper-cli.exe is the Windows whisper candidate', rustSrc.includes('&["whisper-cli.exe"]'));
  check('rust: engine search honors strict candidate priority', rustSrc.includes('for name in names'));
  check('version V1.18.0 in UI', html.includes('Desktop V1.18.0'));

  // ================= V1.17.0: renamed Murmur -> Auris (display name only) =================
  const confJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const cargoToml = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoLock = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'Cargo.lock'), 'utf8');
  const changelogMd = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  check('V1.17 product name + window title are Auris', confJson.productName === 'Auris' && confJson.app.windows[0].title === 'Auris');
  check('V1.17 bundle identifier unchanged (data continuity)', confJson.identifier === 'us.mindx.murmur');
  check('V1.18 config version is 1.18.0', confJson.version === '1.18.0');
  check('V1.17 cargo package + lib names unchanged', /^name = "murmur"$/m.test(cargoToml) && cargoToml.includes('name = "murmur_lib"') && cargoLock.includes('name = "murmur"'));
  check('V1.17 db filename + portable env + verifier domain unchanged', rustSrc.includes('murmur.db') && rustSrc.includes('MURMUR_PORTABLE') && rustSrc.includes('murmur-access-v1'));
  check('V1.17 no user-visible Murmur left in the UI file', !html.includes('Murmur'));
  check('V1.17 internal __murmurOs hook kept', html.includes('__murmurOs'));
  check('V1.17 rendered brand is Auris', w.document.title === 'Auris' && w.document.querySelector('header h1').textContent === 'Auris');
  check('V1.17 nav version shows Auris + Desktop V1.18.0', w.document.querySelector('.nav-version').textContent.includes('Auris') && w.document.querySelector('.nav-version').textContent.includes('Desktop V1.18.0'));
  check('V1.17 changelog carries the rename entry', changelogMd.includes('now called Auris'));

  // V1.8.0: client default format preselects in the Studio
  w.openClient(clientId);
  $('cDefaultFormat').value = 'dap';
  await w.saveClient(); await flush();
  check('client default format persisted', savedState().clients[0].defaultFormat === 'dap');
  w.showView('studio');
  $('aiClient').value = clientId; w.applyClientDefaults();
  check('studio preselects the client default format', $('aiFormat').value === 'dap');
  $('aiFormat').value = 'soap';
  w.openClient(clientId); $('cDefaultFormat').value = ''; await w.saveClient(); await flush();

  // V1.8.0: Home queue — lifecycle (add on transcription, dedupe, reload, save removes)
  check('queue helpers exist', typeof w.getPendingNotes === 'function' && typeof w.writeAllQueue === 'function' && !!$('queueList'));
  w.getPendingNotes().slice().forEach(p => w.removePendingNote(p.id)); await flush();
  check('queue remove action empties the queue', w.getPendingNotes().length === 0);
  check('empty queue: headline is the caught-up line and the nav badge hides', $('homeHeadline').textContent === 'All caught up.' && $('navQueueBadge').hidden === true && $('homeDate').textContent.length > 0);
  w.showView('home'); await tick();
  check('home queue empty state explains the queue', $('queueList').innerHTML.includes('Nothing waiting'));
  w.showView('studio');
  w.eval("aiAudioPath='/fake/ai-audio/a1.wav'");
  $('aiClient').value = clientId;
  await w.startTranscribe(); await w.aiPollOnce(); await w.aiPollOnce();
  check('completed transcription adds a pending queue item', w.getPendingNotes().length === 1 && w.getPendingNotes()[0].kind === 'transcript');
  const qItem = w.getPendingNotes()[0];
  check('queue add dedupes identical client+source', w.addPendingNote(clientId, 'transcript', qItem.source, qItem.date) === qItem.id && w.getPendingNotes().length === 1);
  await flush();
  w.eval('pendingQueue=null'); w.renderHome();
  check('queue survives a simulated reload (pref store)', w.getPendingNotes().length === 1 && $('queueList').innerHTML.includes('Test Client A'));
  const sessionsBefore = savedState().sessions.length;
  await w.writeNoteFromQueue(qItem.id); await tick();
  check('queue Write note opens the draft editor', $('noteEditorWrap').style.display !== 'none');
  await w.saveNote(); await flush();
  check('saving the queued note removes its queue item', w.getPendingNotes().length === 0 && savedState().sessions.length === sessionsBefore + 1);
  // Write all: two queued items generate in order; drafts step through on save
  w.addPendingNote(clientId, 'brief', 'Brief one: client reported anxiety about an upcoming work review.', '2026-10-29');
  w.addPendingNote(clientId, 'transcript', 'Transcript two: client discussed poor sleep and stress at length.', '2026-10-29');
  await flush();
  check('two items queued for Write all', w.getPendingNotes().length === 2);
  check('nav badge + headline + Write all count the queue', $('navQueueBadge').textContent === '2' && $('navQueueBadge').hidden === false && $('homeHeadline').textContent === '2 notes to write.' && $('writeAllBtn').textContent === 'Write all 2');
  await w.writeAllQueue(); await tick();
  check('Write all generates drafts and opens the first', $('noteEditorWrap').style.display !== 'none' && w.eval('writeAllDrafts').length === 1);
  await w.saveNote(); await flush();
  check('saving draft 1 removes its item and opens draft 2', w.getPendingNotes().length === 1 && $('noteEditorWrap').style.display !== 'none');
  await w.saveNote(); await flush();
  check('saving draft 2 empties the queue', w.getPendingNotes().length === 0 && savedState().sessions.length === sessionsBefore + 3);

  // V1.8.0: global search over saved notes + pending queue
  $('globalSearch').value = 'sleep'; w.renderSearch();
  check('search finds a term in a saved note with highlighting', $('searchResults').innerHTML.includes('<mark>sleep</mark>') && $('searchResults').innerHTML.includes('Test Client A'));
  w.addPendingNote(clientId, 'brief', 'Client mentioned insomnia and early waking.', '2026-10-29'); await flush();
  $('globalSearch').value = 'insomnia'; w.renderSearch();
  check('search finds a pending queue item, labeled pending', $('searchResults').innerHTML.includes('<mark>insomnia</mark>') && $('searchResults').innerHTML.includes('Pending'));
  $('globalSearch').value = ''; w.renderSearch();

  // V1.8.0: dictation into the brief box (post-recording transcription step)
  check('dictate button exists in Mode 2', !!$('dictateBtn') && typeof w.startDictation === 'function' && typeof w.startTranscribeTo === 'function');
  w.eval("aiAudioPath='/fake/ai-audio/a1.wav'");
  $('aiBrief').value = '';
  await w.startTranscribeTo('brief'); await w.aiPollOnce(); await w.aiPollOnce();
  check('dictation transcription lands in the brief box', $('aiBrief').value.includes('sleeping well'));
  check('dictation target resets to transcript afterwards', w.eval('transcribeTarget') === 'transcript');
  check('dictation transcription does not add a queue item', w.getPendingNotes().length === 1);
  w.getPendingNotes().slice().forEach(p => w.removePendingNote(p.id)); await flush();


  // V1.10.0: client workspace — four cards, diagnosis without any AI hook
  w.openClientWorkspace(clientId); await tick();
  check('workspace opens with overview/diagnosis/goals/sessions cards', !!$('wsOverviewCard') && !!$('wsDiagnosisCard') && !!$('wsGoalsCard') && !!$('wsSessionsCard'));
  check('workspace replaces the clients table', $('clientsTableWrap').style.display === 'none' && $('clientWorkspace').style.display !== 'none');
  check('diagnosis card carries no AI/generation hook', ![...$('wsDiagnosisCard').querySelectorAll('[onclick]')].some(el => /generate|prompt|overview/i.test(el.getAttribute('onclick') || '')));
  $('wsDxCode').value = 'F41.1'; $('wsDxDesc').value = 'Generalized anxiety disorder';
  await w.wsSaveDiagnosis(); await flush();
  check('diagnosis add persists on the client record', (savedState().clients.find(c => c.id === clientId).diagnoses || []).some(d => d.code === 'F41.1'));
  check('diagnosis renders in the workspace list', $('wsDxList').innerHTML.includes('F41.1'));
  w.wsEditDiagnosis(0); $('wsDxDesc').value = 'Generalized anxiety disorder, chronic';
  await w.wsSaveDiagnosis(); await flush();
  check('diagnosis edit persists', savedState().clients.find(c => c.id === clientId).diagnoses[0].description.includes('chronic'));

  // V1.10.0: pronouns + per-client instructions (override the global template)
  w.openClient(clientId);
  $('cPronouns').value = 'she/her'; $('cInstructions').value = 'CLIENT OVERRIDE MARKER: always write in the first person.';
  await w.saveClient(); await flush();
  const cliRec = savedState().clients.find(c => c.id === clientId);
  check('pronouns + per-client instructions persist on the client', cliRec.pronouns === 'she/her' && (cliRec.customInstructions || '').includes('CLIENT OVERRIDE MARKER'));
  w.openClientWorkspace(clientId); await tick();
  check('workspace header shows pronouns', $('wsMeta').innerHTML.includes('she/her'));
  const ovPrompt = w.buildNotePrompt('Client reported poor sleep.', 'brief');
  check('per-client instructions override the global template in the prompt', ovPrompt.includes('CLIENT OVERRIDE MARKER') && !ovPrompt.includes(CUSTOM));
  w.openClient(clientId); $('cInstructions').value = ''; await w.saveClient(); await flush();

  // V1.10.0: quote level, session instructions, example-note exemplar
  check('segmented controls render for format/detail/quote/session-type/modality', !!w.document.querySelector('.seg[data-seg="format"]') && !!w.document.querySelector('.seg[data-seg="detail"]') && !!w.document.querySelector('.seg[data-seg="quote"]') && !!w.document.querySelector('.seg[data-seg="sessionType"]') && !!w.document.querySelector('.seg[data-seg="modality"]'));
  w.setQuoteLevel('many');
  check('quote level persists as a pref', w.desktopDB.getPref('aiQuoteLevel') === 'many' && w.buildNotePrompt('Client said things are falling apart.', 'brief').includes('Direct quotes: MANY'));
  w.setQuoteLevel('none');
  check('quote level NONE reaches the prompt', w.buildNotePrompt('Client talked.', 'brief').includes('Direct quotes: NONE'));
  w.setQuoteLevel('some');
  $('setExampleNote').value = 'EXAMPLE VOICE MARKER: short, plain sentences.';
  $('setExampleNote').dispatchEvent(new w.Event('input')); await tick(800); await flush();
  check('example note persists to the pref store', (w.desktopDB.getPref('aiExampleNote') || '').includes('EXAMPLE VOICE MARKER'));
  const exPrompt = w.buildNotePrompt('Client reported poor sleep.', 'brief');
  check('example note reaches the prompt as a style exemplar (style only, never content)', exPrompt.includes('STYLE EXEMPLAR') && exPrompt.includes('EXAMPLE VOICE MARKER') && exPrompt.includes('do NOT copy its content'));

  // V1.10.0: session instructions are one-shot; generation lands in the review list
  w.showView('studio');
  $('aiClient').value = clientId;
  $('aiSessionInstructions').value = 'Focus on the sleep discussion only.';
  $('aiBrief').value = 'Client discussed sleep and work stress at length today.';
  lastPrompt = '';
  await w.generateNote('brief');
  check('session-specific instructions reach the prompt', lastPrompt.includes('SESSION-SPECIFIC INSTRUCTIONS') && lastPrompt.includes('Focus on the sleep discussion only.'));
  check('session instructions field clears after generation', $('aiSessionInstructions').value === '');
  await w.aiPollOnce(); await w.aiPollOnce(); await tick();
  check('generated draft lands in the review list', w.getReviewDrafts().length === 1);
  w.renderHome();
  check('home headline counts the review draft', $('homeHeadline').textContent.includes('1 to review.'));
  check('review list renders the draft', $('reviewList').innerHTML.includes('Test Client A'));
  await w.saveNote(); await flush();
  check('saving the draft removes it from the review list', w.getReviewDrafts().length === 0);
  const rid = w.addReviewDraft({ clientId, date: '2026-10-29', format: 'soap', sections: { subjective: 'Marker draft text' }, source: 'src', sourceKind: 'brief' });
  w.eval('reviewDraftsCache=null');
  check('review drafts survive a simulated reload (pref store)', w.getReviewDrafts().length === 1 && $('reviewList').innerHTML.includes('Marker draft text'));
  w.discardReviewDraft(rid); await flush();
  check('discarding removes the review draft', w.getReviewDrafts().length === 0);

  // V1.10.0: home filter tabs
  w.setHomeFilter('review');
  check('home filter To review hides the queue card only', $('queueCard').style.display === 'none' && $('reviewCard').style.display !== 'none');
  w.setHomeFilter('all');
  check('home filter All shows both cards', $('queueCard').style.display !== 'none' && $('reviewCard').style.display !== 'none');

  // V1.10.0: session details round-trip Studio -> note -> Details tab
  w.segPick('sessionType', 'couples'); w.segPick('modality', 'telehealth');
  $('aiStartTime').value = '14:00'; $('aiEndTime').value = '14:50';
  const detNow = w.getSessionDetails();
  check('session details captured from the Studio controls', detNow.sessionType === 'couples' && detNow.modality === 'telehealth' && detNow.startTime === '14:00' && detNow.endTime === '14:50');
  $('aiBrief').value = 'Couples session: partners discussed communication patterns and sleep.';
  lastPrompt = '';
  await w.generateNote('brief');
  await w.aiPollOnce(); await w.aiPollOnce(); await tick();
  check('details tab shows session type + modality + time', $('panelDetails').innerHTML.includes('Couples') && $('panelDetails').innerHTML.includes('Telehealth') && $('panelDetails').innerHTML.includes('14:00'));
  await w.saveNote(); await flush();
  const savedDet = savedState().sessions[savedState().sessions.length - 1];
  check('session details persist on the saved note', savedDet.sessionType === 'couples' && savedDet.modality === 'telehealth' && savedDet.startTime === '14:00' && savedDet.endTime === '14:50');
  check('saved note retains its source text (transcript tab + search)', (savedDet.sourceText || '').includes('communication patterns'));
  check('transcript tab shows the retained source', $('panelTranscript').value.includes('communication patterns'));

  // V1.10.0: brief word counter
  $('aiBrief').value = 'one two three four five'; w.updateBriefWordCount();
  check('brief word counter counts words live', $('briefWordCount').textContent.includes('5'));
  $('aiBrief').value = ''; w.updateBriefWordCount();
  check('brief word counter resets', $('briefWordCount').textContent.includes('0'));

  // V1.10.0: MSE insert targets Problem for PIRP (SOAP -> Objective covered above)
  w.eval("lastGenMse='MSE marker paragraph.'");
  w.openNote(); $('nFormat').value = 'pirp'; w.changeNoteFormat();
  w.insertMseIntoDraft();
  const pirpBox = $('nText').value; const pmIdx = pirpBox.indexOf('MSE marker paragraph.');
  check('MSE insert lands in the Problem section for PIRP', pmIdx > pirpBox.indexOf('Problem (P):') && pmIdx < pirpBox.indexOf('Intervention (I):'));
  w.closeNoteEditor();

  // V1.10.0: finalize locks the note, steps reflect it, unlock restores
  w.openNote(savedDet.id); await tick();
  check('steps indicator has no Finalized fill before finalize', !$('noteSteps').querySelector('.step.fin'));
  await w.finalizeCurrentNote(); await flush(); await tick(300);
  check('finalize persists the finalized status', savedState().sessions.find(x => x.id === savedDet.id).status === 'finalized');
  check('finalized note locks the single text box read-only', $('nText').readOnly === true);
  check('steps indicator marks Finalized after finalize', !!$('noteSteps').querySelector('.step.fin'));
  await w.unlockCurrentNote(); await flush();
  check('unlock restores editing and draft status', $('nText').readOnly === false && savedState().sessions.find(x => x.id === savedDet.id).status === 'draft');
  w.closeNoteEditor();

  // V1.10.0: case overview generation reads finalized notes only
  const dbRef = w.eval('db');
  dbRef.sessions.push({ id: 'ov-fin', clientId, date: '2026-10-20', format: 'soap', outputLanguage: 'follow', sections: { subjective: 'FINALIZED MARKER zqx' }, text: 'FINALIZED MARKER zqx', status: 'finalized', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' });
  dbRef.sessions.push({ id: 'ov-draft', clientId, date: '2026-10-21', format: 'soap', outputLanguage: 'follow', sections: { subjective: 'DRAFT MARKER wkv' }, text: 'DRAFT MARKER wkv', status: 'draft', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' });
  lastPrompt = '';
  await w.generateCaseOverview(clientId); await flush();
  check('case overview prompt includes the finalized note marker', lastPrompt.includes('FINALIZED MARKER zqx'));
  check('case overview prompt excludes the draft note marker', !lastPrompt.includes('DRAFT MARKER wkv'));
  check('case overview is stored on the client record with a timestamp', typeof savedState().clients.find(c => c.id === clientId).caseOverview === 'string' && !!savedState().clients.find(c => c.id === clientId).caseOverviewAt);

  // V1.10.0: recording auto-stop safety net
  w.setAutoStopPref('45');
  check('auto-stop pref persists and the timer helper exists', w.desktopDB.getPref('aiAutoStopMinutes') === '45' && w.getAutoStopMinutes() === 45 && typeof w.scheduleAutoStop === 'function');
  w.setAutoStopPref('0');
  check('auto-stop off reads back as 0', w.getAutoStopMinutes() === 0);
  w.closeClientWorkspace();
  check('clients table is accessible again after leaving the workspace', $('clientsTableWrap').style.display !== 'none');


  // V1.11.0: onboarding wizard — opens on fresh state; a plain close leaves the pref unset and the banner up
  check('V1.11 onboarding wizard opens on fresh state', w.eval('obOpen') === true && w.document.getElementById('onboardingOverlay').style.display === 'flex');
  check('V1.11 onboardingDone unset on fresh state', w.desktopDB.getPref('onboardingDone') === null);
  check('V1.11 setup banner visible during onboarding', w.document.getElementById('setupBanner').style.display !== 'none');
  w.closeOnboarding(false);
  check('V1.11 plain close leaves onboardingDone unset', w.desktopDB.getPref('onboardingDone') === null && w.eval('obOpen') === false);
  check('V1.11 banner stays after plain close (skip path intact)', w.document.getElementById('setupBanner').style.display !== 'none');
  w.openOnboarding();
  check('V1.11 wizard reopens', w.eval('obOpen') === true && w.eval('obStep') === 0);

  // V1.11.0: step 2 (note style) writes the same prefs as the Settings equivalents
  w.eval('obStep = 1'); w.renderObStep();
  w.segPick('format', 'dap');
  check('V1.11 wizard format drives the same Studio control (no separate pref exists)', w.document.getElementById('aiFormat').value === 'dap');
  w.segPick('detail', 'brief');
  check('V1.11 wizard detail writes aiDetailLevel', w.desktopDB.getPref('aiDetailLevel') === 'brief');
  w.segPick('quote', 'many');
  check('V1.11 wizard quote writes aiQuoteLevel', w.desktopDB.getPref('aiQuoteLevel') === 'many');
  const obTpl = w.document.getElementById('obCustomTpl'); obTpl.value = 'Wizard instruction text'; w.obCustomTplInput(obTpl);
  check('V1.11 wizard custom instructions write aiCustomTemplate + mirror the Studio field', w.desktopDB.getPref('aiCustomTemplate') === 'Wizard instruction text' && w.document.getElementById('aiCustomTemplate').value === 'Wizard instruction text');
  w.segPick('format', 'soap');

  // V1.11.0: step 3 (recording) writes the same prefs as the Studio equivalents
  w.eval('obStep = 2'); w.renderObStep();
  const obSrc = w.document.getElementById('obRecSource'); obSrc.value = 'tele'; w.obRecSourceChange(obSrc);
  check('V1.11 wizard recording source writes aiRecSource', w.desktopDB.getPref('aiRecSource') === 'tele' && w.document.getElementById('aiRecSource').value === 'tele');
  obSrc.value = 'mic'; w.obRecSourceChange(obSrc);
  const obStop = w.document.getElementById('obAutoStop'); obStop.value = '60'; w.obAutoStopChange(obStop);
  check('V1.11 wizard auto-stop writes aiAutoStopMinutes', w.desktopDB.getPref('aiAutoStopMinutes') === '60' && w.getAutoStopMinutes() === 60);
  obStop.value = '0'; w.obAutoStopChange(obStop);
  const obDel = w.document.getElementById('obDelAudio'); obDel.checked = false; w.obDelAudioChange(obDel);
  check('V1.11 wizard audio retention writes aiDelAudio + Studio checkbox', w.desktopDB.getPref('aiDelAudio') === '0' && w.document.getElementById('aiDelAudio').checked === false);
  obDel.checked = true; w.obDelAudioChange(obDel);
  check('V1.11 audio retention restores to on', w.desktopDB.getPref('aiDelAudio') === '1' && w.getDelAudioPref() === true);

  // V1.11.0: step 4 (models) reflects engine status; RAM guidance labels + device hint live in Models & Settings
  w.eval('obStep = 3'); w.renderObStep();
  check('V1.11 wizard models step shows ready status', w.document.getElementById('obModelsStatus').textContent.includes('ready on this device'));
  w.showView('models'); await w.desktopDB.flush(); await tick(30);
  const mb = w.document.getElementById('modelsBody').innerHTML;
  check('V1.11 both model guidance labels render', mb.includes('Recommended for 16 GB or more') && mb.includes('Better for 8 GB machines'));
  check('V1.11 device hint line renders', !!w.document.getElementById('modelDeviceHint'));
  Object.defineProperty(w.navigator, 'deviceMemory', { value: 8, configurable: true });
  check('V1.11 deviceMemory 8 recommends the larger tier', w.recommendedLlmTier() === 'pro');
  Object.defineProperty(w.navigator, 'deviceMemory', { value: 4, configurable: true });
  check('V1.11 deviceMemory 4 recommends the lighter tier', w.recommendedLlmTier() === 'lite');
  delete w.navigator.deviceMemory;
  check('V1.11 no deviceMemory signal means no tier', w.recommendedLlmTier() === '');
  const tierList = [{ id: 'qwen15', tier: 'lite' }, { id: 'qwen3', tier: 'pro' }];
  check('V1.11 preselect follows the tier on first choice', w.pickPreselectModel(tierList, '', '', 'pro') === 'qwen3');
  check('V1.11 preselect never overrides a saved model', w.pickPreselectModel(tierList, '', 'qwen15', 'pro') === 'qwen15');
  check('V1.11 preselect never overrides the current selection', w.pickPreselectModel(tierList, 'qwen15', 'qwen3', 'pro') === 'qwen15');

  // V1.11.0: step 5 creates a real client through saveClient
  w.eval('obStep = 4'); w.renderObStep();
  w.document.getElementById('obClientName').value = 'Wizard Client';
  w.document.getElementById('obClientPronouns').value = 'they/them';
  await w.obAddClient(); await w.desktopDB.flush();
  const wizClient = savedState().clients.find(c => c.name === 'Wizard Client');
  check('V1.11 wizard client created via saveClient', !!wizClient && wizClient.pronouns === 'they/them');

  // V1.11.0: step 6 — sample client created once, brief loads, generation runs the real path
  w.eval('obStep = 5'); w.renderObStep();
  const sample1 = await w.ensureSampleClient(); await w.desktopDB.flush();
  const sample2 = await w.ensureSampleClient(); await w.desktopDB.flush();
  const demoRows = savedState().clients.filter(c => c.name === 'Sample Client — Demo');
  check('V1.11 sample client created exactly once', sample1 && sample2 && sample1.id === sample2.id && demoRows.length === 1);
  w.loadSampleIntoStudio(sample1);
  check('V1.11 sample brief loaded in Studio brief mode', w.document.getElementById('aiClient').value === sample1.id && w.document.getElementById('aiBrief').value.includes('fictional'));
  check('V1.11 sample generation branch = generate (fake model present)', w.sampleGenerateBranch() === 'generate');
  const reviewBefore = w.getReviewDrafts().length;
  await w.obGenerateSample(); await w.desktopDB.flush(); await tick(30);
  w.aiPollOnce(); await tick(30); w.aiPollOnce(); await tick(30); await w.desktopDB.flush();
  check('V1.11 sample note drafted through the real generation path', w.getReviewDrafts().length === reviewBefore + 1 && w.document.getElementById('noteEditorWrap').style.display !== 'none');
  check('V1.11 finishing the sample marks onboarding done + hides banner', w.desktopDB.getPref('onboardingDone') === '1' && w.document.getElementById('setupBanner').style.display === 'none');
  w.maybeOpenOnboarding();
  check('V1.11 wizard stays closed once onboardingDone is set', w.eval('obOpen') === false);
  w.closeNoteEditor();
  await w.deleteClientForever(wizClient.id); await w.desktopDB.flush();
  await w.deleteClientForever(sample1.id); await w.desktopDB.flush();
  check('V1.11 wizard + sample clients deletable (cleanup path)', savedState().clients.filter(c => c.name === 'Wizard Client' || c.name === 'Sample Client — Demo').length === 0);


  // V1.12.0: speaker separation + therapist voice enrollment
  w.showView('models'); await tick();
  check('V1.12 models: speaker separation engine row rendered', $('modelsBody').innerHTML.includes('Speaker separation engine'));
  check('V1.12 models: both speaker model files listed', $('modelsBody').innerHTML.includes('diarize-segmentation.onnx') && $('modelsBody').innerHTML.includes('diarize-embedding.onnx'));
  check('V1.12 enrollment card exists with a record action', !!$('voiceCard') && $('voiceBody').innerHTML.includes('Record voice sample'));
  await w.saveEnrollmentWav(new w.Uint8Array([82, 73, 70, 70]), 28); await tick();
  check('V1.12 enrollment stores the wav path + duration prefs', w.desktopDB.getPref('aiVoicePath') === '/fake/ai-audio/a1.wav' && w.desktopDB.getPref('aiVoiceDur') === '28');
  w.renderVoiceCard();
  check('V1.12 enrollment card shows enrolled state + duration', $('voiceBody').innerHTML.includes('Voice sample saved') && $('voiceBody').innerHTML.includes('28'));
  // Studio flow WITH enrollment: the enrolled cluster becomes Therapist
  w.showView('studio'); await tick();
  $('aiClient').value = clientId;
  const diaQ = w.addPendingNote(clientId, 'transcript', 'placeholder', '2026-10-30');
  w.eval("aiAudioPath='/fake/ai-audio/a1.wav';diarizeData=null;studioSessionType='individual'");
  $('aiTranscript').value = 'placeholder';
  discardLog.length = 0;
  await w.startDiarizeFlow(); await tick();
  for (let i = 0; i < 8 && !w.eval('diarizeData'); i++) { await w.aiPollOnce(); await tick(40); }
  check('V1.12 diarize stage 1 requested timestamped transcription', !!lastTranscribeArgs && lastTranscribeArgs.timestamps === true);
  check('V1.12 diarize_start received enrollment path + known speaker count', !!lastDiarizeArgs && lastDiarizeArgs.enrollPath === '/fake/ai-audio/a1.wav' && lastDiarizeArgs.numSpeakers === 2);
  const labeled = $('aiTranscript').value;
  check('V1.12 enrolled cluster labeled Therapist, other labeled Client', labeled.includes('Therapist: I have not been sleeping well') && labeled.includes('Client: We talked about your sleep routine today.'));
  check('V1.12 pending queue source updated to the labeled transcript', (w.getPendingNotes().find(p => p.id === diaQ) || {}).source === labeled);
  check('V1.12 combined enrollment+session temp wav discarded after the run', discardLog.includes('/fake/ai-audio/diarize-combined.wav'));
  check('V1.12 deferred delete-after-transcription still honored after diarization', w.eval('aiAudioPath') === '' && discardLog.includes('/fake/ai-audio/a1.wav'));
  await w.generateNote('transcript'); await tick();
  check('V1.12 labeled transcript reaches the generation prompt', lastPrompt.includes('Therapist: I have not been sleeping well') && lastPrompt.includes('Client: We talked about your sleep routine today.'));
  w.toggleDiarizeOriginal();
  check('V1.12 original toggle restores the unlabeled transcript', $('aiTranscript').value === 'placeholder');
  w.toggleDiarizeOriginal();
  check('V1.12 toggle back restores the labeled transcript', $('aiTranscript').value === labeled);
  // Enrollment removed: generic Speaker labels + "This is me" correction
  await w.deleteEnrollment(); await tick();
  check('V1.12 enrollment delete clears the prefs', !w.desktopDB.getPref('aiVoicePath') && !w.desktopDB.getPref('aiVoiceDur'));
  w.eval("aiAudioPath='/fake/ai-audio/a1.wav';diarizeData=null");
  $('aiTranscript').value = 'raw session text';
  await w.startDiarizeFlow(); await tick();
  for (let i = 0; i < 8 && !w.eval('diarizeData'); i++) { await w.aiPollOnce(); await tick(40); }
  check('V1.12 no-enrollment run passes no enrollment to the engine', !!lastDiarizeArgs && !lastDiarizeArgs.enrollPath);
  check('V1.12 no-enrollment labels stay generic speakers', $('aiTranscript').value.includes('Speaker 1: I have not been sleeping well') && $('aiTranscript').value.includes('Speaker 2: We talked about'));
  check('V1.12 correction panel offers This is me with sample lines', $('diarizePanel').innerHTML.includes('This is me') && $('diarizePanel').innerHTML.includes('sleeping well'));
  w.markTherapist(1);
  check('V1.12 This is me relabels in place (no engine re-run)', $('aiTranscript').value.includes('Therapist: I have not been sleeping well') && $('aiTranscript').value.includes('Client: We talked about'));
  check('V1.12 This is me choice persists on the device', w.desktopDB.getPref('aiVoiceCluster') === '1');
  // Missing setup explains itself and routes to Models & Settings
  w.eval("aiStatusCache={os:'windows',whisper:{found:true,path:'/fake/whisper-cli'},llama:{found:true,path:'/fake/llama-cli'},diarize:{found:false,path:''},models:[],modelsDir:'/fake',enginesDir:'/fake',download:null,proc:null}");
  check('V1.12 missing engine reported by setup state', w.diarizeSetupState().ok === false && w.diarizeSetupState().missing.includes('engine') && w.diarizeSetupState().missing.includes('models'));
  w.showDiarizePanel();
  check('V1.12 missing setup panel explains + routes to Models', $('diarizePanel').textContent.includes('speaker separation engine is not installed') && $('diarizePanel').textContent.includes('Open Settings'));
  // Android: the feature hides behind the desktop-engines pattern
  w.eval("aiStatusCache={os:'android',whisper:{found:true,path:'x'},llama:{found:true,path:'x'},diarize:{found:false,path:''},models:[],modelsDir:'',enginesDir:'',download:null,proc:null}");
  w.updateDiarizeUi();
  check('V1.12 android: separate-speakers button hidden', $('aiDiarizeBtn').style.display === 'none');
  check('V1.12 android: setup state reports the android gate', w.diarizeSetupState().android === true);
  await w.refreshAiStatus(); await tick();
  check('V1.12 desktop status restores the button', $('aiDiarizeBtn').style.display !== 'none');
  // Rust-side static checks for the new plumbing
  check('rust: diarize_start is attributed + registered', /#\[tauri::command\]\nfn diarize_start/.test(rustSrc) && rustSrc.includes('transcribe_start,diarize_start,generate_start'));
  check('rust: diarize candidate names are the sherpa-onnx binaries', rustSrc.includes('"sherpa-onnx-offline-speaker-diarization.exe"') && rustSrc.includes('&["sherpa-onnx-offline-speaker-diarization"]'));
  check('rust: engine pin is sherpa-onnx v2.0.1 (win MT no-tts + mac arch packages)', rustSrc.includes('sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2') && rustSrc.includes('sherpa-onnx-v2.0.1-osx-'));
  check('rust: speaker model pins recorded', rustSrc.includes('sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx') && rustSrc.includes('3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'));
  check('rust: tar.bz2 extraction + enrollment concat helpers present', rustSrc.includes('fn extract_tar_bz2') && rustSrc.includes('fn concat_wavs'));
  check('rust: diarize flags match the engine CLI', rustSrc.includes('--segmentation.pyannote-model=') && rustSrc.includes('--embedding.model=') && rustSrc.includes('--clustering.num-clusters='));


  // V1.13.0: live transcription preview during recording
  check('rust: audio_snapshot is attributed + registered', /#\[tauri::command\]\nfn audio_snapshot/.test(rustSrc) && rustSrc.includes('audio_finish,audio_snapshot,audio_discard'));
  check('rust: finalize_wav_copy header-patch helper present', rustSrc.includes('fn finalize_wav_copy'));
  check('V1.13 preview toggle + pane exist, pane hidden by default', !!$('aiLivePreview') && !!$('aiPreviewText') && $('aiPreviewWrap').style.display === 'none');
  check('V1.13 preview toggle defaults on (pref unset)', w.getLivePreviewPref() === true && $('aiLivePreview').checked === true);
  check('V1.13 preview heading carries the final-transcript label', $('aiPreviewWrap').textContent.includes('Live preview'));
  // Media stubs so a real recording can start under jsdom
  const fakeStream = { getTracks: () => [{ stop() {} }], getAudioTracks: () => [{}] };
  Object.defineProperty(w.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => fakeStream, enumerateDevices: async () => [] } });
  w.AudioContext = class { constructor() { this.sampleRate = 48000; this.state = 'running'; } createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; } createMediaStreamSource() { return { connect() {} }; } createMediaStreamDestination() { return { stream: fakeStream }; } async close() {} };
  w.showView('studio'); await tick();
  $('aiClient').value = clientId;
  $('aiConsent').checked = true;
  $('aiRecSource').value = 'mic';
  $('aiLivePreview').disabled = false;
  $('aiTranscript').value = '';
  const snapsBefore = snapshotLog.length;
  await w.startRecording(); await tick(60);
  check('V1.13 recording started (preview session live)', !!w.eval('recState') && !!w.eval('previewSession'));
  const liveId1 = w.eval('recState.liveId'), livePath1 = w.eval('recState.livePath');
  check('V1.13 live mirror session opened for the preview', !!liveId1 && !!livePath1);
  w.eval('recState.chunks.push(new Int16Array(16000).fill(120))');
  previewOut = 'Preview first pass: client describes poor sleep.';
  await w.previewCycle(); w.eval('clearInterval(aiPollTimer)');
  check('V1.13 preview cycle snapshotted the live recording', snapshotLog.length === snapsBefore + 1 && snapshotLog[snapshotLog.length - 1] === liveId1);
  check('V1.13 preview transcription targeted the snapshot with the selected model', !!lastTranscribeArgs && (lastTranscribeArgs.audioPath || '').includes('-snap.wav') && lastTranscribeArgs.model === $('aiWhisperModel').value);
  await w.aiPollOnce(); await w.aiPollOnce(); await tick();
  check('V1.13 preview pane populated from the snapshot transcription', $('aiPreviewText').value.includes('Preview first pass'));
  check('V1.13 preview pane visible while recording', $('aiPreviewWrap').style.display === 'block');
  check('V1.13 preview never touches the real transcript box', $('aiTranscript').value === '');
  check('V1.13 snapshot file discarded after its preview landed', discardLog.includes('/fake/ai-audio/' + liveId1 + '-snap.wav'));
  w.eval('recState.chunks.push(new Int16Array(16000).fill(90))');
  previewOut = 'Preview second pass: sleep and work stress discussed.';
  await w.previewCycle(); w.eval('clearInterval(aiPollTimer)');
  await w.aiPollOnce(); await w.aiPollOnce(); await tick();
  check('V1.13 second preview cycle replaces the pane text', $('aiPreviewText').value.includes('Preview second pass') && !$('aiPreviewText').value.includes('first pass'));
  await w.stopRecording(); await tick(60);
  check('V1.13 stop hides + clears the preview pane', $('aiPreviewWrap').style.display === 'none' && $('aiPreviewText').value === '');
  check('V1.13 stop discards the live mirror file', discardLog.includes(livePath1));
  check('V1.13 normal recording uploaded on stop', w.eval('aiAudioPath') === '/fake/ai-audio/a1.wav');
  await w.startTranscribe(); await tick();
  await w.aiPollOnce(); await w.aiPollOnce(); await tick();
  check('V1.13 authoritative transcript lands after stop (preview discarded)', $('aiTranscript').value.includes('sleeping well') && $('aiPreviewText').value === '');
  // Toggle off: no mirror session, no snapshots
  $('aiLivePreview').checked = false; w.setLivePreviewPref(false);
  const seqBeforeOff = audioSeq, snapsBeforeOff = snapshotLog.length;
  await w.startRecording(); await tick(60);
  w.eval('recState.chunks.push(new Int16Array(16000).fill(70))');
  await w.previewCycle();
  check('V1.13 toggle off: no live mirror session and no snapshot calls', audioSeq === seqBeforeOff && snapshotLog.length === snapsBeforeOff && w.eval('previewSession') === null);
  await w.stopRecording(); await tick(60);
  $('aiLivePreview').checked = true; w.setLivePreviewPref(true);
  check('V1.13 toggle restored on + pref persisted', w.desktopDB.getPref('aiLivePreview') === '1');
  // Preview failure is silent and leaves the recording untouched
  failSnapshot = true;
  const snapsBeforeFail = snapshotLog.length;
  await w.startRecording(); await tick(60);
  w.eval('recState.chunks.push(new Int16Array(16000).fill(60))');
  await w.previewCycle(); await tick();
  check('V1.13 failed snapshot skipped silently, recording state untouched', snapshotLog.length === snapsBeforeFail + 1 && !!w.eval('recState') && w.eval('previewBusy') === false && $('aiPreviewWrap').style.display === 'none');
  failSnapshot = false;
  await w.stopRecording(); await tick(60);
  // Wizard recording step mirrors the same toggle
  w.eval('obStep=2'); w.renderObStep();
  check('V1.13 wizard recording step carries the preview toggle', !!$('obLivePreview') && $('obLivePreview').checked === true);
  const obLp = $('obLivePreview'); obLp.checked = false; w.obLivePreviewChange(obLp);
  check('V1.13 wizard toggle drives the Studio toggle + pref', $('aiLivePreview').checked === false && w.desktopDB.getPref('aiLivePreview') === '0');
  obLp.checked = true; w.obLivePreviewChange(obLp);
  check('V1.13 wizard toggle restores the pref', w.desktopDB.getPref('aiLivePreview') === '1' && $('aiLivePreview').checked === true);


  // ================= V1.14.0 =================
  // WS1: MSE chips driven by REAL DOM press sequences (mousedown/mouseup/click),
  // including a render-everything refresh landing between mousedown and mouseup.
  w.showView('studio'); await tick();
  w.mseClear(); await tick();
  w.toggleMoreOpts('record'); await tick();
  const msePhrase = 'Pressured speech';
  const chipIn = (pid) => [...w.document.querySelectorAll('#' + pid + ' button.mse-chip')].find(b => b.getAttribute('data-phrase') === msePhrase);
  const press = (el, mid) => { const chain = []; let n = el; while (n) { chain.push(n); n = n.parentNode; } el.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true })); if (mid) mid(); let tgt = el; if (!el.isConnected) tgt = chain.find(x => x.isConnected) || w.document.body; tgt.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, cancelable: true })); tgt.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); return tgt; };
  press(chipIn('msePanel'), null); await tick();
  check('V1.14 DOM press toggles the MSE selection', w.composeMse().includes(msePhrase));
  check('V1.14 toggled chip shows pressed style + aria-pressed', chipIn('msePanel').classList.contains('on') && chipIn('msePanel').getAttribute('aria-pressed') === 'true');
  check('V1.14 twin panel chip mirrors the pressed state in place', chipIn('panelMsePanel').classList.contains('on') && chipIn('panelMsePanel').getAttribute('aria-pressed') === 'true');
  check('V1.14 composed preview updates in both panels', $('msePreview').value.includes(msePhrase) && $('panelMsePreview').value.includes(msePhrase));
  const chipNode = chipIn('panelMsePanel');
  const landedOn = press(chipNode, () => { w.renderAll(); w.renderHome(); });
  await tick();
  check('V1.14 mid-press global refresh leaves the chip node in place (click lands on the chip)', chipNode.isConnected && landedOn === chipNode);
  check('V1.14 the press still toggles after the mid-press refresh', !w.composeMse().includes(msePhrase));
  const mseInput = $('msePanel').querySelector('input[data-mse-note]');
  mseInput.focus(); mseInput.value = 'focus keep test'; mseInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  press(chipIn('msePanel'), null); await tick();
  check('V1.14 chip press never rebuilds the panel (input node + focus survive)', $('msePanel').querySelector('input[data-mse-note]') === mseInput && w.document.activeElement === mseInput);
  check('V1.14 typing in a domain note input survives a chip toggle', mseInput.value === 'focus keep test' && w.composeMse().includes(msePhrase));
  w.renderMsePanel();
  check('V1.14 a full re-render (mount/language path) restores focus to the same domain input', w.document.activeElement === $('msePanel').querySelector('input[data-mse-note]') && w.document.activeElement !== mseInput);
  w.mseClear();
  w.toggleMoreOpts('record'); await tick();

  // WS2: legacy load, edit persistence, heading derivation, freeform fallback
  const legacyId = 'legacy-note-1';
  const dbRef2 = w.eval('db');
  dbRef2.sessions.push({ id: legacyId, clientId, date: '2026-10-15', format: 'soap', outputLanguage: 'follow', sections: { subjective: 'LEGACY SUBJ marker', plan: 'LEGACY PLAN marker' }, text: 'Subjective (S)\nLEGACY SUBJ marker', status: 'draft', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' });
  await w.persistWorkspace(); await flush();
  w.openNote(legacyId); await tick();
  check('V1.14 legacy sections-only note loads composed into the one box', $('nText').value.includes('Subjective (S):') && $('nText').value.includes('LEGACY SUBJ marker') && $('nText').value.includes('LEGACY PLAN marker'));
  $('nText').value = $('nText').value + '\nEdited tail line.';
  await w.saveNote(); await flush();
  const legacySaved = savedState().sessions.find(s => s.id === legacyId);
  check('V1.14 edited document persists as fullText', (legacySaved.fullText || '').includes('Edited tail line.'));
  check('V1.14 save re-derives sections from the heading lines', (legacySaved.sections.subjective || '').includes('LEGACY SUBJ marker') && (legacySaved.sections.plan || '').includes('LEGACY PLAN marker'));
  check('V1.14 derived legacy text keeps search/overview/exports working', (legacySaved.text || '').includes('LEGACY SUBJ marker'));
  check('V1.14 copy-note button exists and audits like the old per-section copy', typeof w.copyNoteBody === 'function');
  auditEvents.length = 0; w.copyNoteBody(); await tick();
  check('V1.14 copy note text is audit-logged', auditEvents.some(e => e.action === 'Copy note'));
  w.openNote(); $('nText').value = 'Completely freeform note with no headings at all.';
  await w.saveNote(); await flush();
  const freeSaved = savedState().sessions[savedState().sessions.length - 1];
  check('V1.14 heading-less document falls back to one note section + verbatim text', (freeSaved.sections.note || '').includes('freeform note') && freeSaved.text.includes('freeform note'));
  w.closeNoteEditor();

  // WS3: guided Studio — steps on the surface, everything else behind More options
  check('V1.14 studio shows the three plain-language steps', $('studio').textContent.includes('Choose the client') && $('studio').textContent.includes('Record the session') && $('studio').textContent.includes('Write the note'));
  check('V1.14 More options disclosures start closed', $('moreOptsRecord').style.display === 'none' && $('moreOptsNote').style.display === 'none');
  check('V1.14 MSE + vocabulary + separate-speakers live behind record More options', $('moreOptsRecord').contains($('msePanel')) && $('moreOptsRecord').contains($('aiVocabulary')) && $('moreOptsRecord').contains($('aiDiarizeBtn')) && $('moreOptsRecord').contains($('aiDelAudio')));
  check('V1.14 detail/quote + template + session instructions live behind note More options', $('moreOptsNote').contains($('aiSessionInstructions')) && $('moreOptsNote').contains($('aiCustomTemplate')) && $('moreOptsNote').contains($('aiDetail')));
  check('V1.14 consent gate stays visible beside Record (outside any disclosure)', !$('moreOptsRecord').contains($('aiConsent')) && $('studio').contains($('aiConsent')));
  w.toggleMoreOpts('record'); await tick();
  check('V1.14 opening record More options reveals the MSE panel + persists the pref', $('moreOptsRecord').style.display !== 'none' && (w.desktopDB.getPref('aiMoreOpts') || '').includes('"record":true') && $('moreOptsRecordBtn').getAttribute('aria-expanded') === 'true');
  w.toggleMoreOpts('record'); await tick();
  check('V1.14 closing persists too', $('moreOptsRecord').style.display === 'none' && (w.desktopDB.getPref('aiMoreOpts') || '').includes('"record":false'));
  const srcSeg = w.document.querySelector('.seg[data-seg="recSource"]');
  check('V1.14 recording source renders as a segmented control', !!srcSeg && !!srcSeg.querySelector('[data-segv="tele"]'));
  w.segPick('recSource', 'tele');
  check('V1.14 source seg drives the hidden select + pref', $('aiRecSource').value === 'tele' && w.desktopDB.getPref('aiRecSource') === 'tele');
  w.segPick('recSource', 'mic');
  check('V1.14 source seg switches back to microphone', $('aiRecSource').value === 'mic' && w.desktopDB.getPref('aiRecSource') === 'mic');



  // ================= V1.15.0 =================
  // WS1: generation waits — feedback, stall rule, cancel, error passthrough.
  const alertLog = [];
  w.alert = (m) => { alertLog.push(String(m)); };
  w.eval('GEN_WAIT.pollMs=10');
  w.showView('home'); await tick();
  w.getPendingNotes().slice().forEach(p2 => w.removePendingNote(p2.id)); await flush();
  check('V1.15 shared wait helper + Home status/cancel UI exist', typeof w.waitForGeneration === 'function' && !!$('homeGenStatus') && !!$('homeGenCancel'));
  check('V1.15 the old fixed-count timeout error is gone from the UI code', !html.includes('generation timed out'));

  // WS1a: slow generation (engine finishes at poll ~400, output keeps growing)
  // — the exact failure mode Tim hit — now completes from the Home Write button.
  const SLOW_OUT = 'noise<|im_start|>assistant\n{"subjective":"SLOW NOTE MARKER","objective":"o","assessment":"a","plan":"p"}<|im_end|>';
  genBehavior = (n) => n >= 400 ? { active: false, kind: 'generate', done: true, progress: 100, output: SLOW_OUT } : { active: true, kind: 'generate', done: false, progress: Math.min(99, n / 4), output: 'x'.repeat(n * 10) };
  const slowId = w.addPendingNote(clientId, 'brief', 'Slow generation source text.', '2026-10-30'); await flush();
  const slowP = w.writeNoteFromQueue(slowId); await tick(150);
  check('V1.15 slow write: clicked button enters a busy state (disabled, Writing label)', [...$('queueList').querySelectorAll('button')].some(b => b.disabled && b.textContent.includes('Writing')));
  check('V1.15 slow write: status line shows live elapsed seconds', $('homeGenStatus').style.display !== 'none' && /sec/.test($('homeGenStatusText').textContent));
  await slowP; await tick();
  check('V1.15 slow generation completes — no timeout error, draft opens', $('noteEditorWrap').style.display !== 'none' && $('nText').value.includes('SLOW NOTE MARKER') && !alertLog.some(a => a.includes('timed out')));
  check('V1.15 busy state cleared after success', $('homeGenStatus').style.display === 'none' && w.eval('homeGenToken') === null);
  w.closeNoteEditor();
  { const rd = w.getReviewDrafts().find(d => d.queueId === slowId); if (rd) w.discardReviewDraft(rd.id); w.removePendingNote(slowId); await flush(); }
  genBehavior = null;

  // WS1b: cancel mid-wait resolves quietly and frees the engine slot.
  genBehavior = (n) => ({ active: true, kind: 'generate', done: false, progress: 10, output: 'x'.repeat(n * 5) });
  const cancelId = w.addPendingNote(clientId, 'brief', 'Cancel test source.', '2026-10-30'); await flush();
  alertLog.length = 0; procCancelCount = 0;
  const cancelP = w.writeNoteFromQueue(cancelId); await tick(150);
  check('V1.15 cancel: a wait is running before the cancel', w.eval('homeGenToken') !== null);
  w.cancelHomeGeneration(); await cancelP; await tick();
  check('V1.15 cancel resolves quietly (no error alert, no editor opened)', alertLog.length === 0 && $('noteEditorWrap').style.display === 'none');
  check('V1.15 cancel freed the engine slot + cleared busy state', procCancelCount >= 1 && w.eval('homeGenToken') === null && $('homeGenStatus').style.display === 'none');
  genBehavior = null;
  await w.writeNoteFromQueue(cancelId); await tick();
  check('V1.15 a generation after the cancel succeeds on the freed slot', $('noteEditorWrap').style.display !== 'none');
  w.closeNoteEditor();
  { const rd = w.getReviewDrafts().find(d => d.queueId === cancelId); if (rd) w.discardReviewDraft(rd.id); w.removePendingNote(cancelId); await flush(); }

  // WS1c: a frozen engine (no progress, no output growth) trips the stall path.
  w.eval('GEN_WAIT.stallMs=400');
  genBehavior = (n) => ({ active: true, kind: 'generate', done: false, progress: -1, output: '' });
  const stallId = w.addPendingNote(clientId, 'brief', 'Stall test source.', '2026-10-30'); await flush();
  alertLog.length = 0; procCancelCount = 0;
  await w.writeNoteFromQueue(stallId); await tick();
  check('V1.15 stalled wait surfaces the no-output message (not a timeout)', alertLog.some(a => a.includes('no new output for 3 minutes')) && !alertLog.some(a => a.includes('generation timed out')));
  check('V1.15 stall freed the engine slot + cleared busy state', procCancelCount >= 1 && w.eval('homeGenToken') === null);
  w.removePendingNote(stallId); await flush();
  w.eval('GEN_WAIT.stallMs=180000');
  genBehavior = null;

  // WS1d: engine errors pass through verbatim.
  genBehavior = (n) => n >= 2 ? { active: false, kind: 'generate', done: true, progress: 100, output: '', error: 'engine exploded: bad model file' } : { active: true, kind: 'generate', done: false, progress: 20, output: '' };
  const errId = w.addPendingNote(clientId, 'brief', 'Error test source.', '2026-10-30'); await flush();
  alertLog.length = 0;
  await w.writeNoteFromQueue(errId); await tick();
  check('V1.15 engine error text reaches the user verbatim', alertLog.some(a => a.includes('engine exploded: bad model file')));
  check('V1.15 engine error clears busy state', w.eval('homeGenToken') === null && $('homeGenStatus').style.display === 'none');
  w.removePendingNote(errId); await flush();
  genBehavior = null;

  // WS1e: the Studio path completes through the same shared wait.
  w.showView('studio');
  $('aiClient').value = clientId;
  $('aiBrief').value = 'Studio unified wait source text.';
  const revBefore15 = w.getReviewDrafts().length;
  await w.generateNote('brief'); await tick();
  check('V1.15 Studio generation completes via the shared wait (draft opens, token cleared)', $('noteEditorWrap').style.display !== 'none' && w.getReviewDrafts().length === revBefore15 + 1 && w.eval('studioGenToken') === null);
  w.closeNoteEditor();
  w.getPendingNotes().filter(p2 => p2.source === 'Studio unified wait source text.').forEach(p2 => w.removePendingNote(p2.id));
  { const rd = w.getReviewDrafts()[w.getReviewDrafts().length - 1]; if (rd) w.discardReviewDraft(rd.id); await flush(); }

  // WS1f: Write all over two items shows per-item status and finishes both.
  genBehavior = (n) => n >= 30 ? { active: false, kind: 'generate', done: true, progress: 100, output: 'noise<|im_start|>assistant\n{"subjective":"WA MARKER","objective":"o","assessment":"a","plan":"p"}<|im_end|>' } : { active: true, kind: 'generate', done: false, progress: n * 3, output: 'x'.repeat(n * 20) };
  const wa1 = w.addPendingNote(clientId, 'brief', 'Write-all item one source.', '2026-10-30');
  const wa2 = w.addPendingNote(clientId, 'brief', 'Write-all item two source.', '2026-10-30');
  await flush();
  alertLog.length = 0;
  const waP = w.writeAllQueue(); await tick(120);
  check('V1.15 Write all shows per-item status while running', /of 2/.test($('writeAllStatus').textContent) || /of 2/.test($('homeGenStatusText').textContent));
  await waP; await tick();
  check('V1.15 Write all finished both drafts (first open, second queued)', $('noteEditorWrap').style.display !== 'none' && w.eval('writeAllDrafts').length === 1 && alertLog.length === 0);
  w.closeNoteEditor();
  [wa1, wa2].forEach(qid => { const rd = w.getReviewDrafts().find(d => d.queueId === qid); if (rd) w.discardReviewDraft(rd.id); w.removePendingNote(qid); });
  w.eval('writeAllDrafts=[]');
  genBehavior = null;
  w.eval('GEN_WAIT.pollMs=150');

  // WS2: custom-phrase storage migration (legacy strings -> {text, shortcut}).
  w.desktopDB.setPref('corpusCustomPhrases', JSON.stringify(['Legacy phrase one kept verbatim.', 'Second legacy phrase.']));
  w.eval('corpusCustomCache=null;corpusCustomMigrated=false');
  const mig = w.getCorpusCustom();
  check('V1.15 migration converts legacy strings with text intact', mig.length === 2 && mig[0].text === 'Legacy phrase one kept verbatim.' && mig[0].shortcut === '' && mig[1].text === 'Second legacy phrase.');
  check('V1.15 migration rewrites the stored pref in the object shape', (JSON.parse(w.desktopDB.getPref('corpusCustomPhrases'))).every(e => typeof e === 'object' && typeof e.text === 'string'));
  w.renderPhrasePanel();
  $('customPhraseInput').value = 'Client used the grounding exercise before bed.';
  $('customPhraseShortcut').value = 'grnd';
  w.addCustomPhrase(); await flush();
  check('V1.15 custom phrase added through the UI stores its shortcut', (w.getCorpusCustom().find(c => c.shortcut === 'grnd') || {}).text === 'Client used the grounding exercise before bed.');
  check('V1.15 prompt append still carries custom phrase texts', w.buildNotePrompt('Client reported poor sleep.', 'brief').includes('Client used the grounding exercise before bed.'));

  // WS2: type-to-insert in the note box.
  w.openNote(); await tick();
  const nb = $('nText');
  const typeIn = async (ta, val) => { ta.value = val; ta.focus(); ta.setSelectionRange(val.length, val.length); ta.dispatchEvent(new w.Event('input', { bubbles: true })); await tick(); };
  await typeIn(nb, 'Session notes.\n/relax');
  check('V1.15 slash opens the phrase menu with matches from the library', $('phraseMenu').style.display === 'block' && $('phraseMenu').textContent.includes('relaxation') && $('phraseMenu').textContent.includes('Library'));
  nb.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
  check('V1.15 Enter inserts the FULL phrase and removes the trigger', nb.value.includes('Therapist taught the client relaxation and breathing skills to reduce physiological arousal when anxiety escalates.') && !nb.value.includes('/relax') && $('phraseMenu').style.display === 'none');
  await typeIn(nb, '/affect');
  nb.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
  check('V1.15 insertion auto-selects the first [bracketed] fill-in slot', nb.value.indexOf('Client presented with [affect]') === 0 && nb.value.slice(nb.selectionStart, nb.selectionEnd) === '[affect]');
  await typeIn(nb, 'The client said grnd');
  check('V1.15 a custom shortcut typed as a whole word opens the menu pre-filtered', $('phraseMenu').style.display === 'block' && $('phraseMenu').querySelectorAll('.pm-row').length === 1 && $('phraseMenu').textContent.includes('grnd'));
  nb.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
  check('V1.15 shortcut insertion replaces the word with the full phrase', nb.value === 'The client said Client used the grounding exercise before bed.' && $('phraseMenu').style.display === 'none');
  await typeIn(nb, 'The client said zzzz');
  check('V1.15 a word with no shortcut does not open the menu', $('phraseMenu').style.display === 'none');
  await typeIn(nb, 'Dose 3/4');
  check('V1.15 a slash between digits (3/4) never opens the menu', $('phraseMenu').style.display === 'none');
  nb.dispatchEvent(new w.Event('compositionstart', { bubbles: true }));
  await typeIn(nb, '/relax');
  check('V1.15 IME composition never opens the menu', $('phraseMenu').style.display === 'none');
  nb.dispatchEvent(new w.Event('compositionend', { bubbles: true }));
  w.closeNoteEditor();

  // WS2: the menu also serves the brief box; Escape dismisses without inserting.
  w.showView('studio');
  const bb = $('aiBrief');
  await typeIn(bb, '/relax');
  check('V1.15 the menu serves the brief box too', $('phraseMenu').style.display === 'block' && $('phraseMenu').textContent.includes('relaxation'));
  bb.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  check('V1.15 Escape dismisses without inserting', $('phraseMenu').style.display === 'none' && bb.value === '/relax');
  bb.value = '';

  // WS2: compact panel rows — a >100-char phrase renders a truncated one-line preview.
  const LONGP = 'This is a deliberately long custom phrase that runs well beyond one hundred characters so the compact row has to truncate its visible preview text.';
  w.saveCorpusCustom(w.getCorpusCustom().concat([{ text: LONGP, shortcut: 'lng' }]));
  $('phrasePanel').style.display = 'block'; w.renderPhrasePanel();
  const longRow = [...$('phrasePanel').querySelectorAll('.phrase-row')].find(r => { const b = r.querySelector('[data-act="insert"]'); return b && b.getAttribute('title') === LONGP; });
  check('V1.15 panel row preview is single-line truncated for a >100-char phrase', !!longRow && longRow.querySelector('[data-act="insert"]').textContent.trim().length < LONGP.length && !longRow.querySelector('[data-act="insert"]').textContent.includes('truncate its visible preview text'));
  check('V1.15 the full phrase text is available in the row title attribute', !!longRow && longRow.querySelector('[data-act="insert"]').getAttribute('title') === LONGP);
  check('V1.15 custom row carries its shortcut badge + shortcut editor', !!longRow && longRow.textContent.includes('lng') && !!longRow.querySelector('input[data-sc-for]'));

  // ================= V1.16.0 =================
  // A simpler, friendlier interface: plain nav labels, a subtitle on every
  // view, Home action tiles, Studio record/brief tabs, the editor's More
  // actions disclosure, regrouped Settings, and empty states with actions.
  w.showView('home'); await tick();
  const navEn = [...w.document.querySelectorAll('nav button[data-view]')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
  check('V1.16 nav shows the five plain labels (EN)', navEn[0].startsWith('Home') && navEn[1] === 'Clients' && navEn[2] === 'Write a note' && navEn[3] === 'Notes' && navEn[4] === 'Settings');
  check('V1.16 every view carries a plain-language subtitle', ['home', 'clients', 'studio', 'notes', 'models'].every(id => { const s = $(id).querySelector('.view-sub'); return s && s.textContent.trim().length > 0; }));
  const tiles = [...w.document.querySelectorAll('.action-tile')];
  check('V1.16 home has both action tiles', tiles.length === 2);
  tiles[0].click(); await tick();
  check('V1.16 Record tile lands on Studio in record mode', $('studio').classList.contains('active') && $('studioModeRecord').style.display !== 'none' && $('studioModeBrief').style.display === 'none');
  w.showView('home'); await tick();
  tiles[1].click(); await tick();
  check('V1.16 Add-a-client tile opens the client dialog', $('clientDialog').open === true);
  $('clientDialog').close();
  w.showView('studio'); await tick();
  w.setStudioMode('brief'); await tick();
  check('V1.16 brief tab shows the summary panel only', $('studioModeBrief').style.display !== 'none' && $('studioModeRecord').style.display === 'none' && $('studioTabBriefBtn').classList.contains('on'));
  w.setStudioMode('record'); await tick();
  check('V1.16 record tab restores the record panel', $('studioModeRecord').style.display !== 'none' && $('studioModeBrief').style.display === 'none' && $('studioTabRecordBtn').classList.contains('on'));
  const step3Card = [...$('studio').querySelectorAll('.card')].find(c => !!c.querySelector('button[onclick*="generateNote"]'));
  check('V1.16 Step 3 keeps exactly one primary (Write my note)', !!step3Card && [...step3Card.querySelectorAll('button.primary')].filter(b => b.style.display !== 'none').length === 1);
  // Empty states: cleared queue + review; no-match filters for clients + notes
  w.getPendingNotes().slice().forEach(p => w.removePendingNote(p.id));
  w.getReviewDrafts().slice().forEach(d => w.discardReviewDraft(d.id));
  await flush(); w.renderHome(); await tick();
  check('V1.16 empty queue shows a friendly line + Record action', $('queueList').textContent.includes('Nothing waiting') && !!$('queueList').querySelector('button'));
  check('V1.16 empty review list shows a friendly line + action', $('reviewList').textContent.includes('No drafts waiting') && !!$('reviewList').querySelector('button'));
  w.showView('clients'); $('clientFilter').value = 'zzz-no-match'; w.renderClients(); await tick();
  check('V1.16 clients empty state offers Add client', $('clientsTable').textContent.includes('No clients yet') && !!$('clientsTable').querySelector('button'));
  $('clientFilter').value = ''; w.renderClients();
  w.showView('notes'); $('notesSearch').value = 'zzz-no-match'; w.renderNotes(); await tick();
  check('V1.16 notes empty state offers New note', $('notesList').textContent.includes('No saved notes yet') && !!$('notesList').querySelector('button'));
  $('notesSearch').value = ''; w.renderNotes();
  // Settings regrouping
  w.showView('models'); await tick(80);
  const heads = [...$('models').querySelectorAll('h3')].map(h => h.textContent.trim());
  const wantHeads = ['Downloads', 'Your voice', 'How your notes are written', 'Privacy & security', 'Backup & data', 'Advanced'];
  const hIdx = wantHeads.map(x => heads.indexOf(x));
  check('V1.16 settings shows the six plain section headings in order', hIdx.every(i => i >= 0) && hIdx.every((v, i) => i === 0 || v > hIdx[i - 1]));
  check('V1.16 Advanced starts closed with its controls inside', $('advancedBody').style.display === 'none' && !!$('path-whisper') && !!$('path-llama') && !!$('path-diarize') && !!$('aiImportPath') && !$('modelsBody').contains($('path-whisper')));
  w.toggleAdvanced(); await tick();
  check('V1.16 Advanced opens on toggle', $('advancedBody').style.display !== 'none' && $('advancedBtn').getAttribute('aria-expanded') === 'true');
  w.toggleAdvanced(); await tick();
  check('V1.16 Advanced closes again', $('advancedBody').style.display === 'none');
  // Notes editor: More actions disclosure + single primary + secondary Finalize
  w.openNote(savedState().sessions[0].id); await tick();
  check('V1.16 editor More actions starts closed with Verify/Copy/Print/Delete inside', $('editorActions').style.display === 'none' && $('editorActions').contains($('verifyBtn')) && !!$('editorActions').querySelector('[onclick="copyNoteBody()"]') && !!$('editorActions').querySelector('[onclick="printCurrentNote()"]') && $('editorActions').contains($('nDeleteBtn')));
  w.toggleEditorActions(); await tick();
  check('V1.16 editor More actions opens on toggle', $('editorActions').style.display !== 'none');
  w.toggleEditorActions(); await tick();
  const visPrim = [...$('noteEditorWrap').querySelectorAll('button.primary')].filter(b => b.style.display !== 'none');
  check('V1.16 note editor keeps exactly one visible primary (Save)', visPrim.length === 1 && visPrim[0].getAttribute('data-i') === 'saveNote');
  check('V1.16 Finalize is a secondary button now', $('finalizeBtn').classList.contains('secondary') && !$('finalizeBtn').classList.contains('primary'));
  w.closeNoteEditor();
  // ZH nav labels, then restore English
  w.toggleUiLang(); await tick(60); await flush();
  const navZh = [...w.document.querySelectorAll('nav button[data-view]')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
  check('V1.16 nav shows the five plain labels (ZH)', navZh[0].startsWith('首页') && navZh[1] === '来访者' && navZh[2] === '写记录' && navZh[3] === '记录' && navZh[4] === '设置');
  w.toggleUiLang(); await tick(60); await flush();
  check('V1.16 language restored to English after the nav check', w.eval('uiLang') === 'en');


  // ================= V1.18.0 =================
  // WS1: "Last time" prep card in Studio Step 1 — deterministic assembly
  // from the client's most recent FINALIZED note only.
  const dbRef3 = w.eval('db');
  const ltClientRec = dbRef3.clients.find(c => c.id === clientId);
  if (ltClientRec) ltClientRec.goals = 'LT GOALS marker: rebuild a regular sleep routine';
  dbRef3.sessions.push({ id: 'lt-fin', clientId, date: '2026-10-28', format: 'soap', outputLanguage: 'follow', sections: { subjective: 'LT subj marker', plan: 'LT PLAN marker: continue the wind-down routine nightly' }, text: 'LT PLAN marker', status: 'finalized', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' });
  dbRef3.sessions.push({ id: 'lt-draft', clientId, date: '2026-10-29', format: 'soap', outputLanguage: 'follow', sections: { plan: 'LT DRAFT PLAN never shown' }, text: 'LT DRAFT PLAN never shown', status: 'draft', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z' });
  w.showView('studio'); $('aiClient').value = clientId; w.applyClientDefaults(); await tick();
  const ltHtml = $('lastTimeWrap').innerHTML;
  check('V1.18 last-time card shows the finalized note plan excerpt', ltHtml.includes('LT PLAN marker'));
  check('V1.18 last-time card ignores the newer draft note', !ltHtml.includes('LT DRAFT PLAN'));
  check('V1.18 last-time card shows the finalized note date + heading', ltHtml.includes('2026-10-28') && ltHtml.includes('Last time'));
  check('V1.18 last-time card shows the client goals line', ltHtml.includes('LT GOALS marker'));
  w.openClient(); $('cName').value = 'LT Fresh Client'; $('cStatus').value = 'Active'; await w.saveClient(); await flush();
  const freshId = savedState().clients.find(c => c.name === 'LT Fresh Client').id;
  $('aiClient').value = freshId; w.applyClientDefaults(); await tick();
  check('V1.18 client without finalized notes gets the quiet line', $('lastTimeWrap').textContent.includes('No finished notes yet'));
  $('aiClient').value = clientId; w.applyClientDefaults(); await tick();
  check('V1.18 switching clients updates the prep card', $('lastTimeWrap').innerHTML.includes('LT PLAN marker'));
  await w.deleteClientForever(freshId); await flush();

  // WS2: the two language selects now live together in Step 2's Languages group
  const langGroup = $('aiLang').closest('.lang-group');
  check('V1.18 both language selects live in the Step 2 Languages group', !!langGroup && langGroup.contains($('aiOutLang')) && langGroup.querySelector('.lang-group-title').textContent === 'Languages');
  check('V1.18 language pair carries the new labels', langGroup.textContent.includes('Session language') && langGroup.textContent.includes('Note language'));
  const step3Card3 = [...$('studio').querySelectorAll('.card')].find(c => !!c.querySelector('button[onclick*="generateNote"]'));
  check('V1.18 Step 3 no longer contains aiOutLang', !!step3Card3 && !step3Card3.contains($('aiOutLang')));
  $('aiLang').value = 'yue'; w.eval("aiAudioPath='/fake/ai-audio/a1.wav'");
  await w.startTranscribe(); await w.aiPollOnce(); await w.aiPollOnce();
  check('V1.18 session language still drives transcription', !!lastTranscribeArgs && lastTranscribeArgs.lang === 'yue');
  $('aiOutLang').value = 'es';
  check('V1.18 note language still drives the generation prompt', w.buildNotePrompt('LT source about sleep', 'brief').includes('Spanish'));
  $('aiOutLang').value = 'follow';

  // WS3: journey ribbon above the Home tiles; tiles untouched
  w.showView('home'); await tick();
  const journeyEl = w.document.querySelector('.journey');
  check('V1.18 home journey ribbon shows the four steps (EN)', !!journeyEl && journeyEl.textContent.includes('Prepare') && journeyEl.textContent.includes('Record') && journeyEl.textContent.includes('Write the note') && journeyEl.textContent.includes('Done'));
  check('V1.18 home tiles still present after the ribbon', [...w.document.querySelectorAll('.action-tile')].length === 2);

  // WS4: draft-trust line inside the shared editor markup, both mount hosts
  w.openNote(savedState().sessions[0].id); await tick();
  check('V1.18 draft-trust line present in the editor (Notes view)', !!$('draftTrustLine') && $('noteEditorWrap').contains($('draftTrustLine')) && $('draftTrustLine').textContent.includes('starting point'));
  w.mountEditor('workspace'); await tick();
  check('V1.18 draft-trust line travels with the editor to the workspace panel', $('wsPanelMount').contains($('draftTrustLine')));
  w.mountEditor('notes'); w.closeNoteEditor();

  // The new strings in Chinese, then restore English
  w.toggleUiLang(); await tick(60); await flush();
  check('V1.18 journey ribbon renders in Chinese', w.document.querySelector('.journey').textContent.includes('准备') && w.document.querySelector('.journey').textContent.includes('录制') && w.document.querySelector('.journey').textContent.includes('写记录') && w.document.querySelector('.journey').textContent.includes('完成'));
  check('V1.18 languages group renders in Chinese', $('aiLang').closest('.lang-group').textContent.includes('会谈语言') && $('aiLang').closest('.lang-group').textContent.includes('记录语言'));
  $('aiClient').value = clientId; w.applyClientDefaults(); await tick();
  check('V1.18 last-time card renders in Chinese', $('lastTimeWrap').textContent.includes('上次回顾') && $('lastTimeWrap').textContent.includes('LT PLAN marker'));
  check('V1.18 draft-trust line renders in Chinese', $('draftTrustLine').textContent.includes('草稿只是起点'));
  w.toggleUiLang(); await tick(60); await flush();


  // Delete flows
  const noteId = savedState().sessions[0].id;
  const preDeleteCount = savedState().sessions.length;
  await w.deleteNote(noteId); await flush();
  check('note deleted', savedState().sessions.length === preDeleteCount - 1);
  await w.deleteClientForever(clientId); await flush();
  st = savedState();
  check('client delete cascades to notes', st.clients.length === 0 && st.sessions.length === 0);

  check('no uncaught page errors during smoke run', errors.length === 0);
  if (errors.length) console.error('page errors:', errors);

  // System-language detection: a fresh install on a zh-CN system starts in Chinese
  try {
    const prefs2 = new Map();
    const fakeInvoke2 = async (cmd, args = {}) => {
      switch (cmd) {
        case 'db_list_prefs': return Object.fromEntries(prefs2);
        case 'db_get_pref': return prefs2.has(args.key) ? prefs2.get(args.key) : null;
        case 'db_set_pref': prefs2.set(args.key, args.val); return true;
        case 'db_remove_pref': prefs2.delete(args.key); return true;
        case 'db_get_state': return '';
        case 'startup_status': return { needsSetup: true, authenticated: false, user: null };
        default: return null;
      }
    };
    const dom2 = new JSDOM(html, {
      url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        window.__TAURI__ = { core: { invoke: fakeInvoke2 } };
        Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
        window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
        window.HTMLDialogElement.prototype.close = function () { this.open = false; };
        window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
        window.URL.createObjectURL = () => 'blob:fake'; window.URL.revokeObjectURL = () => {};
        window.HTMLElement.prototype.scrollIntoView = function () {};
      },
    });
    const w2 = dom2.window;
    await new Promise((r) => setTimeout(r, 120)); await new Promise((r) => setTimeout(r, 120));
    check('fresh install on zh-CN system detects Chinese UI', w2.eval('uiLang') === 'zh');
    check('zh detection renders Chinese lock screen', w2.document.getElementById('lockTitle').textContent.includes('创建账户'));
    check('zh detection sets html lang', w2.document.documentElement.lang === 'zh-CN');
    check('zh detection shows Mind X社区 credit', w2.document.getElementById('devLink').textContent === 'Mind X社区');
    dom2.window.close();
  } catch (e) { check('zh detection instance ran (' + (e && e.message || e) + ')', false); }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nSMOKE TEST: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(2); });
