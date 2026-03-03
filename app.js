// =========================
// Storage Keys
// =========================
const KEY_DB = "rwq_db_v1";           // words
const KEY_WRONG = "rwq_wrong_v1";     // wrong notes
const KEY_RUN = "rwq_run_v1";         // current run state
const KEY_SETTINGS = "rwq_settings_v1";

// 앱/캐시 리비전 (SW/seed 캐시 무효화에 사용)
const APP_REV = "v5";

// =========================
// Helpers
// =========================
const el = (id) => document.getElementById(id);

let speakNowBtn = null;

function ensureModeSelectUI(){
  // index.html에 modeSelect가 없으면 app.js에서 자동으로 추가(호환성)
  if (el('modeSelect')) return;
  const scope = el('scopeSelect');
  if (!scope) return;
  const scopeRow = scope.closest('.row');
  if (!scopeRow || !scopeRow.parentElement) return;

  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <label>퀴즈 모드</label>
    <select id="modeSelect">
      <option value="en2ko">영어 → 뜻</option>
      <option value="ko2en">뜻 → 영어</option>
    </select>
  `.trim();

  scopeRow.parentElement.insertBefore(row, scopeRow.nextSibling);
}

function ensureSpeakNowBtnUI(){
  if (speakNowBtn) return;
  const quizBox = el('quizBox');
  const choices = el('choices');
  if (!quizBox || !choices) return;

  const wrap = document.createElement('div');
  wrap.className = 'revealMeta';
  wrap.style.marginTop = '8px';
  wrap.style.justifyContent = 'flex-end';

  speakNowBtn = document.createElement('button');
  speakNowBtn.id = 'speakNowBtn';
  speakNowBtn.className = 'mini';
  speakNowBtn.type = 'button';
  speakNowBtn.textContent = '🔊 다시듣기';
  speakNowBtn.addEventListener('click', () => {
    if (!currentQ) return;
    speakWord(currentQ.word);
  });

  wrap.appendChild(speakNowBtn);
  quizBox.insertBefore(wrap, choices);

  updateSpeakNowBtnUI();
}

function updateSpeakNowBtnUI(){
  if (!speakNowBtn) return;
  const s = loadSettings();
  const enabled = !!currentQ && (currentQ.mode !== "ko2en") && !!s.ttsOn;
  speakNowBtn.disabled = !enabled;
  speakNowBtn.style.opacity = enabled ? '1' : '0.45';
}
const now = () => new Date().toISOString();
const uid = () => Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);

function safeJsonParse(s, fallback){
  try { return JSON.parse(s); } catch { return fallback; }
}

function downloadJson(filename, obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function normalizeWord(w){
  return (w || "").trim();
}

function lowerKey(w){
  return normalizeWord(w).toLowerCase();
}

// =========================
// Tagging (시험용/예문용 자동 구분)
// =========================
// - 예문용: 공백 포함(phrase), 접속사구/전치사구 느낌(단어 2개 이상), 기호 포함
// - 시험용: 단일 단어 위주
function detectTag(word){
  const w = normalizeWord(word);
  if(!w) return "exam";
  const hasSpace = /\s/.test(w);
  const hasPunct = /[~()\/.,;:!?'"-]/.test(w);
  // 접속사구/표현으로 자주 나오는 패턴(확장 가능)
  const looksLikePhrase = hasSpace || hasPunct || /^(because of|due to|owing to|even though|although|in spite of|as soon as|by the time|the moment|as long as|provided that|considering that|given that|seeing that|when in fact|when actually|when the fact is|even if)\b/i.test(w);
  return looksLikePhrase ? "example" : "exam";
}

// =========================
// DB load/save
// =========================
function loadDB(){
  const db = safeJsonParse(localStorage.getItem(KEY_DB), null);
  if(db && Array.isArray(db.items)) return db;
  return { version: 1, items: [] };
}
function saveDB(db){
  localStorage.setItem(KEY_DB, JSON.stringify(db));
}

function loadWrong(){
  const w = safeJsonParse(localStorage.getItem(KEY_WRONG), null);
  if(w && w.map) return w;
  return { version: 1, map: {} }; // map[wordLower] = {word, meaning, wrongCount, lastWrongAt, sessions:[runId...]}
}
function saveWrong(w){
  localStorage.setItem(KEY_WRONG, JSON.stringify(w));
}

function loadRun(){
  return safeJsonParse(localStorage.getItem(KEY_RUN), null);
}
function saveRun(run){
  localStorage.setItem(KEY_RUN, JSON.stringify(run));
}
function clearRun(){
  localStorage.removeItem(KEY_RUN);
}

function loadSettings(){
  const s = safeJsonParse(localStorage.getItem(KEY_SETTINGS), null);
  return s || { ttsOn: true, ttsRate: 1.0, count: 100, scope: "all", quizMode: "en2ko" };
}
function saveSettings(s){
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(s));
}

// =========================
// Seed sync (words.seed.json)
// =========================
async function syncSeed(){
  // seed를 매번 읽어서:
  // 1) seed 단어는 DB에 upsert(뜻 변경 반영)
  // 2) seed에서 삭제된 단어는 DB에서도 제거(단, source=seed 인 것만)
  try{
    const resp = await fetch(`./words.seed.json?rev=${APP_REV}`, { cache: "no-store" });
    if(!resp.ok) throw new Error("seed fetch failed: " + resp.status);

    const js = await resp.json();
    const pairs = Array.isArray(js.pairs) ? js.pairs : [];
    if(!pairs.length) return;

    const report = upsertSeedPairs(pairs);
    console.log("Seed synced:", report);
  }catch(e){
    console.warn("Seed sync skipped:", e);
  }
}

function upsertSeedPairs(pairs){
  const db = loadDB();

  // 현재 seed key set
  const seedMap = new Map(); // keyLower -> {word, meaning}
  for(const p of pairs){
    if(!Array.isArray(p) || p.length < 1) continue;
    const word = normalizeWord(p[0]);
    const meaning = normalizeWord(p[1] || "");
    if(!word) continue;
    seedMap.set(lowerKey(word), { word, meaning });
  }

  let added = 0, updated = 0, removed = 0;

  // index for quick lookup
  const idxByKey = new Map();
  db.items.forEach((it, idx) => idxByKey.set(lowerKey(it.word), idx));

  // add / update (seed source only)
  for(const [k, v] of seedMap.entries()){
    const idx = idxByKey.get(k);
    if(idx === undefined){
      db.items.push({
        id: uid(),
        word: v.word,
        meaning: v.meaning,
        tag: detectTag(v.word),
        createdAt: now(),
        source: "seed"
      });
      added++;
    }else{
      const it = db.items[idx];
      // manual 단어는 건드리지 않음(사용자 수정 보호)
      if(it.source === "seed"){
        const nextWord = v.word;
        const nextMeaning = v.meaning;
        if(it.word !== nextWord || it.meaning !== nextMeaning){
          it.word = nextWord;
          it.meaning = nextMeaning;
          it.tag = detectTag(nextWord);
          updated++;
        }
      }
    }
  }

  // remove: seed에서 사라진 단어는 DB에서도 제거 (source=seed만)
  const beforeLen = db.items.length;
  db.items = db.items.filter(it => {
    if(it.source !== "seed") return true;
    return seedMap.has(lowerKey(it.word));
  });
  removed = beforeLen - db.items.length;

  // wrong note에서도 seed-삭제 단어 정리(오답노트가 남아보이는 문제 방지)
  if(removed > 0){
    const wrong = loadWrong();
    let changedWrong = false;
    for(const k of Object.keys(wrong.map || {})){
      const entry = wrong.map[k];
      const wordLower = lowerKey(entry?.word || k);
      // DB에 없으면 삭제
      if(!db.items.some(it => lowerKey(it.word) === wordLower)){
        delete wrong.map[k];
        changedWrong = true;
      }
    }
    if(changedWrong) saveWrong(wrong);
  }

  saveDB(db);
  refreshHeader();
  renderWordList();
  renderWrongList();

  return { added, updated, removed, seedTotal: seedMap.size };
}

function addPairsToDB(pairs, source="manual"){
  const db = loadDB();
  const existing = new Set(db.items.map(x => lowerKey(x.word)));
  let added = 0;

  for(const p of pairs){
    if(!Array.isArray(p) || p.length < 1) continue;
    const word = normalizeWord(p[0]);
    const meaning = normalizeWord(p[1] || "");
    if(!word) continue;
    const k = lowerKey(word);
    if(existing.has(k)) continue;

    db.items.push({
      id: uid(),
      word,
      meaning,
      tag: detectTag(word),
      createdAt: now(),
      source
    });
    existing.add(k);
    added++;
  }

  saveDB(db);
  refreshHeader();
  renderWordList();
  renderWrongList();
  return added;
}

// =========================
// Input parsers (CSV or ["w","m"] pairs)
// =========================
function parseCSVLines(text){
  // CSV: word,meaning
  const lines = (text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for(const line of lines){
    if(/^word\s*,\s*meaning$/i.test(line)) continue;
    const parts = line.split(",");
    if(parts.length < 1) continue;
    const word = normalizeWord(parts[0]);
    const meaning = normalizeWord(parts.slice(1).join(","));
    if(word) out.push([word, meaning]);
  }
  return out;
}

function parsePairsArray(text){
  // ["word","meaning"], ["word2","meaning2"]
  const out = [];
  const re = /\[\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\]/g;
  let m;
  while((m = re.exec(text)) !== null){
    const w = normalizeWord(m[1]);
    const meaning = normalizeWord(m[2] || "");
    if(w) out.push([w, meaning]);
  }
  return out;
}

function parseAnyToPairs(text){
  const csv = parseCSVLines(text);
  if(csv.length) return csv;
  const pairs = parsePairsArray(text);
  if(pairs.length) return pairs;
  return [];
}

// =========================
// UI: Tabs
// =========================
function setTab(name){
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("show"));
  el(`tab-${name}`).classList.add("show");
}

function wireTabs(){
  document.querySelectorAll(".tab").forEach(b => {
    b.addEventListener("click", () => setTab(b.dataset.tab));
  });
}

// =========================
// TTS (en-US)
// =========================
let ttsVoice = null;
let ttsUnlocked = false;
let autoNextTimer = null;
let currentQ = null; // { mode, correctVal, word, meaning }

function clearAutoNext(){
  if(autoNextTimer){
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }
}

// Mobile(특히 Android Chrome/PWA)에서는 TTS가 "사용자 제스처 이후"에만 재생되거나
// 첫 호출이 무시되는 경우가 있어, 첫 터치/클릭에서 한 번 unlock을 시도한다.
function unlockTTSOnce(){
  if(ttsUnlocked) return;
  if(!('speechSynthesis' in window)) return;
  try{
    speechSynthesis.cancel();
    speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0; // 무음
    u.rate = 1;
    u.lang = 'en-US';
    u.onend = () => { ttsUnlocked = true; };
    u.onerror = () => { ttsUnlocked = true; };
    speechSynthesis.speak(u);
    // 일부 기기에서 onend가 안 뜨는 경우 대비
    setTimeout(() => {
      try{ speechSynthesis.cancel(); }catch{}
      ttsUnlocked = true;
    }, 300);
  }catch(e){
    ttsUnlocked = true;
  }
}

function pickEnUSVoice(){
  const voices = speechSynthesis.getVoices();
  if(!voices || !voices.length) return null;

  // 1) en-US 우선
  let v = voices.find(v => (v.lang || "").toLowerCase().startsWith("en-us"));
  // 2) en 전체 fallback
  if(!v) v = voices.find(v => (v.lang || "").toLowerCase().startsWith("en"));
  return v || null;
}

function speakWord(word){
  const settings = loadSettings();
  if(!settings.ttsOn) return;
  if(!word) return;
  if(!("speechSynthesis" in window)) return;

  // 모바일 첫 재생 안정화
  unlockTTSOnce();

  try{
    // Android에서 cancel 직후 speak가 무시되는 경우가 있어 resume + 짧은 지연
    speechSynthesis.cancel();
    speechSynthesis.resume();

    if(!ttsVoice) ttsVoice = pickEnUSVoice();
    const u = new SpeechSynthesisUtterance(word);
    if(ttsVoice) u.voice = ttsVoice;
    u.lang = (ttsVoice && ttsVoice.lang) ? ttsVoice.lang : "en-US";
    u.rate = Number(settings.ttsRate || 1.0);

    setTimeout(() => {
      try{ speechSynthesis.speak(u); }catch(e){ console.warn('TTS speak failed:', e); }
    }, 80);
  }catch(e){
    console.warn("TTS failed:", e);
  }
}

function initTTS(){
  if(!("speechSynthesis" in window)) return;
  // voices 로딩 타이밍 이슈 대응
  const tryPick = () => { ttsVoice = pickEnUSVoice(); };
  tryPick();
  speechSynthesis.onvoiceschanged = () => tryPick();

  // 사용자 입력 시점에 unlock (모바일 TTS 안정화)
  window.addEventListener('pointerdown', unlockTTSOnce, { once: true });
}

// =========================
// Quiz Engine
// =========================
function sample(arr, n){
  const a = arr.slice();
  for(let i=a.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

function buildQuestionPool(scope, count){
  const db = loadDB();
  const wrong = loadWrong();

  let base = db.items;

  if(scope === "exam") base = base.filter(x => x.tag === "exam");
  if(scope === "example") base = base.filter(x => x.tag === "example");
  if(scope === "wrongOnly"){
    const keys = new Set(Object.keys(wrong.map || {}));
    base = base.filter(x => keys.has(lowerKey(x.word)));
  }

  return sample(base, count);
}

function pickChoices(correctItem, allItems, field){
  // 4지선다: field 기준(meaning 또는 word)
  const f = field || "meaning";
  const correctRaw = correctItem[f];
  const correct = (correctRaw && String(correctRaw).trim())
    ? String(correctRaw).trim()
    : (f === "meaning" ? "(뜻 없음)" : "(단어 없음)");

  const pool = allItems.filter(x => lowerKey(x.word) !== lowerKey(correctItem.word));
  const distractors = sample(pool, 3).map(x => {
    const v = x[f];
    if(v && String(v).trim()) return String(v).trim();
    return (f === "meaning" ? "(뜻 없음)" : "(단어 없음)");
  });

  const options = [correct, ...distractors];

  // shuffle
  for(let i=options.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { options, correct };
}

function newRun(count, scope){
  const db = loadDB();
  const pool = buildQuestionPool(scope, count);

  const run = {
    runId: "RUN-" + Date.now(),
    createdAt: now(),
    countRequested: count,
    scope,
    idx: 0,
    correct: 0,
    wrong: 0,
    pool: pool.map(x => x.id),
    answers: [] // {wordId, word, correctMeaning, chosenMeaning, isCorrect, ts}
  };

  // 최소 방어: 풀 부족하면 count 줄어듦
  run.countActual = pool.length;

  saveRun(run);
  updateRunUI(run);
  updateSpeakNowBtnUI();
  renderQuestion(run);
}

function getItemById(id){
  const db = loadDB();
  return db.items.find(x => x.id === id) || null;
}

function currentItem(run){
  const id = run.pool[run.idx];
  return id ? getItemById(id) : null;
}

function setReveal(isCorrect, correctMeaning, metaText){
  const badge = el("revealBadge");
  badge.textContent = isCorrect ? "정답" : "오답";
  badge.classList.toggle("wrong", !isCorrect);

  el("revealMeaning").textContent = correctMeaning;
  el("revealMeta").textContent = metaText || "";
  el("revealBox").hidden = false;
}

function clearReveal(){
  el("revealBox").hidden = true;
  el("revealMeaning").textContent = "";
  el("revealMeta").textContent = "";
}

function lockChoices(){
  document.querySelectorAll(".choice").forEach(b => b.classList.add("disabled"));
}

function renderQuestion(run){
  clearReveal();
  const item = currentItem(run);
  const db = loadDB();
  const settings = loadSettings();
  const mode = settings.quizMode || "en2ko"; // en2ko | ko2en

  if(!item){
    currentQ = null;
    updateSpeakNowBtnUI();
    el("qWord").textContent = "끝!";
    el("choices").innerHTML = "";
    el("finishBtn").disabled = false;
    updateRunUI(run);
    return;
  }

  // 문제 프롬프트(화면에 보여줄 것)
  const promptText = (mode === "ko2en") ? (item.meaning || "(뜻 없음)") : item.word;
  el("qWord").textContent = promptText;

  // TTS 동작:
  // - en2ko(영어 → 뜻): 자동 발음 + 문제 텍스트 눌러서 다시듣기 가능
  // - ko2en(뜻 → 영어): 발음 모드 OFF (자동/수동 모두 비활성)
  const qEl = el("qWord");
  qEl.onclick = null;
  qEl.style.cursor = "default";
  qEl.title = "";

  const speakBtn = el("speakBtn");
  if (speakBtn){
    const off = (mode === "ko2en");
    speakBtn.textContent = off ? "발음(OFF)" : "다시듣기";
    speakBtn.disabled = off;
    speakBtn.style.opacity = off ? "0.45" : "1";
  }

  if (mode !== "ko2en"){
    speakWord(item.word);

    // ✅ 문제 텍스트를 누르면 다시듣기
    qEl.style.cursor = "pointer";
    qEl.title = "다시듣기";
    qEl.onclick = () => speakWord(item.word);
  }

  const choiceField = (mode === "ko2en") ? "word" : "meaning";
  const { options, correct } = pickChoices(item, db.items, choiceField);

  // 현재 문제 캐시(정답 판정용)
  currentQ = { mode, correctVal: correct, word: item.word, meaning: (item.meaning || "(뜻 없음)"), tag: item.tag };
  updateSpeakNowBtnUI();

  const wrap = el("choices");
  wrap.innerHTML = "";

  options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "choice";
    btn.innerHTML = `<span>${escapeHtml(opt)}</span><span class="tag">${i+1}</span>`;
    btn.addEventListener("click", () => chooseAnswer(opt));
    wrap.appendChild(btn);
  });

  el("finishBtn").disabled = false;
  updateRunUI(run);
}

function chooseAnswer(chosen){
  const run = loadRun();
  if(!run) return;

  const item = currentItem(run);
  if(!item) return;

  const settings = loadSettings();
  const mode = currentQ?.mode || settings.quizMode || "en2ko";
  const correctVal = currentQ?.correctVal ?? (mode === "ko2en" ? item.word : (item.meaning || "(뜻 없음)"));

  const isCorrect = (normalizeWord(chosen) === normalizeWord(correctVal));

  // mark buttons (normalize 비교)
  document.querySelectorAll(".choice").forEach(btn => {
    const raw = btn.textContent.replace(/\s*\d+\s*$/, "").trim();
    if(normalizeWord(raw) === normalizeWord(correctVal)) btn.classList.add("correct");
    if(normalizeWord(raw) === normalizeWord(chosen) && !isCorrect) btn.classList.add("wrong");
  });
  lockChoices();

  const correctMeaning = item.meaning || "(뜻 없음)";

  run.answers.push({
    wordId: item.id,
    word: item.word,
    correctMeaning,
    chosenMeaning: chosen,          // 기존 키 유지(호환)
    isCorrect,
    mode,
    ts: now()
  });

  if(isCorrect) run.correct++;
  else run.wrong++;

  // 누적 오답 기록
  if(!isCorrect){
    const wrong = loadWrong();
    const k = lowerKey(item.word);
    if(!wrong.map[k]){
      wrong.map[k] = {
        word: item.word,
        meaning: correctMeaning,
        wrongCount: 0,
        lastWrongAt: null,
        sessions: []
      };
    }
    wrong.map[k].wrongCount += 1;
    wrong.map[k].lastWrongAt = now();
    if(!wrong.map[k].sessions.includes(run.runId)) wrong.map[k].sessions.push(run.runId);
    saveWrong(wrong);
  }

  saveRun(run);

  // ✅ 정답/오답 박스에는 항상 (영어 + 뜻) 표시
  const revealLine = `정답: ${item.word}  |  뜻: ${correctMeaning}`;

  setReveal(
    isCorrect,
    revealLine,
    `${item.tag === "exam" ? "시험용" : "예문용"} · ${run.idx+1}/${run.countActual}`
  );
  updateRunUI(run);
  renderWrongList();

  // ✅ 보기 선택 후 자동 다음 문제
  clearAutoNext();
  autoNextTimer = setTimeout(() => {
    autoNextTimer = null;
    nextQuestion();
  }, 450);
}

function nextQuestion(){
  clearAutoNext();
  const run = loadRun();
  if(!run) return;

  run.idx += 1;
  saveRun(run);
  updateRunUI(run);
  renderQuestion(run);
}

function markDontKnow(){
  // 모르겠음 = 오답 처리
  const run = loadRun();
  if(!run) return;

  const item = currentItem(run);
  if(!item) return;

  chooseAnswer("모르겠음"); // 의도적으로 정답과 불일치
}

function finishRun(){
  const run = loadRun();
  if(!run) return;
  // 끝까지 갔든, 중간 종료든 결과 표시
  showRunReport();
}

function resetCurrentRun(){
  clearRun();
  currentQ = null;
  updateSpeakNowBtnUI();
  updateRunUI(null);
  el("qWord").textContent = "시작을 누르세요";
  el("choices").innerHTML = "";
  clearReveal();
  el("finishBtn").disabled = true;
  el("resumeBtn").disabled = true;
  el("runReport").hidden = true;
}

// =========================
// Reports
// =========================
function showRunReport(){
  const run = loadRun();
  if(!run) return;

  const box = el("runReport");
  box.hidden = false;

  const rows = run.answers.map((a, idx) => {
    const ok = a.isCorrect;
    const w = escapeHtml(a.word);
    return `
      <tr>
        <td>${idx+1}</td>
        <td>
          <span class="sayword" data-say="${w}" style="cursor:pointer; text-decoration:underline; font-weight:900;">${w}</span>
          <button class="mini" type="button" title="발음" data-say="${w}" style="margin-left:8px;">🔊</button>
        </td>
        <td>${escapeHtml(a.correctMeaning)}</td>
        <td>${escapeHtml(a.chosenMeaning)}</td>
        <td class="${ok ? "good" : "bad"}">${ok ? "O" : "X"}</td>
      </tr>
    `;
  }).join("");

  box.innerHTML = `
    <div class="inline" style="justify-content:space-between; margin-bottom:10px;">
      <div>
        <div><b>${run.runId}</b></div>
        <div class="muted">${run.scope} · ${run.countActual}문항 · 정답 ${run.correct} / 오답 ${run.wrong}</div>
      </div>
    </div>
    <div class="reportTable">
      <table>
        <thead>
          <tr>
            <th>#</th><th>단어</th><th>정답</th><th>선택</th><th>결과</th>
          </tr>
        </thead>
        <tbody>${rows || ""}</tbody>
      </table>
    </div>
  `;

  // ✅ 결과표(결과보기)에서 단어를 클릭하면 발음
  box.querySelectorAll("[data-say]").forEach((node) => {
    node.addEventListener("click", () => {
      unlockTTSOnce();
      speakWord(node.dataset.say);
    });
  });
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// =========================
// Word list + Wrong list
// =========================
function refreshHeader(){
  const db = loadDB();
  const exam = db.items.filter(x => x.tag === "exam").length;
  const example = db.items.filter(x => x.tag === "example").length;
  el("dbStats").textContent = `DB: ${db.items.length}개 (시험용 ${exam} / 예문용 ${example})`;
}

function renderWordList(){
  const db = loadDB();
  const q = (el("listSearch")?.value || "").trim().toLowerCase();
  const filter = el("listFilter")?.value || "all";

  let items = db.items.slice();
  if(filter === "exam") items = items.filter(x => x.tag === "exam");
  if(filter === "example") items = items.filter(x => x.tag === "example");

  if(q){
    items = items.filter(x =>
      (x.word || "").toLowerCase().includes(q) ||
      (x.meaning || "").toLowerCase().includes(q)
    );
  }

  const wrap = el("wordList");
  wrap.innerHTML = "";

  if(!items.length){
    wrap.innerHTML = `<div class="muted">표시할 단어가 없습니다.</div>`;
    return;
  }

  items
    .sort((a,b) => a.word.localeCompare(b.word))
    .slice(0, 1500) // 너무 많아지면 렌더 부담 방지
    .forEach(item => {
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML = `
        <div>
          <div class="w">${escapeHtml(item.word)}</div>
          <div class="m">${escapeHtml(item.meaning || "")}</div>
          <div class="meta">${escapeHtml(item.tag)} · ${escapeHtml(item.source || "")}</div>
        </div>
        <div class="right">
          <span class="pill">${item.tag === "exam" ? "시험용" : "예문용"}</span>
          <button class="mini" title="발음" data-say="${escapeHtml(item.word)}">🔊</button>
        </div>
      `;
      div.querySelector("button[data-say]").addEventListener("click", () => speakWord(item.word));
      wrap.appendChild(div);
    });
}

function renderWrongList(){
  const wrong = loadWrong();
  const q = (el("wrongSearch")?.value || "").trim().toLowerCase();
  const sort = el("wrongSort")?.value || "countDesc";

  let items = Object.values(wrong.map || {});

  if(q){
    items = items.filter(x =>
      (x.word || "").toLowerCase().includes(q) ||
      (x.meaning || "").toLowerCase().includes(q)
    );
  }

  if(sort === "countDesc") items.sort((a,b) => (b.wrongCount||0)-(a.wrongCount||0));
  if(sort === "recentDesc") items.sort((a,b) => String(b.lastWrongAt||"").localeCompare(String(a.lastWrongAt||"")));
  if(sort === "alphaAsc") items.sort((a,b) => (a.word||"").localeCompare(b.word||""));

  const wrap = el("wrongList");
  wrap.innerHTML = "";

  if(!items.length){
    wrap.innerHTML = `<div class="muted">오답 기록이 없습니다.</div>`;
    return;
  }

  items.forEach(x => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div>
        <div class="w">${escapeHtml(x.word)}</div>
        <div class="m">${escapeHtml(x.meaning || "")}</div>
        <div class="meta">오답 ${x.wrongCount}회 · 최근 ${escapeHtml(x.lastWrongAt || "-")} · 회차 ${escapeHtml((x.sessions||[]).length)}</div>
      </div>
      <div class="right">
        <span class="pill">오답 ${x.wrongCount}</span>
        <button class="mini" title="발음">🔊</button>
      </div>
    `;
    div.querySelector("button.mini").addEventListener("click", () => speakWord(x.word));
    wrap.appendChild(div);
  });
}

