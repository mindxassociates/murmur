/* Frontend smoke test for Murmur (Tauri Web UI).
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
    case 'ai_status': return { whisper: { found: true, path: '/fake/whisper-cli' }, llama: { found: true, path: '/fake/llama-cli' }, models: [
      { id: 'base', kind: 'whisper', label: 'Base', file: 'ggml-base.bin', downloaded: false, bytes: 0 },
      { id: 'small', kind: 'whisper', label: 'Small', file: 'ggml-small.bin', downloaded: true, bytes: 487601967 },
      { id: 'medium', kind: 'whisper', label: 'Medium', file: 'ggml-medium.bin', downloaded: false, bytes: 0 },
      { id: 'turbo', kind: 'whisper', label: 'Large v3 Turbo', file: 'ggml-large-v3-turbo.bin', downloaded: false, bytes: 0 },
      { id: 'qwen15', kind: 'llm', label: 'Qwen2.5 1.5B', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', downloaded: false, bytes: 0 },
      { id: 'qwen3', kind: 'llm', label: 'Qwen2.5 3B', file: 'qwen2.5-3b-instruct-q4_k_m.gguf', downloaded: true, bytes: 2104049000 } ],
      modelsDir: '/fake/ai-models', enginesDir: '/fake/ai-engines', os: 'windows', download: null, proc: null };
    case 'ai_download': return true;
    case 'ai_download_cancel': return true;
    case 'ai_set_engine_path': return true;
    case 'ai_import_model': return 'imported.gguf';
    case 'audio_begin': return { id: 'a1', path: '/fake/ai-audio/a1.wav' };
    case 'audio_append': return true;
    case 'audio_finish': return { path: '/fake/ai-audio/a1.wav', bytes: 1234 };
    case 'audio_discard': aiDiscarded = args.path; return true;
    case 'transcribe_start': lastTranscribeArgs = args; aiProc = { kind: 'transcribe', n: 0 }; return true;
    case 'generate_start': lastPrompt = args.prompt; aiProc = { kind: 'generate', n: 0, out: args.prompt.includes('VERIFY NOTE AGAINST SOURCE') ? verifyOutput : undefined }; return true;
    case 'ai_proc_poll': { if (!aiProc) return { active: false, kind: '', done: true, output: '', progress: -1 };
      aiProc.n++; if (aiProc.n < 2) return { active: true, kind: aiProc.kind, done: false, progress: 50, output: '' };
      const kind = aiProc.kind; const customOut = aiProc.out; aiProc = null;
      const output = kind === 'transcribe'
        ? 'I have not been sleeping well and work stress is high.\nWe talked about my sleep routine today.'
        : (customOut !== undefined ? customOut : 'noise<|im_start|>assistant\n{"subjective":"Client reported poor sleep and high work stress","objective":"Client appeared tired but engaged","assessment":"Stress-related insomnia, mild improvement in coping","plan":"Wind-down routine nightly; review sleep next session"}<|im_end|>\nllama_print_timings: total');
      return { active: false, kind, done: true, progress: 100, output }; }
    case 'ai_proc_cancel': aiProc = null; return true;
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
  w.openNote(); await tick();
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
  check('custom phrase persists to corpusCustomPhrases pref', (JSON.parse(w.desktopDB.getPref('corpusCustomPhrases') || '[]')).includes('Client smiled for the first time in several weeks.'));
  check('custom phrase appears in My phrases section', $('myPhraseList').innerHTML.includes('Client smiled for the first time'));
  const minePrompt = w.buildNotePrompt('Client reported poor sleep and work stress.', 'brief');
  check('prompt carries preferred-phrasing subsection with favorite + custom', minePrompt.includes("Therapist's own preferred phrasing") && minePrompt.includes('relaxation and breathing skills') && minePrompt.includes('Client smiled for the first time in several weeks.'));
  check('preferred phrasing after corpus, before custom template', minePrompt.indexOf("Therapist's own preferred phrasing") > minePrompt.indexOf('CLINICAL LANGUAGE CORPUS') && minePrompt.indexOf("Therapist's own preferred phrasing") < minePrompt.indexOf('CUSTOM TEMPLATE'));
  const subjTa = w.document.querySelector('textarea[data-seckey="subjective"]');
  subjTa.focus();
  const chip = [...w.document.querySelectorAll('#phrasePanel [data-act="insert"]')].find(b => b.getAttribute('data-phrase') === RELAX);
  chip.click(); await tick();
  check('phrase click inserts into the focused note textarea', subjTa.value.includes('relaxation and breathing skills to reduce physiological arousal'));
  check('i18n dictionaries keep EN/ZH key parity', JSON.stringify(Object.keys(w.eval('I18N.en')).sort()) === JSON.stringify(Object.keys(w.eval('I18N.zh')).sort()));
  $('aiOrientation').value = '';
  await w.aiPollOnce(); await w.aiPollOnce();
  const subj = w.document.querySelector('textarea[data-seckey="subjective"]');
  check('generated JSON parsed into SOAP section editor', subj && subj.value.includes('poor sleep'));
  check('note editor opened as unsaved draft', $('noteEditorWrap').style.display !== 'none' && savedState().sessions.length === 0);

  // V1.8.0: the composed MSE is offered as a one-click insert into the draft
  check('MSE insert offered for the AI draft', $('mseInsertWrap').style.display !== 'none');
  w.insertMseIntoDraft();
  const assessTa = w.document.querySelector('textarea[data-seckey="assessment"]');
  check('MSE insert appends the composed paragraph to the assessment section', !!assessTa && assessTa.value.includes('Mental Status Exam:') && assessTa.value.includes('Pressured speech'));

  // Verify note (V1.7.0): second-pass faithfulness check over the draft.
  // The fake model distinguishes verification prompts by the marker
  // 'VERIFY NOTE AGAINST SOURCE' and answers with the planted verifyOutput.
  check('verify UI exists', typeof w.verifyNote === 'function' && !!$('verifyBtn') && !!$('verifyPanel'));
  check('verify row shown for the AI draft', $('verifyWrap').style.display !== 'none');
  verifyOutput = 'noise<|im_start|>assistant\n[{"quote":"mild improvement in coping","issue":"The source reports stress and poor sleep but never says coping has improved."}]<|im_end|>\nllama_print_timings: total';
  const assessBefore = w.document.querySelector('textarea[data-seckey="assessment"]').value;
  await w.verifyNote();
  check('verify prompt carries the verification marker + the draft', lastPrompt.includes('VERIFY NOTE AGAINST SOURCE') && lastPrompt.includes('mild improvement in coping'));
  await w.verifyPollOnce(); await w.verifyPollOnce();
  check('verify panel lists the planted flag (quote + issue)', $('verifyPanel').innerHTML.includes('mild improvement in coping') && $('verifyPanel').innerHTML.includes('never says coping has improved'));
  check('verification leaves the draft text unchanged', w.document.querySelector('textarea[data-seckey="assessment"]').value === assessBefore && subj.value.includes('poor sleep'));
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
  check('notes table headers render Chinese', $('notesList').innerHTML.includes('日期') && $('notesList').innerHTML.includes('预览'));
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
  check('manual note editor defaults to SOAP sections', !!w.document.querySelector('textarea[data-seckey="subjective"]'));
  $('nFormat').value = 'dap'; w.changeNoteFormat();
  check('switching format re-renders DAP sections', !!w.document.querySelector('textarea[data-seckey="data"]') && !w.document.querySelector('textarea[data-seckey="subjective"]'));
  $('nFormat').value = 'girp'; w.changeNoteFormat();
  check('switching format re-renders GIRP sections', !!w.document.querySelector('textarea[data-seckey="goal"]') && !!w.document.querySelector('textarea[data-seckey="intervention"]') && !!w.document.querySelector('textarea[data-seckey="response"]'));
  $('nFormat').value = 'pirp'; w.changeNoteFormat();
  check('switching format re-renders PIRP sections', !!w.document.querySelector('textarea[data-seckey="problem"]'));
  $('nFormat').value = 'sirp'; w.changeNoteFormat();
  check('switching format re-renders SIRP sections', !!w.document.querySelector('textarea[data-seckey="situation"]'));
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
  check('design tokens: sage accent variable', html.includes('--accent:#5c6f60'));
  check('design tokens: serif display stack variable', html.includes('--font-display:Georgia'));
  check('rust: deprecated whisper main binary is not a candidate', !rustSrc.includes('"main.exe"') && !rustSrc.includes('"main"'));
  check('rust: whisper-cli.exe is the Windows whisper candidate', rustSrc.includes('&["whisper-cli.exe"]'));
  check('rust: engine search honors strict candidate priority', rustSrc.includes('for name in names'));
  check('version V1.9.0 in UI', html.includes('Desktop V1.9.0'));

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