// =========================
// Settings UI
// =========================
function applySettingsToUI(){
  const s = loadSettings();

  // count seg
  document.querySelectorAll("#countSeg .segbtn").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.count) === Number(s.count));
  });

  el("scopeSelect").value = s.scope || "all";
  el("ttsToggle").checked = !!s.ttsOn;

  el("ttsRate").value = String(s.ttsRate ?? 1.0);
  el("ttsRateVal").textContent = Number(s.ttsRate ?? 1.0).toFixed(2);

  const modeSel = el("modeSelect");
  if(modeSel) modeSel.value = s.quizMode || "en2ko";
}


function wireSettings(){
  document.querySelectorAll("#countSeg .segbtn").forEach(b => {
    b.addEventListener("click", () => {
      const s = loadSettings();
      s.count = Number(b.dataset.count);
      saveSettings(s);
      applySettingsToUI();
    });
  });

  el("scopeSelect").addEventListener("change", () => {
    const s = loadSettings();
    s.scope = el("scopeSelect").value;
    saveSettings(s);
  });

  el("ttsToggle").addEventListener("change", () => {
    const s = loadSettings();
    s.ttsOn = el("ttsToggle").checked;
    saveSettings(s);
  });

  el("ttsRate").addEventListener("input", () => {
    const s = loadSettings();
    s.ttsRate = Number(el("ttsRate").value);
    saveSettings(s);
    el("ttsRateVal").textContent = Number(s.ttsRate).toFixed(2);
  });

  const modeSel = el("modeSelect");
  if(modeSel){
    modeSel.addEventListener("change", () => {
      const s = loadSettings();
      s.quizMode = modeSel.value;
      saveSettings(s);
    });
  }
}


// =========================
// Run UI
// =========================
function updateRunUI(run){
  if(!run){
    el("runId").textContent = "-";
    el("progress").textContent = "0 / 0";
    el("correctCnt").textContent = "0";
    el("wrongCnt").textContent = "0";
    return;
  }
  // 회차 표시를 보기 좋게(타임스탬프 숫자 대신 날짜/시간)
  try{
    const dt = new Date(run.createdAt);
    el("runId").textContent = `RUN · ${dt.toLocaleString()}`;
  }catch{
    el("runId").textContent = run.runId;
  }
  el("progress").textContent = `${Math.min(run.idx+1, run.countActual)} / ${run.countActual}`;
  el("correctCnt").textContent = String(run.correct);
  el("wrongCnt").textContent = String(run.wrong);

  el("resumeBtn").disabled = false;
}

function wireQuizButtons(){
  el("startBtn").addEventListener("click", () => {
    unlockTTSOnce();
    const s = loadSettings();
    newRun(Number(s.count), s.scope);
    el("runReport").hidden = true;
  });

  el("resumeBtn").addEventListener("click", () => {
    unlockTTSOnce();
    const run = loadRun();
    if(!run) return;
    renderQuestion(run);
  });

  el("resetRunBtn").addEventListener("click", () => {
    if(confirm("현재 회차를 초기화할까요?")) resetCurrentRun();
  });

  el("skipBtn").addEventListener("click", () => markDontKnow());
  el("finishBtn").addEventListener("click", () => finishRun());

  el("showRunReportBtn").addEventListener("click", () => showRunReport());

  el("exportRunBtn").addEventListener("click", () => {
    const run = loadRun();
    if(!run) return alert("저장된 회차가 없습니다.");
    downloadJson(`${run.runId}.json`, run);
  });

  el("speakBtn").addEventListener("click", () => {
    unlockTTSOnce();
    const run = loadRun();
    if(!run) return;
    const item = currentItem(run);
    if(!item) return;
    speakWord(item.word);
  });

  // ✅ 뜻(정답)을 클릭하면 다음 문제로 이동
  el("revealMeaning").addEventListener("click", () => nextQuestion());
}

// =========================
// Add words UI
// =========================
function wireAdd(){
  el("addBtn").addEventListener("click", () => {
    const text = (el("addInput").value || "").trim();
    if(!text) return;

    const pairs = parseAnyToPairs(text);
    if(!pairs.length){
      el("addResult").textContent = "형식을 인식하지 못했어요. CSV 또는 [\"word\",\"meaning\"] 형태로 넣어주세요.";
      return;
    }
    const added = addPairsToDB(pairs, "manual");
    el("addResult").textContent = `추가 완료: ${added}개 (중복 제외)`;
  });

  el("clearAddBtn").addEventListener("click", () => {
    el("addInput").value = "";
    el("addResult").textContent = "";
  });
}

// =========================
// Export / Import (backup)
// =========================
function wireBackup(){
  el("exportWordsBtn").addEventListener("click", () => downloadJson("words-db.json", loadDB()));
  el("exportWrongBtn").addEventListener("click", () => downloadJson("wrong-notes.json", loadWrong()));

  el("exportAllBtn").addEventListener("click", () => {
    const pack = {
      exportedAt: now(),
      db: loadDB(),
      wrong: loadWrong(),
      run: loadRun(),
      settings: loadSettings()
    };
    downloadJson(`rwq-backup-${Date.now()}.json`, pack);
  });

  el("importFile").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if(!f) return;
    try{
      const text = await f.text();
      const pack = JSON.parse(text);

      if(pack.db?.items) saveDB(pack.db);
      if(pack.wrong?.map) saveWrong(pack.wrong);
      if(pack.run) saveRun(pack.run);
      if(pack.settings) saveSettings(pack.settings);

      refreshHeader();
      renderWordList();
      renderWrongList();
      applySettingsToUI();

      el("backupMsg").textContent = "복원 완료!";
    }catch(err){
      el("backupMsg").textContent = "복원 실패: JSON 형식이 올바른지 확인하세요.";
    }finally{
      e.target.value = "";
    }
  });

  el("wipeWordsBtn").addEventListener("click", () => {
    if(confirm("단어DB를 완전히 초기화할까요? (되돌릴 수 없음)")){
      saveDB({version:1, items:[]});
      refreshHeader();
      renderWordList();
      alert("단어DB 초기화 완료");
    }
  });

  el("wipeWrongBtn").addEventListener("click", () => {
    if(confirm("오답노트를 완전히 초기화할까요? (되돌릴 수 없음)")){
      saveWrong({version:1, map:{}});
      renderWrongList();
      alert("오답노트 초기화 완료");
    }
  });
}

// =========================
// Search wires
// =========================
function wireSearch(){
  el("listSearch").addEventListener("input", () => renderWordList());
  el("listFilter").addEventListener("change", () => renderWordList());

  el("wrongSearch").addEventListener("input", () => renderWrongList());
  el("wrongSort").addEventListener("change", () => renderWrongList());
}

// =========================
// Service Worker register
// =========================
async function registerSW(){
  if(!("serviceWorker" in navigator)) return;
  try{
    // ✅ query 붙여서 브라우저가 sw.js를 '새 파일'로 인식하게 함(캐시 문제 완화)
    const reg = await navigator.serviceWorker.register(`./sw.js?rev=${APP_REV}`);

    // 가능하면 즉시 업데이트 체크
    try{ await reg.update(); }catch{}

    // 새 SW가 컨트롤러로 전환되면 자동 새로고침(업데이트 적용)
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.location.reload();
    });
  }catch(e){
    console.warn("SW register failed:", e);
  }
}

// =========================
// Init
// =========================
async function init(){
  wireTabs();
  initTTS();

  // ensure UI parts (호환성)
  ensureModeSelectUI();
  ensureSpeakNowBtnUI();

  // settings UI
  applySettingsToUI();
  wireSettings();

  // seed sync
  await syncSeed();

  // render initial
  refreshHeader();
  renderWordList();
  renderWrongList();

  // restore run
  const run = loadRun();
  if(run){
    updateRunUI(run);
    el("resumeBtn").disabled = false;
  }else{
    el("finishBtn").disabled = true;
  }

  // wires
  wireQuizButtons();
  wireAdd();
  wireBackup();
  wireSearch();

  // tts rate display
  el("ttsRateVal").textContent = Number(loadSettings().ttsRate ?? 1.0).toFixed(2);

  // PWA
  await registerSW();
}

init();
