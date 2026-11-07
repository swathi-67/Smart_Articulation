/* =====================================================================
   SMART ARTICULATION TRAINING SYSTEM — Full Stack Version
   Gmail OTP auth · Doctor assignment · Video submissions · Expanded syllabus
   Same theme, same UX — now with a real backend.
===================================================================== */

const API = '';  // same-origin; empty string means requests go to the same server

/* ---------------------------- STATE ---------------------------- */
const state = {
  view: 'landing',
  role: null,
  lang: 'en',
  token: null,
  user: null,
  doctor: null,
  consent: false,
  showConsentModal: false,
  sounds: [],           // loaded from API
  currentSoundId: null,
  currentLevel: null,
  activeLearnerId: null,
  rec: { active: false, transcript: '', lastResult: null },
  camera: {
    enabled: false, consent: false, showConsentModal: false,
    stage: 'off', privacyMode: 'emoji',
    guide: { x: 50, y: 42, size: 62 },
    baseline: null, runningMax: { variance: 1, width: 1 },
    metrics: { aperture: 0, width: 0 }, recSamples: null, stream: null, rafId: null, error: null,
  },
  // OTP flow
  otpFlow: { step: 'email', email: '', name: '', role: 'learner', doctorEmail: '', loading: false, error: '', timer: 0, timerInterval: null },
  // video recording
  videoFlow: { recording: false, stream: null, recorder: null, chunks: [], blob: null, url: null, analysisFrames: [], liveRAF: null },
  // doctor view
  doctorLearners: [],
  doctorActiveLearner: null,
  // progress
  progress: [],
  attempts: [],
  videoSubmissions: [],
};

/* ---------------------------- UTILITIES ---------------------------- */
function avg(arr) { if (!arr || !arr.length) return 0; return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length); }
function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function esc(str) { return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* Sound-level helpers (same as original) */
const SOUND_ALIASES = {
  r: ['r', 'are', 'ar', 'arr', 'er', 'err', 'or', 'our', 'rrrr'],
  l: ['l', 'el', 'ell', 'al', 'all', 'ill', 'eel'],
  s: ['s', 'ess', 'es', 'ss', 'sss', 'hiss'],
  sh: ['sh', 'shh', 'shoe', 'she', 'sure'],
  ch: ['ch', 'tch', 'che', 'chee', 'chair'],
  th: ['th', 'the', 'they', 'this', 'think'],
  k: ['k', 'kay', 'okay', 'ca', 'key'],
  g: ['g', 'gee', 'gee', 'go'],
  f: ['f', 'eff', 'ef'],
  v: ['v', 'vee', 'ev'],
  p: ['p', 'pee', 'pea'],
  b: ['b', 'bee', 'be'],
  t: ['t', 'tee', 'te'],
  d: ['d', 'dee', 'de'],
  n: ['n', 'en', 'enn'],
  m: ['m', 'em', 'emm'],
  w: ['w', 'double u', 'we'],
  y: ['y', 'why', 'ye'],
  z: ['z', 'zee', 'zed', 'z'],
  h: ['h', 'aitch', 'ache'],
};

function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const dp = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function normalizeSpeechText(str) {
  return String(str || '').toLowerCase().replace(/['`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\b(uh|um|erm|hmm|mmm)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function charBigrams(str) {
  str = normalizeSpeechText(str).replace(/\s+/g, '');
  if (str.length < 2) return str ? [str] : [];
  const out = []; for (let i = 0; i < str.length - 1; i++) out.push(str.slice(i, i + 2)); return out;
}
function diceSimilarity(a, b) {
  const A = charBigrams(a), B = charBigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map(); A.forEach(x => counts.set(x, (counts.get(x) || 0) + 1));
  let hits = 0; B.forEach(x => { const n = counts.get(x) || 0; if (n > 0) { hits++; counts.set(x, n - 1); } });
  return (2 * hits) / (A.length + B.length);
}
function similarityScore(target, heard) {
  const t = normalizeSpeechText(target), h = normalizeSpeechText(heard);
  if (!h) return 0; if (t === h) return 100;
  const dist = levenshtein(t, h); const maxLen = Math.max(t.length, h.length, 1);
  const levScore = clamp((1 - dist / maxLen) * 100, 0, 100);
  const diceScore = diceSimilarity(t, h) * 100;
  let containment = 0;
  if (t && h && (h.includes(t) || t.includes(h))) { containment = 72 + Math.min(t.length, h.length) / Math.max(t.length, h.length) * 24; }
  return clamp(Math.round(Math.max(levScore * 0.55 + diceScore * 0.45, containment)), 0, 100);
}
function tokenOverlapScore(target, heard) {
  const t = normalizeSpeechText(target).split(/\s+/).filter(Boolean);
  const h = normalizeSpeechText(heard).split(/\s+/).filter(Boolean);
  if (!t.length || !h.length) return 0;
  let matched = 0; t.forEach(tw => { let best = 0; h.forEach(hw => { best = Math.max(best, similarityScore(tw, hw)); }); if (best >= 74) matched++; });
  return Math.round((matched / t.length) * 100);
}
function candidateTranscripts(res) {
  const list = [];
  if (res && res.transcript) list.push(res.transcript);
  if (res && Array.isArray(res.alternatives)) res.alternatives.forEach(a => { if (a && a.transcript) list.push(a.transcript); });
  return [...new Set(list.map(x => String(x || '').trim()).filter(Boolean))];
}
function scoreSoundLevel(sound, candidates) {
  const aliases = (SOUND_ALIASES[sound.id] || [sound.label, sound.symbol]).map(normalizeSpeechText).filter(Boolean);
  const letter = normalizeSpeechText(sound.label);
  let best = 0;
  candidates.forEach(c => {
    const h = normalizeSpeechText(c); const compact = h.replace(/\s+/g, ''); const tokens = h.split(/\s+/).filter(Boolean);
    aliases.forEach(alias => {
      const ac = alias.replace(/\s+/g, '');
      if (tokens.includes(alias) || compact === ac || compact === ac.repeat(2) || compact === ac.repeat(3)) best = Math.max(best, 94);
      if (ac.length > 1 && compact.includes(ac)) best = Math.max(best, 86);
      best = Math.max(best, similarityScore(alias, h));
    });
    if (letter.length === 1 && compact.includes(letter)) { const density = compact.split(letter).length - 1; best = Math.max(best, clamp(54 + density * 8 - Math.max(0, compact.length - 4) * 2, 42, 78)); }
    if (h) best = Math.max(best, 18 + Math.min(22, compact.length * 2));
  });
  return clamp(Math.round(best), 0, 100);
}
function assessAudioAttempt(target, res, sound, level) {
  const candidates = candidateTranscripts(res);
  if (!candidates.length) return { score: 0, transcript: '' };
  if (level === 'sound') {
    const score = scoreSoundLevel(sound, candidates);
    let bestTranscript = candidates[0], bestLocal = -1;
    candidates.forEach(c => { const sc = scoreSoundLevel(sound, [c]); if (sc > bestLocal) { bestLocal = sc; bestTranscript = c; } });
    return { score, transcript: bestTranscript };
  }
  let bestScore = 0, bestTranscript = candidates[0];
  candidates.forEach(c => {
    let sc = similarityScore(target, c);
    const tNorm = normalizeSpeechText(target), hNorm = normalizeSpeechText(c);
    if (level === 'word') { const hTokens = hNorm.split(/\s+/); if (hTokens.includes(tNorm)) sc = Math.max(sc, 98); else if (hNorm.includes(tNorm) || tNorm.includes(hNorm)) sc = Math.max(sc, 86); }
    if (level === 'sentence') { sc = Math.round(sc * 0.65 + tokenOverlapScore(target, c) * 0.35); }
    if (hNorm && sc < 22) sc = 22;
    if (sc > bestScore) { bestScore = sc; bestTranscript = c; }
  });
  return { score: clamp(Math.round(bestScore), 0, 100), transcript: bestTranscript };
}
function wordLevelBreakdown(targetSentence, heard) {
  const targetWords = normalizeSpeechText(targetSentence).split(/\s+/).filter(Boolean);
  const heardWords = normalizeSpeechText(heard).split(/\s+/).filter(Boolean);
  return targetWords.map(tw => { let best = 0; heardWords.forEach(hw => { best = Math.max(best, similarityScore(tw, hw)); }); return { word: tw, ok: best >= 68 }; });
}

/* ---------------------------- API HELPERS ---------------------------- */
async function apiGet(path) {
  const headers = state.token ? { 'Authorization': `Bearer ${state.token}` } : {};
  const res = await fetch(API + path, { headers });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  return res.json();
}
async function apiPost(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(API + path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  return res.json();
}
async function apiUpload(path, formData) {
  const headers = {};
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(API + path, { method: 'POST', headers, body: formData });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  return res.json();
}

/* ---------------------------- TOASTS ---------------------------- */
function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) { container = document.createElement('div'); container.className = 'toast-container'; document.body.appendChild(container); }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️'} ${esc(message)}`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

/* ---------------------------- SOUND DATA HELPERS ---------------------------- */
function SOUND_MAP() { const m = {}; state.sounds.forEach(s => m[s.sound_id] = s); return m; }
function getSound(id) { return state.sounds.find(s => s.sound_id === id); }

/* ---------------------------- SPEECH: recognition + TTS + waveform ---------------------------- */
const SpeechRecCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null, audioCtx = null, analyser = null, micStream = null, waveRAF = null;

function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92; u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  } catch (e) { }
}

function startWave(canvas, stream) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const ctx = canvas.getContext('2d');
    function draw() {
      waveRAF = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barW = canvas.width / data.length;
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary');
      for (let i = 0; i < data.length; i++) { const h = (data[i] / 255) * canvas.height; ctx.fillRect(i * barW, canvas.height - h, barW * 0.7, h); }
    }
    draw();
  } catch (e) { }
}
function stopWave() { if (waveRAF) cancelAnimationFrame(waveRAF); waveRAF = null; if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; } }

function describeSpeechError(code) {
  switch (code) {
    case 'not-allowed': case 'service-not-allowed': return "Microphone permission was denied. Please allow microphone access and try again.";
    case 'audio-capture': return "No microphone was found on this device.";
    case 'network': return "A network error interrupted speech recognition — check your connection.";
    case 'no-speech': return "Didn't catch any speech — try again closer to the mic.";
    default: return "Something went wrong accessing the microphone.";
  }
}

function beginRecording(targetText, onDone) {
  state.rec.active = true; state.rec.transcript = ''; render();
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      micStream = stream;
      const canvas = document.getElementById('liveWave');
      if (canvas) startWave(canvas, stream);
    }).catch(() => { });
  }
  if (!SpeechRecCtor) {
    setTimeout(() => { state.rec.active = false; stopWave(); onDone({ transcript: '(speech recognition unavailable)', confidence: null, unsupported: true }); render(); }, 1400);
    return;
  }
  try {
    recognizer = new SpeechRecCtor();
    recognizer.lang = state.lang === 'ta' ? 'ta-IN' : 'en-US';
    recognizer.interimResults = true; recognizer.maxAlternatives = 5;
    let finalTranscript = '', finalAlternatives = [], bestConfidence = null;
    recognizer.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) { finalTranscript += (r[0].transcript + ' '); for (let j = 0; j < r.length; j++) finalAlternatives.push({ transcript: r[j].transcript, confidence: r[j].confidence }); if (r[0] && typeof r[0].confidence === 'number') bestConfidence = r[0].confidence; }
        else interim += r[0].transcript;
      }
      state.rec.transcript = (finalTranscript + ' ' + interim).trim();
      renderTranscriptOnly();
    };
    recognizer.onerror = (e) => { state.rec.active = false; stopWave(); onDone({ transcript: finalTranscript || state.rec.transcript, confidence: bestConfidence, alternatives: finalAlternatives, error: true, errorMessage: describeSpeechError(e && e.error) }); render(); };
    recognizer.onend = () => { if (!state.rec.active) return; state.rec.active = false; stopWave(); if (!finalAlternatives.length && state.rec.transcript) finalAlternatives.push({ transcript: state.rec.transcript, confidence: bestConfidence }); onDone({ transcript: (finalTranscript || state.rec.transcript).trim(), confidence: bestConfidence, alternatives: finalAlternatives }); render(); };
    recognizer.start();
  } catch (e) { state.rec.active = false; stopWave(); onDone({ transcript: '', confidence: null, error: true, errorMessage: "Speech recognition failed to start." }); render(); }
}
function endRecording() { try { recognizer && recognizer.stop(); } catch (e) { } }
function renderTranscriptOnly() { const el = document.getElementById('liveTranscript'); if (el) el.textContent = state.rec.transcript ? ('"' + state.rec.transcript + '"') : ''; }

/* ---------------------------- MOUTH DIAGRAM SVG ---------------------------- */
function mouthDiagramSVG(sound, opts = {}) {
  const showLabels = opts.showLabels !== false;
  const voiced = sound.voicing === 'Voiced' || sound.voicing === 'Both';
  const tongueTarget = sound.tongue_target || 'translate(0,0) rotate(0deg)';
  return `
  <svg class="mouth-svg" viewBox="0 0 420 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Side-view diagram for ${esc(sound.label)}">
    <path d="M300,60 C360,80 370,150 355,210 C345,255 320,275 300,300 C285,320 260,330 230,330 L215,300 C185,296 150,286 120,262 C95,242 78,215 72,190 C66,165 70,140 90,120 C95,110 92,100 100,92 C112,80 118,95 128,90 C140,84 150,66 175,58 C215,46 265,46 300,60 Z" fill="#FBEFE6" stroke="#E8CDB4" stroke-width="2"/>
    <ellipse cx="320" cy="160" rx="14" ry="20" fill="#F6DFC9" stroke="#E8CDB4" stroke-width="2"/>
    <path d="M72,190 C90,205 95,225 118,238 C110,215 108,198 118,182 C100,178 84,180 72,190 Z" fill="#7A4438" opacity="0.18"/>
    <path d="M120,182 C150,168 190,160 230,164" fill="none" stroke="#C98F72" stroke-width="4" stroke-linecap="round"/>
    <path class="jaw-line" d="M118,238 C150,258 190,262 224,258" fill="none" stroke="#C98F72" stroke-width="4" stroke-linecap="round"/>
    <rect x="112" y="184" width="26" height="10" rx="2" fill="#fff" stroke="#D8C6B8"/>
    <rect x="112" y="222" width="26" height="10" rx="2" fill="#fff" stroke="#D8C6B8"/>
    <path class="upper-lip" d="M96,196 C104,190 112,190 120,195" fill="none" stroke="#D97B63" stroke-width="8" stroke-linecap="round"/>
    <path class="lower-lip" d="M96,222 C104,230 112,230 120,224" fill="none" stroke="#D97B63" stroke-width="8" stroke-linecap="round"/>
    <path class="tongue-shape" id="tongueShape" style="--tongue-target:${tongueTarget}" d="M128,232 C150,238 178,236 198,224 C210,216 214,204 208,194 C200,182 176,180 156,186 C138,192 122,204 120,216 C119,222 122,228 128,232 Z" fill="#E8757A" stroke="#C85862" stroke-width="2"/>
    <g class="movement-arrow ${opts.showAirflow ? 'show' : ''}"><path d="M60,205 C40,205 30,205 14,205" stroke="#0F7A72" stroke-width="3" fill="none" marker-end="url(#arrowhead)"/></g>
    <g class="voicing-wave ${(opts.playing && voiced) ? 'on' : ''}" transform="translate(300,180)">
      <rect x="-4" y="-14" width="6" height="28" rx="3" fill="#0F7A72"/><rect x="8" y="-20" width="6" height="40" rx="3" fill="#0F7A72"/><rect x="20" y="-10" width="6" height="20" rx="3" fill="#0F7A72"/>
    </g>
    <defs><marker id="arrowhead" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#0F7A72"/></marker></defs>
    <g class="diagram-labels ${showLabels ? '' : 'hidden'}">
      <line x1="160" y1="205" x2="200" y2="150" stroke="#6B8B87" stroke-width="1.5" stroke-dasharray="3,3"/>
      <text class="leader-label" x="196" y="145">Tongue</text>
      <line x1="108" y1="209" x2="60" y2="120" stroke="#6B8B87" stroke-width="1.5" stroke-dasharray="3,3"/>
      <text class="leader-label" x="30" y="112">Lips</text>
      <line x1="125" y1="189" x2="170" y2="100" stroke="#6B8B87" stroke-width="1.5" stroke-dasharray="3,3"/>
      <text class="leader-label" x="140" y="94">Teeth</text>
      <line x1="150" y1="250" x2="200" y2="310" stroke="#6B8B87" stroke-width="1.5" stroke-dasharray="3,3"/>
      <text class="leader-label" x="182" y="326">Jaw</text>
    </g>
  </svg>`;
}

/* ---------------------------- MASCOT ---------------------------- */
function mascotSVG(pose, size) {
  size = size || 88;
  const cheer = pose === 'cheer';
  const wing = cheer ? 'M92,58 C108,44 116,50 112,64 C108,78 96,80 90,72 Z' : 'M92,66 C106,66 110,80 100,88 C92,94 84,86 86,76 Z';
  return `<svg viewBox="0 0 120 130" width="${size}" height="${Math.round(size * 1.08)}" role="img" aria-label="Echo mascot">
    <ellipse cx="60" cy="120" rx="24" ry="5" fill="rgba(15,46,43,.10)"/>
    <path d="M60,20 C86,20 100,44 96,70 C93,92 78,110 60,110 C42,110 27,92 24,70 C20,44 34,20 60,20 Z" fill="#0F7A72"/>
    <ellipse cx="60" cy="76" rx="23" ry="25" fill="#FF8A5B"/>
    <path d="${wing}" fill="#0A5A53"/>
    <path d="M52,18 C50,8 58,6 60,14 M62,16 C64,6 72,8 68,18" stroke="#0A5A53" stroke-width="5" fill="none" stroke-linecap="round"/>
    <circle cx="70" cy="46" r="7" fill="#0F2E2B"/><circle cx="72.4" cy="43.6" r="2" fill="#fff"/>
    <circle cx="55" cy="55" r="5" fill="#FFC857" opacity=".75"/>
    <path d="M84,50 C94,50 96,56 88,60 C82,63 78,58 80,52 Z" fill="#FFC857"/>
    <path d="M50,106 L46,116 M70,106 L74,116" stroke="#E86E3C" stroke-width="4" stroke-linecap="round"/>
  </svg>`;
}

function triggerConfetti() {
  try {
    const colors = ['#0F7A72', '#FF8A5B', '#FFC857', '#2E9E6C', '#E86E3C'];
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:200;overflow:hidden;';
    for (let i = 0; i < 28; i++) {
      const p = document.createElement('div'); const size = 6 + Math.random() * 6;
      p.style.cssText = `position:absolute;top:-20px;left:${Math.random() * 100}%;width:${size}px;height:${size * 0.4}px;background:${colors[i % colors.length]};opacity:.9;border-radius:2px;transform:rotate(${Math.random() * 360}deg);animation:confettiFall ${1.1 + Math.random() * 0.7}s ease-in ${Math.random() * 0.25}s forwards;`;
      holder.appendChild(p);
    }
    document.body.appendChild(holder); setTimeout(() => holder.remove(), 2200);
  } catch (e) { }
}

/* ---------------------------- CHARTS ---------------------------- */
function drawBarChart(canvas, labels, values, max = 100) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0, 0, w, h);
  const pad = 36 * 2, barGap = 18 * 2;
  const barW = (w - pad - (values.length) * barGap) / values.length;
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  values.forEach((v, i) => {
    const bh = (v / max) * (h - 70 * 2);
    const x = pad / 2 + i * (barW + barGap); const y = h - 50 * 2 - bh;
    ctx.fillStyle = v >= 80 ? primary : accent;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, barW, bh, [8, 8, 0, 0]) : ctx.rect(x, y, barW, bh); ctx.fill();
    ctx.fillStyle = '#3E5C58'; ctx.font = '22px Space Mono'; ctx.textAlign = 'center';
    ctx.fillText(labels[i], x + barW / 2, h - 18 * 2);
    ctx.font = 'bold 22px Space Mono'; ctx.fillText(v + '%', x + barW / 2, y - 10);
  });
}
function drawLineChart(canvas, values) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) { ctx.fillStyle = '#6B8B87'; ctx.font = '22px Atkinson Hyperlegible'; ctx.fillText('Practice a bit more to see your trend line.', 20, h / 2); return; }
  const pad = 30 * 2; const max = 100, min = 0; const stepX = (w - pad * 2) / (values.length - 1);
  ctx.beginPath(); values.forEach((v, i) => { const x = pad + i * stepX; const y = h - pad - ((v - min) / (max - min)) * (h - pad * 2); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary'); ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.stroke();
  values.forEach((v, i) => { const x = pad + i * stepX; const y = h - pad - ((v - min) / (max - min)) * (h - pad * 2); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent'); ctx.fill(); });
}

/* ---------------------------- NAV / SHELL ---------------------------- */
function brandMark() {
  return `<svg class="brand-mark" viewBox="0 0 34 34"><circle cx="17" cy="17" r="17" fill="#0F7A72"/><path d="M9,20 C11,23 15,25 17,25 C19,25 23,23 25,20" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="12.5" cy="14" r="2.2" fill="#fff"/><circle cx="21.5" cy="14" r="2.2" fill="#fff"/></svg>`;
}

const T = {
  en: { home: 'Home', practice: 'Practice', progress: 'Progress', profile: 'Profile', dashboard: 'Dashboard', slogan: 'See it, Hear it, Say it, Improve it', learnerLogin: 'Learner Login', clinicianLogin: 'Doctor Login', videos: 'Videos' },
  ta: { home: 'முகப்பு', practice: 'பயிற்சி', progress: 'முன்னேற்றம்', profile: 'சுயவிவரம்', dashboard: 'கட்டுப்பாட்டகம்', slogan: 'பார், கேள், சொல், மேம்படு', learnerLogin: 'கற்பவர் நுழைவு', clinicianLogin: 'மருத்துவர் நுழைவு', videos: 'வீடியோக்கள்' }
};

function topbar() {
  const learner = state.role === 'learner';
  const doctor = state.role === 'doctor';
  const navItems = learner
    ? [['learnerHome', T[state.lang].home], ['practiceLibrary', T[state.lang].practice], ['progress', T[state.lang].progress], ['videos', T[state.lang].videos], ['profile', T[state.lang].profile]]
    : doctor
      ? [['doctorHome', T[state.lang].dashboard], ['profile', T[state.lang].profile]]
      : [];
  const activeMatch = (v) => (state.view === v) || (v === 'doctorHome' && state.view === 'learnerDetail');
  const displayName = state.user ? (state.user.name || state.user.email.split('@')[0]) : '';
  return `
  <div class="topbar">
    <div class="topbar-inner">
      <div class="brand" onclick="goTo('landing')">${brandMark()} Smart Articulation</div>
      ${(learner || doctor) ? `<div class="navlinks">${navItems.map(([v, l]) => `<button class="navlink ${activeMatch(v) ? 'active' : ''}" onclick="goTo('${v}')">${esc(l)}</button>`).join('')}</div>` : ''}
      <div class="topbar-right">
        ${learner ? `<div class="streak-chip">🔥 ${state.progress.reduce((a, p) => a + (p.streak || 0), 0) || 0}</div><div class="xp-chip">⭐ ${state.progress.reduce((a, p) => a + (p.points || 0), 0)}</div>` : ''}
        <div class="lang-toggle">
          <button class="lang-btn ${state.lang === 'en' ? 'active' : ''}" onclick="setLang('en')">EN</button>
          <button class="lang-btn ${state.lang === 'ta' ? 'active' : ''}" onclick="setLang('ta')">TA</button>
        </div>
        ${(learner || doctor) ? `<div class="avatar-chip"><span class="avatar-dot">${esc((learner ? displayName : 'Dr').slice(0, 1).toUpperCase())}</span>${esc(displayName)}</div>` : ''}
      </div>
    </div>
  </div>
  ${(learner || doctor) ? `<div class="tabbar"><div class="tabbar-inner">${navItems.map(([v, l]) => `<button class="tab-btn ${activeMatch(v) ? 'active' : ''}" onclick="goTo('${v}')">${esc(l)}</button>`).join('')}</div></div>` : ''}`;
}

/* ---------------------------- VIEWS: LANDING ---------------------------- */
function viewLanding() {
  const soundCount = state.sounds.length || 20;
  return `
  <section class="hero">
    <div class="hero-grid">
      <div>
        <span class="eyebrow">AdvancedSpeech · AI Articulation Therapy</span>
        <h1>A visual, guided way to practice speech sounds — between sessions, not instead of them.</h1>
        <div class="slogan">${esc(T[state.lang].slogan)}</div>
        <p class="lede">Smart Articulation Training System pairs simple articulation diagrams with live, in-browser speech feedback so learners can see how a sound is made, hear it, try it, and track their progress — while doctors keep full control of the plan.</p>
        <div class="hero-ctas">
          <button class="btn btn-primary btn-lg" onclick="setRolePref('learner'); goTo('login')">${esc(T[state.lang].learnerLogin)}</button>
          <button class="btn btn-ghost btn-lg" onclick="setRolePref('doctor'); goTo('login')">${esc(T[state.lang].clinicianLogin)}</button>
        </div>
        <div class="stat-strip">
          <div><span class="stat-num">${soundCount}</span><span class="stat-label">Target sounds</span></div>
          <div><span class="stat-num">3</span><span class="stat-label">Therapy levels: Sound → Word → Sentence</span></div>
          <div><span class="stat-num">100%</span><span class="stat-label">Runs in your browser + cloud backend</span></div>
        </div>
      </div>
      <div class="hero-art">
        <div class="mascot-row">
          ${mascotSVG('cheer', 76)}
          <div class="mascot-bubble">Hi, I'm Echo! Pick a sound and let's practice together 🎉</div>
        </div>
        <div class="diagram-stage">
          ${state.sounds.length ? mouthDiagramSVG(state.sounds[0], { showLabels: true, showAirflow: true, playing: true }) : ''}
        </div>
      </div>
    </div>
  </section>

  <div class="disclaimer-banner wrap" style="margin-bottom:20px;">
    ⚠️ <div>This is a practice and training aid — it does not diagnose speech disorders. Learners with significant speech difficulties should consult a licensed speech-language therapist.</div>
  </div>

  <section class="section">
    <div class="section-head"><h2>See it. Hear it. Say it. Get feedback.</h2><p>Every target sound comes with a visual demonstration, a spoken example, a recording step, and clear, encouraging feedback.</p></div>
    <div class="feature-grid">
      ${feature('👄', 'Visual articulation diagrams', 'Simplified tongue, lip and jaw diagrams show exactly where each sound is produced, with rotate, zoom, and slow-motion controls.')}
      ${feature('🔊', 'Lip-synced audio demos', 'Every sound, word, and sentence has a spoken demonstration, synced with the on-screen animation.')}
      ${feature('🎙️', 'Live pronunciation feedback', 'Learners record an attempt and get an instant accuracy score with specific, encouraging tips.')}
      ${feature('📹', 'Video practice to doctor', 'Record practice videos and send them directly to your assigned doctor for professional analysis.')}
      ${feature('📈', 'Progress tracking', 'Streaks, badges, and simple charts show improvement over time — for learners and doctors alike.')}
      ${feature('🧑‍⚕️', 'Doctor dashboard', 'Doctors assign sounds, review video submissions, add feedback, and manage therapy plans.')}
    </div>
  </section>

  <section class="section" style="background:var(--surface-2)">
    <div class="section-head"><h2>A structured therapy hierarchy</h2><p>Learners only advance once they're ready — accuracy thresholds are configurable.</p></div>
    <div class="stages-rail">
      ${stage('01', 'Sound Level', 'Repeat a single target sound after listening to a clear demonstration.')}
      ${stageArrow()}${stage('02', 'Word Level', 'Practice the sound in real words, organized by initial, medial, and final position.')}
      ${stageArrow()}${stage('03', 'Sentence Level', 'Read or repeat full sentences, with weak words flagged for extra practice.')}
      ${stageArrow()}${stage('04', 'Video Review', 'Record and send practice videos to your doctor for personalized feedback.', true)}
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2>Built for two kinds of users</h2></div>
    <div class="audience-grid">
      <div class="audience-card learner"><span class="pill">For Learners</span><h3>Practice independently, with confidence</h3>
        <ul><li>Gmail OTP login — secure and simple</li><li>Assign your doctor's email for direct video sharing</li><li>Streaks, points, and badges to keep practice fun</li></ul>
      </div>
      <div class="audience-card clinician"><span class="pill">For Doctors</span><h3>Stay in control of the therapy plan</h3>
        <ul><li>Review video practice submissions from your patients</li><li>Add feedback and ratings on each video</li><li>Assign specific sounds, words, and sentences</li></ul>
      </div>
    </div>
  </section>

  <section class="section" style="text-align:center;">
    <h2>Ready to try it?</h2>
    <p style="color:var(--ink-soft)">Login with your Gmail to get started — an OTP will be sent to verify your identity.</p>
    <div class="hero-ctas" style="justify-content:center;">
      <button class="btn btn-primary btn-lg" onclick="setRolePref('learner'); goTo('login')">Start practicing</button>
    </div>
  </section>`;
}
function feature(icon, title, desc) { return `<div class="feature-card"><div class="feature-icon">${icon}</div><h3>${esc(title)}</h3><p>${esc(desc)}</p></div>`; }
function stage(num, title, desc, optional) { return `<div class="stage-card ${optional ? 'optional' : ''}"><div class="stage-num">${num}${optional ? ' · OPTIONAL' : ''}</div><h3>${esc(title)}</h3><p style="color:var(--ink-soft);font-size:.9rem;margin:0;">${esc(desc)}</p></div>`; }
function stageArrow() { return `<div class="stage-arrow">→</div>`; }

/* ---------------------------- VIEW: LOGIN (OTP) ---------------------------- */
function setRolePref(r) { state.otpFlow.role = r; state.otpFlow.step = 'email'; state.otpFlow.error = ''; }

function viewLogin() {
  const f = state.otpFlow;
  if (f.step === 'email') {
    return `
    <div class="auth-wrap">
      <div class="auth-card card">
        <div class="role-toggle">
          <button class="${f.role === 'learner' ? 'active' : ''}" onclick="state.otpFlow.role='learner';state.otpFlow.step='email';render()">Learner</button>
          <button class="${f.role === 'doctor' ? 'active' : ''}" onclick="state.otpFlow.role='doctor';state.otpFlow.step='email';render()">Doctor</button>
        </div>
        <h2>${f.role === 'learner' ? 'Welcome!' : 'Doctor sign in'}</h2>
        <p style="color:var(--ink-soft);font-size:.9rem;">${f.role === 'learner' ? 'Log in with your Gmail to continue your sound practice.' : 'Log in with your email to review patient progress.'}</p>
        <div class="field"><label>Your Name</label><input id="loginName" type="text" placeholder="${f.role === 'learner' ? 'e.g. Aanya' : 'e.g. Dr. Meera Iyer'}" value="${esc(f.name)}"></div>
        <div class="field"><label>Email Address (Gmail)</label><input id="loginEmail" type="email" placeholder="you@gmail.com" value="${esc(f.email)}"></div>
        ${f.role === 'learner' ? `<div class="field"><label>Doctor's Email (your assigned doctor)</label><input id="loginDoctorEmail" type="email" placeholder="doctor@gmail.com" value="${esc(f.doctorEmail)}"></div>
        <p style="font-size:.78rem;color:var(--muted);margin:-8px 0 16px;">Enter your doctor's email — they'll be assigned to receive your video practice submissions.</p>` : ''}
        ${f.error ? `<p style="color:var(--warn);font-size:.85rem;font-weight:700;margin:8px 0;">⚠️ ${esc(f.error)}</p>` : ''}
        <button class="btn btn-primary btn-block btn-lg" onclick="requestOTP()" ${f.loading ? 'disabled' : ''}>
          ${f.loading ? '<span class="spinner"></span> Sending...' : 'Send Verification Code'}
        </button>
        <p class="helptext">We'll send a 6-digit code to your email. Your data is stored securely on our server.</p>
      </div>
    </div>`;
  }
  if (f.step === 'otp') {
    return `
    <div class="auth-wrap">
      <div class="auth-card card">
        <h2>Check your email</h2>
        <p style="color:var(--ink-soft);font-size:.9rem;">We sent a 6-digit verification code to:</p>
        <div class="email-display">📧 ${esc(f.email)}</div>
        <div class="otp-container">
          <input class="otp-input" type="text" maxlength="1" id="otp1" oninput="otpAutoFocus(1)" onkeydown="otpKeyDown(1,event)">
          <input class="otp-input" type="text" maxlength="1" id="otp2" oninput="otpAutoFocus(2)" onkeydown="otpKeyDown(2,event)">
          <input class="otp-input" type="text" maxlength="1" id="otp3" oninput="otpAutoFocus(3)" onkeydown="otpKeyDown(3,event)">
          <div class="otp-divider">–</div>
          <input class="otp-input" type="text" maxlength="1" id="otp4" oninput="otpAutoFocus(4)" onkeydown="otpKeyDown(4,event)">
          <input class="otp-input" type="text" maxlength="1" id="otp5" oninput="otpAutoFocus(5)" onkeydown="otpKeyDown(5,event)">
          <input class="otp-input" type="text" maxlength="1" id="otp6" oninput="otpAutoFocus(6)" onkeydown="otpKeyDown(6,event)">
        </div>
        ${f.error ? `<p style="color:var(--warn);font-size:.85rem;font-weight:700;text-align:center;">⚠️ ${esc(f.error)}</p>` : ''}
        <button class="btn btn-primary btn-block btn-lg" onclick="verifyOTP()" ${f.loading ? 'disabled' : ''}>
          ${f.loading ? '<span class="spinner"></span> Verifying...' : 'Verify & Sign In'}
        </button>
        <div class="resend-row">
          <button class="resend-btn" onclick="requestOTP()" ${f.timer > 0 ? 'disabled' : ''}>Resend code</button>
          ${f.timer > 0 ? `<span class="timer">${f.timer}s</span>` : ''}
        </div>
        <button class="btn btn-outline btn-block btn-sm" style="margin-top:12px;" onclick="state.otpFlow.step='email';state.otpFlow.error='';render()">← Change email</button>
      </div>
    </div>`;
  }
  return '';
}

function otpAutoFocus(idx) {
  const el = document.getElementById('otp' + idx);
  if (el && el.value.length === 1 && idx < 6) document.getElementById('otp' + (idx + 1))?.focus();
}
function otpKeyDown(idx, e) {
  if (e.key === 'Backspace' && !document.getElementById('otp' + idx).value && idx > 1) document.getElementById('otp' + (idx - 1))?.focus();
  if (e.key === 'Enter') verifyOTP();
}
function getOTPValue() {
  let v = ''; for (let i = 1; i <= 6; i++) v += (document.getElementById('otp' + i)?.value || ''); return v;
}

async function requestOTP() {
  const f = state.otpFlow;
  const nameEl = document.getElementById('loginName');
  const emailEl = document.getElementById('loginEmail');
  const docEl = document.getElementById('loginDoctorEmail');

  f.name = nameEl?.value?.trim() || f.name;
  f.email = emailEl?.value?.trim() || f.email;
  f.doctorEmail = docEl?.value?.trim() || f.doctorEmail;
  f.error = '';

  if (!f.email) { f.error = 'Please enter your email address'; render(); return; }
  if (!f.email.includes('@')) { f.error = 'Please enter a valid email address'; render(); return; }

  f.loading = true; render();
  try {
    const res = await apiPost('/api/auth/request-otp', { email: f.email });
    if (res.error) { f.error = res.error; }
    else {
      f.step = 'otp'; f.timer = 60;
      if (f.timerInterval) clearInterval(f.timerInterval);
      f.timerInterval = setInterval(() => { f.timer--; if (f.timer <= 0) clearInterval(f.timerInterval); renderTranscriptOnly(); const t = document.querySelector('.timer'); if (t) t.textContent = f.timer + 's'; if (f.timer <= 0) render(); }, 1000);
    }
  } catch (e) { f.error = 'Failed to send OTP. Please try again.'; }
  f.loading = false; render();
  setTimeout(() => document.getElementById('otp1')?.focus(), 100);
}

async function verifyOTP() {
  const f = state.otpFlow;
  const otp = getOTPValue();
  if (otp.length !== 6) { f.error = 'Please enter the complete 6-digit code'; render(); return; }

  f.loading = true; f.error = ''; render();
  try {
    const body = { email: f.email, otp, name: f.name || f.email.split('@')[0], role: f.role };
    if (f.role === 'learner' && f.doctorEmail) body.doctorEmail = f.doctorEmail;
    const res = await apiPost('/api/auth/verify-otp', body);
    if (res.error) { f.error = res.error; }
    else {
      state.token = res.token;
      state.user = res.user;
      state.role = res.user.role;
      localStorage.setItem('sat_token', state.token);
      localStorage.setItem('sat_user', JSON.stringify(state.user));
      await loadUserData();
      showToast(`Welcome, ${res.user.name}!`, 'success');
      state.view = state.role === 'learner' ? 'learnerHome' : 'doctorHome';
    }
  } catch (e) { f.error = 'Verification failed. Please try again.'; }
  f.loading = false; render();
}

/* ---------------------------- DATA LOADING ---------------------------- */
async function loadUserData() {
  try {
    const soundsRes = await apiGet('/api/sounds');
    state.sounds = soundsRes.sounds || [];

    if (state.role === 'learner') {
      const progRes = await apiGet('/api/learner/progress');
      state.progress = progRes.progress || [];
      state.attempts = progRes.attempts || [];
      state.doctor = progRes.doctor || null;
      if (progRes.settings) state.consent = !!progRes.settings.consent_recording;
      const vidRes = await apiGet('/api/learner/videos');
      state.videoSubmissions = vidRes.videos || [];
    } else if (state.role === 'doctor') {
      const res = await apiGet('/api/doctor/learners');
      state.doctorLearners = res.learners || [];
    }
  } catch (e) { console.error('Load data error:', e); }
}

/* ---------------------------- VIEW: LEARNER HOME ---------------------------- */
function viewLearnerHome() {
  const sounds = state.sounds;
  const assignedIds = state.progress.map(p => p.sound_id);
  const assigned = sounds.filter(s => assignedIds.includes(s.sound_id));
  const allSounds = assigned.length ? assigned : sounds;

  return `
  <div class="wrap" style="padding-top:28px;">
    <div class="page-head"><div><h2>Hi, ${esc(state.user?.name || 'there')} 👋</h2><p style="color:var(--ink-soft);margin:0;">Here's your practice plan for today.</p></div>
      <div class="pill">🔥 ${state.progress.reduce((a, p) => a + (p.sessions || 0), 0)} sessions</div>
    </div>

    ${state.doctor ? `<div class="card" style="margin-bottom:16px;border-left:4px solid var(--primary);">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="font-size:1.5rem;">🧑‍⚕️</div>
        <div>
          <div style="font-weight:800;">Your Doctor</div>
          <div style="color:var(--ink-soft);font-size:.9rem;">${esc(state.doctor.name)} · ${esc(state.doctor.email)}</div>
        </div>
      </div>
    </div>` : `<div class="card" style="margin-bottom:16px;border-left:4px solid var(--accent);">
      <p style="font-size:.9rem;margin:0;">📧 <strong>No doctor assigned yet.</strong> <button class="btn btn-ghost btn-sm" onclick="showAssignDoctorModal()">Add Doctor Email</button></p>
    </div>`}

    <div class="two-col">
      <div class="card">
        <h3>Today's plan</h3>
        <div class="facts-list">
          <div class="fact-row"><div class="k">5 min</div><div class="v">Sound Level warm-up</div></div>
          <div class="fact-row"><div class="k">5 min</div><div class="v">Word Level practice</div></div>
          <div class="fact-row"><div class="k">5 min</div><div class="v">Sentence Level practice</div></div>
        </div>
        <button class="btn btn-accent btn-block" onclick="openSound('${allSounds[0]?.sound_id || 'r'}')">Continue practicing →</button>
      </div>
      <div class="card">
        <h3>Quick Stats</h3>
        <div class="facts-list">
          <div class="fact-row"><div class="k">📊 Sessions</div><div class="v">${state.progress.reduce((a, p) => a + (p.sessions || 0), 0)}</div></div>
          <div class="fact-row"><div class="k">⭐ Points</div><div class="v">${state.progress.reduce((a, p) => a + (p.points || 0), 0)}</div></div>
          <div class="fact-row"><div class="k">📹 Videos</div><div class="v">${state.videoSubmissions.length} sent</div></div>
        </div>
      </div>
    </div>

    <hr class="divider">
    <h3>Jump into a sound</h3>
    ${soundPath(allSounds)}
  </div>`;
}

function soundPath(sounds) {
  if (!sounds.length) return `<p style="color:var(--muted);">Loading sounds...</p>`;
  const offsetClasses = ['off-c', 'off-l', 'off-c', 'off-r'];
  return `<div class="sound-path">
    ${sounds.map((s, i) => {
      const prog = state.progress.find(p => p.sound_id === s.sound_id);
      const p = prog?.points ? Math.min(100, prog.points) : 0;
      const mastered = p >= 80;
      const started = p > 0;
      return `<div class="path-node ${offsetClasses[i % offsetClasses.length]}">
        <button class="path-node-circle ${mastered ? 'mastered' : started ? 'started' : 'fresh'}" onclick="openSound('${s.sound_id}')" aria-label="${esc(s.label)} sound">
          ${esc(s.symbol)}
          ${mastered ? `<span class="path-node-star">⭐</span>` : ''}
        </button>
        <div class="path-node-label">${esc(s.label)}</div>
        <div class="path-node-pct">${p}%</div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ---------------------------- VIEW: PRACTICE LIBRARY ---------------------------- */
function viewPracticeLibrary() {
  return `<div class="wrap" style="padding-top:28px;">
    <div class="page-head"><h2>Sound Library</h2><span class="pill">${state.sounds.length} sounds</span></div>
    <p style="color:var(--ink-soft)">Pick a target sound to begin with a visual demonstration, then move on to words and sentences.</p>
    <div class="grid-cards">
      ${state.sounds.map(s => {
        const prog = state.progress.find(p => p.sound_id === s.sound_id);
        const p = prog?.points || 0;
        return `<div class="sound-card" onclick="openSound('${s.sound_id}')">
          <div class="sound-symbol">${esc(s.symbol)}</div>
          <h3>${esc(s.label)}</h3>
          <div class="cat">${esc(s.category)} · ${esc(s.voicing)}</div>
          <div class="progress-bar"><span style="width:${Math.min(100, p)}%"></span></div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

/* ---------------------------- MOUTH 3D ENGINE (WebGL / three.js) ---------------------------- */
const POSE3D = {
  _neutral:{ jaw:0.14, lipRound:0.12, lipSpread:0.05, tongue:{x:0,y:-0.05,z:0.05,rx:0,rz:0,bulge:1} },
  r:{  jaw:0.24, lipRound:0.42, lipSpread:0,    airflow:'soft',  tongue:{x:0,y:0.16,z:-0.32,rx:-0.32,rz:0,bulge:1.05} },
  l:{  jaw:0.34, lipRound:0.08, lipSpread:0.08, airflow:'none',  tongue:{x:0,y:0.30,z:0.22, rx:0.18, rz:0,bulge:0.92} },
  s:{  jaw:0.15, lipRound:0.04, lipSpread:0.34, airflow:'hiss',  tongue:{x:0,y:0.24,z:0.30, rx:0.08, rz:0,bulge:0.85} },
  sh:{ jaw:0.30, lipRound:0.58, lipSpread:0,    airflow:'hiss',  tongue:{x:0,y:0.14,z:0.02, rx:-0.10,rz:0,bulge:1.08} },
  ch:{ jaw:0.30, lipRound:0.50, lipSpread:0,    airflow:'burst', tongue:{x:0,y:0.14,z:0.02, rx:-0.10,rz:0,bulge:1.05},
       phase1:{ jaw:0.16, lipRound:0.16, lipSpread:0, tongue:{x:0,y:0.30,z:0.24,rx:0.16,rz:0,bulge:0.9} } },
  th:{ jaw:0.40, lipRound:0.06, lipSpread:0.10, airflow:'soft',  tongue:{x:0,y:0.02,z:0.52, rx:0.34, rz:0,bulge:0.8} },
};

const MOUTH3D = {}; // containerId -> live instance

function disposeMouth3D(id){
  const inst = MOUTH3D[id];
  if(!inst) return;
  cancelAnimationFrame(inst.raf);
  if(inst.onResize) window.removeEventListener('resize', inst.onResize);
  if(inst.el){
    inst.el.removeEventListener('pointerdown', inst.onDown);
    window.removeEventListener('pointermove', inst.onMove);
    window.removeEventListener('pointerup', inst.onUp);
  }
  try{
    inst.scene.traverse(o=>{
      if(o.geometry) o.geometry.dispose();
      if(o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose()); }
    });
    inst.renderer.dispose();
  }catch(e){ /* best-effort cleanup */ }
  delete MOUTH3D[id];
}

function buildMouthScene(){
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);

  const skinMat   = new THREE.MeshStandardMaterial({ color:0xFBEFE6, transparent:true, opacity:0.38, roughness:0.85, side:THREE.DoubleSide });
  const boneMat   = new THREE.MeshStandardMaterial({ color:0xE8CDB4, roughness:0.7 });
  const toothMat  = new THREE.MeshStandardMaterial({ color:0xffffff, roughness:0.35 });
  const lipMat    = new THREE.MeshStandardMaterial({ color:0xD97B63, roughness:0.55 });
  const tongueMat = new THREE.MeshStandardMaterial({ color:0xE8757A, roughness:0.5 });
  const palateMat = new THREE.MeshStandardMaterial({ color:0xC98F72, roughness:0.6, side:THREE.DoubleSide });

  const cheek = new THREE.Mesh(new THREE.SphereGeometry(1.5, 26, 18), skinMat);
  cheek.scale.set(1, 0.9, 1.05);
  cheek.position.set(0.05, -0.05, -0.55);
  root.add(cheek);

  function archPoint(t, rx, rz, y){
    const a = t * 1.15;
    return new THREE.Vector3(Math.sin(a)*rx, y, -rz*(1-Math.cos(a)));
  }
  function buildArch(y, rx, rz, count){
    const g = new THREE.Group();
    const pts = []; for(let i=0;i<=16;i++) pts.push(archPoint(-1+2*i/16, rx, rz, y));
    const curve = new THREE.CatmullRomCurve3(pts);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.05, 6, false), boneMat));
    for(let i=0;i<count;i++){
      const t = -0.82 + (1.64*i/(count-1));
      const p = archPoint(t, rx, rz, y);
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 0.07), toothMat);
      tooth.position.copy(p);
      tooth.lookAt(p.x*2, y, p.z*2 - rz*0.3);
      g.add(tooth);
    }
    return g;
  }

  root.add(buildArch(0.18, 0.62, 0.85, 9));

  const palate = new THREE.Mesh(new THREE.SphereGeometry(0.66, 16, 10, 0, Math.PI*2, 0, Math.PI*0.42), palateMat);
  palate.position.set(0, 0.15, -0.35);
  palate.rotation.x = Math.PI;
  root.add(palate);

  const upperLip = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.065, 8, 20, Math.PI), lipMat);
  upperLip.position.set(0, 0.14, 0.78);
  root.add(upperLip);

  const jawHinge = new THREE.Group();
  jawHinge.position.set(0, 0.02, -0.82);
  const jawInner = new THREE.Group();
  jawInner.position.set(0, -0.02, 0.82);
  jawHinge.add(jawInner);
  root.add(jawHinge);

  jawInner.add(buildArch(-0.02, 0.58, 0.8, 9));

  const lowerLip = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.07, 8, 20, Math.PI), lipMat);
  lowerLip.rotation.z = Math.PI;
  lowerLip.position.set(0, -0.1, 0.74);
  jawInner.add(lowerLip);

  const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), tongueMat);
  tongue.scale.set(1, 0.5, 1.25);
  tongue.position.set(0, -0.05, 0.05);
  root.add(tongue);

  const larynx = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.5, 10), new THREE.MeshStandardMaterial({ color:0xB85E52, roughness:0.6 }));
  larynx.position.set(0, -0.1, -1.15);
  larynx.rotation.x = Math.PI/2;
  root.add(larynx);

  const particles = [];
  for(let i=0;i<7;i++){
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), new THREE.MeshBasicMaterial({ color:0xBFE6E2, transparent:true, opacity:0 }));
    p.visible = false;
    root.add(p);
    particles.push(p);
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(2, 2.4, 2.6); scene.add(key);
  const fill = new THREE.PointLight(0xffffff, 0.35); fill.position.set(-2, -1, 1.5); scene.add(fill);

  return { scene, root, tongue, jawHinge, upperLip, lowerLip, larynx, particles };
}

function applyMouthPose(parts, pose, k){
  const n = POSE3D._neutral;
  const jaw = n.jaw + (pose.jaw - n.jaw) * k;
  parts.jawHinge.rotation.x = -jaw * 0.85;

  const tn = n.tongue, tp = pose.tongue;
  parts.tongue.position.set(
    tn.x + (tp.x - tn.x) * k,
    tn.y + (tp.y - tn.y) * k - jaw * 0.12,
    tn.z + (tp.z - tn.z) * k
  );
  parts.tongue.rotation.set(tn.rx + (tp.rx - tn.rx) * k, 0, tn.rz + (tp.rz - tn.rz) * k);
  const b = tn.bulge + (tp.bulge - tn.bulge) * k;
  parts.tongue.scale.set(b, 0.5*b, 1.25*b);

  const round = n.lipRound + (pose.lipRound - n.lipRound) * k;
  const spread = n.lipSpread + (pose.lipSpread - n.lipSpread) * k;
  const widthScale = 1 - round*0.32 + spread*0.22;
  const protrude = round * 0.14;
  parts.upperLip.scale.set(widthScale, 1 - round*0.2, 1);
  parts.upperLip.position.z = 0.78 + protrude;
  parts.lowerLip.scale.set(widthScale, 1 - round*0.2, 1);
  parts.lowerLip.position.z = 0.74 + protrude;
}

function mountMouth3D(containerId, soundId, opts={}){
  const el = document.getElementById(containerId);
  if(!el) return;
  disposeMouth3D(containerId);
  if(typeof THREE === 'undefined'){
    el.innerHTML = '<div class="mouth3d-fallback">The 3D model needs an internet connection to load. You can still read the tongue/lip/jaw notes on the right.</div>';
    return;
  }
  let renderer;
  try{ renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true }); }
  catch(e){
    el.innerHTML = '<div class="mouth3d-fallback">This browser can\u2019t display the 3D model. The written notes on the right still describe the movement.</div>';
    return;
  }
  const w = el.clientWidth || 340, h = el.clientHeight || 280;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  el.innerHTML = '';
  el.appendChild(renderer.domElement);

  const built = buildMouthScene();
  const camera = new THREE.PerspectiveCamera(38, w/h, 0.1, 50);
  camera.position.set(0.05, 0.35, 3.1);
  camera.lookAt(0, 0, -0.15);

  const labelWrap = document.createElement('div');
  labelWrap.className = 'mouth3d-labels';
  el.appendChild(labelWrap);
  const labelEls = {};
  [['tongue','Tongue'], ['lips','Lips'], ['jaw','Jaw']].forEach(([key,text])=>{
    const s = document.createElement('span');
    s.className = 'mouth3d-label';
    s.textContent = text;
    labelWrap.appendChild(s);
    labelEls[key] = s;
  });

  const inst = {
    el, renderer, scene:built.scene, camera, root:built.root, parts:built,
    soundId, playing:false, slow:!!opts.slow, showLabels: opts.showLabels!==false,
    tStart:0, duration: opts.slow?4200:1300,
    dragYaw:0, sliderYaw: THREE.MathUtils.degToRad(opts.rotate||0), zoomPct: opts.zoom||100,
    raf:null,
  };
  MOUTH3D[containerId] = inst;

  let dragging=false, lastX=0;
  inst.onDown = (e)=>{ dragging=true; lastX=e.clientX; el.classList.add('dragging'); };
  inst.onMove = (e)=>{ if(!dragging) return; const dx=e.clientX-lastX; lastX=e.clientX; inst.dragYaw += dx*0.012; };
  inst.onUp = ()=>{ dragging=false; el.classList.remove('dragging'); };
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', inst.onDown);
  window.addEventListener('pointermove', inst.onMove);
  window.addEventListener('pointerup', inst.onUp);

  inst.onResize = ()=>{
    const nw = el.clientWidth||w, nh = el.clientHeight||h;
    renderer.setSize(nw, nh); camera.aspect = nw/nh; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', inst.onResize);

  applyMouthPose(inst.parts, POSE3D._neutral, 1);

  function frame(){
    inst.raf = requestAnimationFrame(frame);
    inst.root.rotation.y = inst.sliderYaw + inst.dragYaw;
    const dist = 3.1 - ((inst.zoomPct-100)/100)*1.2;
    inst.camera.position.z = THREE.MathUtils.clamp(dist, 1.9, 4.2);
    inst.camera.updateProjectionMatrix();

    if(inst.playing){
      const now = performance.now();
      const k = Math.min((now - inst.tStart)/inst.duration, 1);
      const eased = 1 - Math.pow(1-Math.min(k/0.65,1), 3);
      const pose = POSE3D[inst.soundId] || POSE3D._neutral;
      if(pose.phase1){
        if(k<0.45) applyMouthPose(inst.parts, pose.phase1, Math.min(k/0.45,1));
        else applyMouthPose(inst.parts, pose, Math.min((k-0.45)/0.35,1));
      } else {
        applyMouthPose(inst.parts, pose, eased);
      }
      inst.parts.larynx.scale.y = 1 + Math.sin(now/90)*0.12;

      if(pose.airflow && pose.airflow!=='none' && k>0.1){
        inst.parts.particles.forEach((p,i)=>{
          const cycle = ((now/700) + i/inst.parts.particles.length) % 1;
          p.visible = true;
          p.position.set(Math.sin(i*13)*0.05, 0.02+Math.sin(i)*0.02, -0.1 + cycle*1.5);
          p.material.opacity = 0.75*(1-cycle);
          p.scale.setScalar(0.6+cycle*0.8);
        });
      } else {
        inst.parts.particles.forEach(p=>p.visible=false);
      }
    }

    if(inst.showLabels){
      const w2 = el.clientWidth, h2 = el.clientHeight;
      const proj = (obj, offset)=>{
        const v = offset ? offset.clone() : new THREE.Vector3();
        obj.localToWorld ? obj.localToWorld(v) : obj.getWorldPosition(v);
        v.project(inst.camera);
        return { x:(v.x*0.5+0.5)*w2, y:(1-(v.y*0.5+0.5))*h2 };
      };
      let p = proj(inst.parts.tongue); labelEls.tongue.style.left=p.x+'px'; labelEls.tongue.style.top=p.y+'px'; labelEls.tongue.style.opacity=1;
      p = proj(inst.parts.upperLip); labelEls.lips.style.left=p.x+'px'; labelEls.lips.style.top=p.y+'px'; labelEls.lips.style.opacity=1;
      p = proj(inst.parts.jawHinge, new THREE.Vector3(0,-0.32,0.55)); labelEls.jaw.style.left=p.x+'px'; labelEls.jaw.style.top=p.y+'px'; labelEls.jaw.style.opacity=1;
    } else {
      Object.values(labelEls).forEach(s=>s.style.opacity=0);
    }

    inst.renderer.render(inst.scene, inst.camera);
  }
  frame();

  if(opts.playing) playMouth3D(containerId);
  return inst;
}

function playMouth3D(containerId){
  const inst = MOUTH3D[containerId];
  if(!inst) return;
  inst.duration = inst.slow ? 4200 : 1300;
  inst.playing = true;
  inst.tStart = performance.now();
}
function pauseMouth3D(containerId){ const inst = MOUTH3D[containerId]; if(inst) inst.playing = false; }
function restartMouth3D(containerId){ playMouth3D(containerId); }
function setMouth3DSlow(containerId, val){ const inst = MOUTH3D[containerId]; if(inst) inst.slow = val; }
function setMouth3DLabels(containerId, val){ const inst = MOUTH3D[containerId]; if(inst) inst.showLabels = val; }
function setMouth3DRotate(containerId, deg){ const inst = MOUTH3D[containerId]; if(inst) inst.sliderYaw = THREE.MathUtils.degToRad(Number(deg)); }
function setMouth3DZoom(containerId, pct){ const inst = MOUTH3D[containerId]; if(inst) inst.zoomPct = Number(pct); }
/* ---------------------------- VIEW: SOUND LEARN ---------------------------- */
let diagramState = { rotate: 0, zoom: 1, showLabels: true, playing: false, slow: false };
function openSound(id) { state.currentSoundId = id; state.view = 'soundLearn'; diagramState = { rotate: 0, zoom: 1, showLabels: true, playing: false, slow: false }; render(); }

function viewSoundLearn() {
  const sound = getSound(state.currentSoundId);
  if (!sound) return `<div class="wrap" style="padding-top:28px;">Sound not found.</div>`;
  const words = sound.words || {};
  const prog = state.progress.find(p => p.sound_id === sound.sound_id);

  return `
  <div class="wrap" style="padding-top:24px;">
    <div class="breadcrumbs"><button onclick="goTo('practiceLibrary')">← Sound Library</button></div>
    <div class="page-head"><h2>${esc(sound.label)} <span class="mono" style="color:var(--muted);font-weight:400;">${esc(sound.symbol)}</span></h2><span class="pill">${esc(sound.category)} · ${esc(sound.voicing)}</span></div>

    <div class="learn-grid">
      <div class="diagram-stage">
        <div class="diagram-viewport">
          <div class="mouth3d-container" id="mouth3d-learn" data-sound="${sound.sound_id}"></div>
          <div class="mouth3d-hint">Drag to rotate the 3D model</div>
        </div>
        <div class="diagram-controls">
          <button class="icon-btn ${diagramState.playing ? 'active' : ''}" title="Play" onclick="playDiagram()">▶</button>
          <button class="icon-btn" title="Pause" onclick="pauseDiagram()">⏸</button>
          <button class="icon-btn" title="Restart" onclick="restartDiagram()">⟲</button>
          <button class="icon-btn ${diagramState.slow ? 'active' : ''}" title="Slow motion" onclick="toggleSlow()">🐢</button>
          <button class="icon-btn ${diagramState.showLabels ? 'active' : ''}" title="Toggle labels" onclick="toggleLabels()">🏷️</button>
        </div>
        <div class="slider-row"><span>Rotate</span><input type="range" min="-40" max="40" value="${diagramState.rotate}" oninput="setRotate(this.value)"><span>${diagramState.rotate}°</span></div>
        <div class="slider-row"><span>Zoom</span><input type="range" min="70" max="140" value="${diagramState.zoom * 100}" oninput="setZoom(this.value)"><span>${Math.round(diagramState.zoom * 100)}%</span></div>
        <div class="legend-list"><span class="legend-chip">Tongue</span><span class="legend-chip">Lips</span><span class="legend-chip">Teeth</span><span class="legend-chip">Jaw</span>${sound.voicing !== 'Voiceless' ? '<span class="legend-chip">Voicing hum</span>' : ''}</div>
        <div class="audio-row">
          <button class="icon-btn" title="Listen" onclick="speak('${esc(sound.label)}')">🔈</button>
          <canvas width="200" height="34"></canvas>
          <button class="btn btn-ghost btn-sm" onclick="speak('${esc(sound.label)}')">Listen again</button>
        </div>
      </div>

      <div>
        <div class="card">
          <p>${esc(sound.description)}</p>
          <div class="facts-list">
            <div class="fact-row"><div class="k">Tongue</div><div class="v">${esc(sound.tongue)}</div></div>
            <div class="fact-row"><div class="k">Lips</div><div class="v">${esc(sound.lips)}</div></div>
            <div class="fact-row"><div class="k">Jaw</div><div class="v">${esc(sound.jaw)}</div></div>
            <div class="fact-row"><div class="k">Airflow</div><div class="v">${esc(sound.airflow)}</div></div>
          </div>
          <p style="font-size:.78rem;color:var(--muted);">Diagram is a simplified schematic for learning purposes.</p>
          <button class="btn btn-primary btn-block btn-lg" onclick="startPractice('${sound.sound_id}','sound')">Now You Try — Sound Level</button>
          <div style="font-size:.8rem;color:var(--muted);margin-top:10px;">Points earned: <strong>${prog?.points || 0}</strong></div>
        </div>
      </div>
    </div>
  </div>`;
}
function playDiagram() { diagramState.playing = true; playMouth3D('mouth3d-learn'); render(); }
function pauseDiagram() { diagramState.playing = false; pauseMouth3D('mouth3d-learn'); render(); }
function restartDiagram() { restartMouth3D('mouth3d-learn'); }
function toggleSlow() { diagramState.slow = !diagramState.slow; setMouth3DSlow('mouth3d-learn', diagramState.slow); render(); }
function toggleLabels() { diagramState.showLabels = !diagramState.showLabels; setMouth3DLabels('mouth3d-learn', diagramState.showLabels); render(); }
function setRotate(v) { diagramState.rotate = Number(v); setMouth3DRotate('mouth3d-learn', v); }
function setZoom(v) { diagramState.zoom = Number(v) / 100; setMouth3DZoom('mouth3d-learn', v); }
/* ---------------------------- PRACTICE SESSION ---------------------------- */
function startPractice(soundId, level) {
  state.currentSoundId = soundId; state.currentLevel = level; state.view = 'practiceSession';
  state.rec.lastResult = null; state.rec.transcript = '';
  if (!state.consent) state.showConsentModal = true;
  render();
}
function acceptConsent() { state.consent = true; state.showConsentModal = false; }

function currentTargetText() {
  const sound = getSound(state.currentSoundId);
  if (!sound) return '';
  const words = sound.words || {};
  const sentences = sound.sentences || [];
  const prog = state.progress.find(p => p.sound_id === sound.sound_id);
  if (state.currentLevel === 'sound') return sound.label;
  if (state.currentLevel === 'word') {
    const allWords = [...(words.initial || []), ...(words.medial || []), ...(words.final || [])];
    return allWords[(prog?.word_idx || 0) % allWords.length] || allWords[0] || sound.label;
  }
  if (state.currentLevel === 'sentence') return sentences[(prog?.sentence_idx || 0) % sentences.length] || sound.label;
  return sound.label;
}

function viewPracticeSession() {
  const sound = getSound(state.currentSoundId);
  if (!sound) return '';
  const level = state.currentLevel;
  const target = currentTargetText();
  const levelLabel = level === 'sound' ? 'Sound Level' : level === 'word' ? 'Word Level' : 'Sentence Level';
  const result = state.rec.lastResult;

  let targetHTML = '';
  if (level === 'sentence' && result && result.breakdown) {
    targetHTML = `<div class="target-sentence">${result.breakdown.map(b => `<span class="word-part ${b.ok ? '' : 'weak'}">${esc(b.word)}</span>`).join(' ')}</div>`;
  } else if (level === 'sentence') {
    targetHTML = `<div class="target-sentence">${esc(target)}</div>`;
  } else {
    targetHTML = `<div class="target-word">${esc(target)}</div>`;
  }

  return `
  <div class="wrap" style="padding-top:24px;">
    <div class="breadcrumbs"><button onclick="goTo('soundLearn')">← ${esc(sound.label)} overview</button></div>
    <div class="practice-stage">
      <div class="stage-label">${esc(sound.label)} · ${levelLabel}</div>
      ${!result ? `<div class="stage-label" style="color:var(--primary)">Listen</div>` : ''}
      ${targetHTML}
      <button class="btn btn-ghost" onclick="playTargetDemo()">🔈 Listen${!result ? '' : ' again'} + watch movement</button>
      ${practiceCoach3D(sound, target)}

      <hr class="divider">
      <div class="stage-label" style="color:var(--accent)">Now You Try</div>
      ${state.rec.active ? `<canvas id="liveWave"></canvas><div id="liveTranscript" class="rec-hint mono"></div>` : ''}
      <button class="mic-btn ${state.rec.active ? 'recording' : ''}" onclick="${state.rec.active ? 'stopMic()' : 'startMic()'}">${state.rec.active ? '■' : '🎙️'}</button>
      <div class="rec-hint">${state.rec.active ? 'Recording… tap to stop' : 'Tap the mic and say it out loud'}</div>
      <div class="mascot-react">${mascotSVG(result && result.score >= 85 ? 'cheer' : 'idle', 60)}</div>

      ${result ? renderResultBox(result, sound) : ''}

      <div class="camera-toggle-row">
        <button class="btn btn-ghost btn-sm" onclick="toggleCameraCoaching()">${state.camera.enabled ? '📷 Video coaching is on' : '📷 Add video coaching (beta)'}</button>
      </div>
      ${state.camera.error ? `<p style="font-size:.8rem;color:var(--warn);text-align:center;">${esc(state.camera.error)}</p>` : ''}

      <hr class="divider">
      ${renderVideoSubmitSection(sound, target, result)}
    </div>
  </div>
  ${state.showConsentModal ? consentModal() : ''}`;
}

function practiceCoach3D(sound, target) {
  return `<div class="coach-3d-card" aria-label="3D mouth coach for ${esc(target)}">
    <div class="coach-3d-head">
      <div><strong>3D mouth coach</strong><div class="coach-3d-sub">Target: <span class="mono">${esc(target)}</span></div></div>
      <button class="btn btn-primary btn-sm" onclick="playTargetDemo()">▶ Play demo</button>
    </div>
    <div class="coach-3d-grid">
      <div class="coach-3d-stage"><div class="mouth3d-container" id="mouth3d-coach" data-sound="${sound.sound_id}"></div></div>
      <div class="coach-3d-instructions">
        <div class="fact-row"><div class="k">Tongue</div><div class="v">${esc(sound.tongue)}</div></div>
        <div class="fact-row"><div class="k">Mouth</div><div class="v">${esc(sound.lips)} ${esc(sound.jaw)}</div></div>
        <p>${esc(sound.tip)}</p>
      </div>
    </div>
  </div>`;
}
function playTargetDemo() {
  const target = currentTargetText(); speak(target);
  restartMouth3D('mouth3d-coach');
}
function renderResultBox(result, sound) {
  if (result.errorMessage) {
    return `<div class="result-box gentle"><div style="font-weight:800;">⚠️ We couldn't hear you</div><p style="margin:10px 0 0;">${esc(result.errorMessage)}</p>
      <div class="result-actions"><button class="btn btn-primary" onclick="startPractice('${sound.sound_id}', '${state.currentLevel}')">Try Again</button></div></div>`;
  }
  const score = result.score; const tone = score >= 85 ? 'success' : score >= 60 ? 'warm' : 'gentle';
  const title = score >= 85 ? 'Great job! 🎉' : score >= 60 ? 'Good attempt!' : "Let's try that again";
  const tip = score >= 85 ? `Your ${sound.label} sound came through clearly.` : sound.tip;
  return `<div class="result-box ${tone}">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><div style="font-weight:800;">${title}</div><div style="font-size:.85rem;color:var(--ink-soft);">Heard: <span class="mono">"${esc(result.transcript || '—')}"</span></div></div>
      <div style="text-align:right;"><div class="result-score">${score}%</div><span class="xp-tag">+${Math.round(score / 10)} XP</span></div>
    </div>
    <p style="margin:12px 0 0;">${esc(tip)}</p>
    <div class="result-actions">
      <button class="btn btn-outline" onclick="startPractice('${sound.sound_id}', '${state.currentLevel}')">Try Again</button>
      <button class="btn btn-primary" onclick="continuePractice()">Continue</button>
    </div>
  </div>`;
}

/* ---------------------------- VIDEO SUBMIT SECTION ---------------------------- */
function renderVideoSubmitSection(sound, target, result) {
  const hasDoc = !!state.doctor;
  const vf = state.videoFlow;
  return `
  <div class="video-submit-section">
    <h4>📹 Send Practice Video to Your Doctor</h4>
    ${!hasDoc ? `<p style="font-size:.85rem;color:var(--ink-soft);">You need to <button class="btn btn-ghost btn-sm" onclick="showAssignDoctorModal()">assign a doctor</button> first to send videos.</p>` : `
    <p style="font-size:.85rem;color:var(--ink-soft);">Record yourself practicing <strong>${esc(target)}</strong> and send it to <strong>${esc(state.doctor?.name || '')}</strong> for analysis.</p>
    ${vf.url ? `
      <div class="video-preview"><video src="${vf.url}" controls style="width:100%;border-radius:12px;"></video></div>
      <div style="display:flex;gap:10px;justify-content:center;margin:12px 0;">
        <button class="btn btn-accent" onclick="submitVideoToDoctor()">📤 Send to Doctor</button>
        <button class="btn btn-outline" onclick="discardVideo()">Discard</button>
      </div>
    ` : `
      <div class="video-record-area ${vf.recording ? 'recording' : ''}">
        ${vf.recording ? `
          <p style="color:var(--warn);font-weight:700;">🔴 Recording with audio + video... Click stop when done.</p>
          <p style="font-size:.78rem;color:var(--muted);">Your voice is being recorded so the doctor can hear you practicing.</p>
        ` : '<p style="color:var(--muted);">Click below to record a video (with audio) of your practice.</p>'}
        <div id="videoRecordPreview" style="max-width:320px;margin:12px auto;"></div>

        ${vf.recording ? `
        <!-- Live Mouth Analysis Meters -->
        <div style="background:var(--surface);border-radius:12px;padding:14px;margin:12px 0;text-align:left;">
          <div style="font-weight:800;font-size:.85rem;margin-bottom:10px;">📊 Live Mouth Analysis</div>
          <div class="camera-meter"><div class="camera-meter-lbl"><span>Mouth Opening</span><span id="liveApertureVal">0%</span></div><div class="camera-meter-track"><span class="camera-meter-fill" id="liveAperture" style="width:0%;background:var(--primary);"></span></div></div>
          <div class="camera-meter" style="margin-top:6px;"><div class="camera-meter-lbl"><span>Lip Width</span><span id="liveWidthVal">0%</span></div><div class="camera-meter-track"><span class="camera-meter-fill" id="liveWidth" style="width:0%;background:var(--accent);"></span></div></div>
          <div class="camera-meter" style="margin-top:6px;"><div class="camera-meter-lbl"><span>Movement</span><span id="liveMovementVal">0%</span></div><div class="camera-meter-track"><span class="camera-meter-fill" id="liveMovement" style="width:0%;background:var(--success);"></span></div></div>
          <div style="text-align:center;margin-top:10px;">
            <span style="font-family:var(--font-mono);font-size:2rem;font-weight:800;color:var(--primary-dark);" id="liveOverallScore">0%</span>
            <div style="font-size:.78rem;color:var(--muted);font-weight:700;" id="liveTip">Analyzing mouth shape...</div>
          </div>
        </div>
        ` : ''}

        <button class="btn ${vf.recording ? 'btn-accent' : 'btn-primary'}" onclick="${vf.recording ? 'stopVideoRecording()' : 'startVideoRecording()'}">
          ${vf.recording ? '⏹ Stop Recording' : '🎬 Start Recording (Video + Audio)'}
        </button>
      </div>
    `}

    ${state.videoSubmissions.length ? `
    <hr class="divider">
    <h4>Your Video Submissions</h4>
    <div class="video-list">
      ${state.videoSubmissions.slice(0, 5).map(v => `
        <div class="video-item">
          <div>
            <div style="font-weight:700;">${esc(v.sound_id || '')} · ${esc(v.level || '')}</div>
            <div style="font-size:.8rem;color:var(--muted);">${new Date(v.created_at).toLocaleDateString()}</div>
          </div>
          <div class="chip-row">
            <span class="video-status ${v.status}">${v.status === 'feedback_given' ? '✅ Feedback received' : v.status === 'reviewed' ? '👁️ Reviewed' : '⏳ Pending'}</span>
          </div>
        </div>
        ${v.doctor_feedback ? `<div class="feedback-card"><div class="feedback-header"><strong>Doctor's Feedback</strong>${v.doctor_rating ? `<div class="feedback-stars">${'⭐'.repeat(v.doctor_rating)}</div>` : ''}</div><div class="feedback-text">${esc(v.doctor_feedback)}</div></div>` : ''}
      `).join('')}
    </div>` : ''}
    `}</div>`;
}

/* ---- FACE MESH ANALYSIS (lightweight pixel-based, no heavy ML) ---- */
// We use a simple canvas-based mouth detection that works in all browsers.
// No external libraries needed — analyzes the mouth region pixels in real-time.

function analyzeMouthPixels(video) {
  if (!video.videoWidth) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Draw the center-bottom portion of the face (mouth area)
    const sx = video.videoWidth * 0.25, sy = video.videoHeight * 0.45;
    const sw = video.videoWidth * 0.5, sh = video.videoHeight * 0.4;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 64, 48);
    const data = ctx.getImageData(0, 0, 64, 48).data;

    // Analyze rows for darkness (mouth opening creates dark gap)
    const rowDarkness = [];
    for (let y = 0; y < 48; y++) {
      let darkPixels = 0;
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 100) darkPixels++;
      }
      rowDarkness.push(darkPixels / 64);
    }

    // Find the darkest band (mouth opening)
    let maxDark = 0, mouthRow = 24;
    for (let y = 8; y < 40; y++) {
      if (rowDarkness[y] > maxDark) { maxDark = rowDarkness[y]; mouthRow = y; }
    }

    // Aperture: how open the mouth is (dark pixels in center rows)
    const aperture = clamp(Math.round(maxDark * 150), 0, 100);

    // Width: how many columns in the mouth row are dark
    let darkCols = 0;
    const row = mouthRow;
    for (let x = 0; x < 64; x++) {
      const i = (row * 64 + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < 120) darkCols++;
    }
    const width = clamp(Math.round((darkCols / 64) * 130), 0, 100);

    // Movement: variance between rows (lip movement)
    let variance = 0;
    for (let y = 1; y < 48; y++) {
      variance += Math.abs(rowDarkness[y] - rowDarkness[y - 1]);
    }
    const movement = clamp(Math.round(variance * 80), 0, 100);

    return { aperture, width, movement };
  } catch (e) {
    return null;
  }
}

function getSoundTargets(soundId) {
  const targets = {
    r: { apMin: 25, apMax: 58, wMin: 20, wMax: 55, desc: 'Rounded lips, tongue curled back' },
    l: { apMin: 35, apMax: 72, wMin: 35, wMax: 78, desc: 'Open mouth, tongue tip up' },
    s: { apMin: 12, apMax: 45, wMin: 45, wMax: 82, desc: 'Small opening, lips spread' },
    sh: { apMin: 22, apMax: 55, wMin: 18, wMax: 58, desc: 'Rounded lips, tongue domed' },
    ch: { apMin: 25, apMax: 62, wMin: 22, wMax: 62, desc: 'Quick open release' },
    th: { apMin: 35, apMax: 75, wMin: 35, wMax: 78, desc: 'Open mouth, tongue forward' },
    k: { apMin: 28, apMax: 60, wMin: 22, wMax: 60, desc: 'Medium opening, tongue back' },
    g: { apMin: 28, apMax: 60, wMin: 22, wMax: 60, desc: 'Medium opening, voiced' },
    f: { apMin: 15, apMax: 45, wMin: 30, wMax: 65, desc: 'Teeth on lower lip' },
    v: { apMin: 15, apMax: 45, wMin: 30, wMax: 65, desc: 'Teeth on lower lip, voiced' },
    p: { apMin: 8, apMax: 35, wMin: 20, wMax: 55, desc: 'Lips pressed together' },
    b: { apMin: 8, apMax: 35, wMin: 20, wMax: 55, desc: 'Lips pressed, voiced' },
    t: { apMin: 15, apMax: 48, wMin: 25, wMax: 60, desc: 'Tongue tip on ridge' },
    d: { apMin: 15, apMax: 48, wMin: 25, wMax: 60, desc: 'Tongue tip on ridge, voiced' },
    n: { apMin: 10, apMax: 40, wMin: 25, wMax: 60, desc: 'Lips gently closed, nasal' },
    m: { apMin: 5, apMax: 30, wMin: 18, wMax: 50, desc: 'Lips gently closed' },
    w: { apMin: 15, apMax: 40, wMin: 15, wMax: 45, desc: 'Tightly rounded lips' },
    y: { apMin: 18, apMax: 48, wMin: 30, wMax: 65, desc: 'Slightly spread lips' },
    z: { apMin: 12, apMax: 45, wMin: 45, wMax: 82, desc: 'Small opening, buzzing' },
    h: { apMin: 30, apMax: 65, wMin: 25, wMax: 65, desc: 'Relaxed open mouth' },
  };
  return targets[soundId] || targets['r'];
}

function calcMouthScore(analysis, target) {
  if (!analysis) return { overall: 0, aperture: 0, width: 0, movement: 0, tip: 'Face not detected — move closer to camera' };
  const apScore = clamp(Math.round(100 - Math.abs(analysis.aperture - (target.apMin + target.apMax) / 2) * 2), 0, 100);
  const wScore = clamp(Math.round(100 - Math.abs(analysis.width - (target.wMin + target.wMax) / 2) * 1.5), 0, 100);
  const moveScore = analysis.movement > 15 ? 85 : analysis.movement > 5 ? 60 : 30;
  const overall = clamp(Math.round(apScore * 0.4 + wScore * 0.35 + moveScore * 0.25), 0, 100);
  let tip = target.desc;
  if (analysis.aperture < target.apMin) tip = 'Open your mouth a little more';
  else if (analysis.aperture > target.apMax) tip = 'Try a slightly smaller jaw opening';
  else if (analysis.width < target.wMin) tip = 'Widen or relax the lips more';
  else if (analysis.width > target.wMax) tip = 'Avoid spreading lips too wide';
  else if (overall >= 80) tip = 'Excellent mouth shape! Great job!';
  return { overall, aperture: apScore, width: wScore, movement: moveScore, tip };
}

/* ---------------------------- VIDEO RECORDING ---------------------------- */
async function startVideoRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true  // Record audio so doctor can hear the patient practicing
    });
    state.videoFlow.stream = stream;
    state.videoFlow.recording = true;
    state.videoFlow.chunks = [];
    state.videoFlow.analysisFrames = [];

    render();
    const preview = document.getElementById('videoRecordPreview');
    if (preview) {
      const video = document.createElement('video');
      video.id = 'liveRecordVideo';
      video.srcObject = stream;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.cssText = 'width:100%;border-radius:12px;transform:scaleX(-1);';
      preview.appendChild(video);

      // Start live mouth analysis loop
      video.onloadeddata = () => startLiveMouthAnalysis(video);
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm'
    });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) state.videoFlow.chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(state.videoFlow.chunks, { type: 'video/webm' });
      state.videoFlow.blob = blob;
      state.videoFlow.url = URL.createObjectURL(blob);
      stream.getTracks().forEach(t => t.stop());
      state.videoFlow.stream = null;
      state.videoFlow.recording = false;
      if (state.videoFlow.liveRAF) cancelAnimationFrame(state.videoFlow.liveRAF);
      render();
    };
    state.videoFlow.recorder = recorder;
    recorder.start(1000); // collect data every second for better audio sync
  } catch (e) {
    showToast('Could not access camera/microphone. Please check permissions.', 'error');
    state.videoFlow.recording = false;
    render();
  }
}

function startLiveMouthAnalysis(video) {
  const target = getSoundTargets(state.currentSoundId);
  let frameCount = 0;

  function loop() {
    if (!state.videoFlow.recording) return;
    state.videoFlow.liveRAF = requestAnimationFrame(loop);

    frameCount++;
    if (frameCount % 3 !== 0) return; // analyze every 3rd frame for performance

    const analysis = analyzeMouthPixels(video);
    if (analysis) {
      const score = calcMouthScore(analysis, target);
      state.videoFlow.analysisFrames.push({
        t: Date.now(),
        ap: analysis.aperture,
        w: analysis.width,
        mv: analysis.movement,
        sc: score.overall
      });

      // Update live meters in DOM
      const apBar = document.getElementById('liveAperture');
      const wBar = document.getElementById('liveWidth');
      const mvBar = document.getElementById('liveMovement');
      const scoreEl = document.getElementById('liveOverallScore');
      const tipEl = document.getElementById('liveTip');

      if (apBar) apBar.style.width = analysis.aperture + '%';
      if (wBar) wBar.style.width = analysis.width + '%';
      if (mvBar) mvBar.style.width = analysis.movement + '%';
      if (scoreEl) scoreEl.textContent = score.overall + '%';
      if (tipEl) tipEl.textContent = score.tip;
    }
  }
  loop();
}

function stopVideoRecording() {
  if (state.videoFlow.recorder && state.videoFlow.recorder.state !== 'inactive') {
    state.videoFlow.recorder.stop();
  }
}

function discardVideo() {
  if (state.videoFlow.url) URL.revokeObjectURL(state.videoFlow.url);
  state.videoFlow = { recording: false, stream: null, recorder: null, chunks: [], blob: null, url: null, analysisFrames: [], liveRAF: null };
  render();
}

async function submitVideoToDoctor() {
  if (!state.videoFlow.blob) return;
  const sound = getSound(state.currentSoundId);
  const target = currentTargetText();
  const result = state.rec.lastResult;
  const frames = state.videoFlow.analysisFrames || [];

  // Compute summary analysis from all frames
  const avgAp = frames.length ? Math.round(frames.reduce((a, f) => a + f.ap, 0) / frames.length) : 0;
  const avgW = frames.length ? Math.round(frames.reduce((a, f) => a + f.w, 0) / frames.length) : 0;
  const avgMv = frames.length ? Math.round(frames.reduce((a, f) => a + f.mv, 0) / frames.length) : 0;
  const avgSc = frames.length ? Math.round(frames.reduce((a, f) => a + f.sc, 0) / frames.length) : 0;
  const peakAp = frames.length ? Math.max(...frames.map(f => f.ap)) : 0;
  const peakMv = frames.length ? Math.max(...frames.map(f => f.mv)) : 0;

  const analysisData = JSON.stringify({
    frames: frames.length,
    avgAperture: avgAp, avgWidth: avgW, avgMovement: avgMv, avgScore: avgSc,
    peakAperture: peakAp, peakMovement: peakMv,
    target: getSoundTargets(state.currentSoundId),
    soundId: state.currentSoundId, level: state.currentLevel,
    audioScore: result?.score || 0, transcript: result?.transcript || '',
    summary: `Mouth analysis: ${avgSc}% match. Aperture: ${avgAp}%, Width: ${avgW}%, Movement: ${avgMv}%. Audio: ${result?.score || 0}%.`
  });

  const formData = new FormData();
  formData.append('video', state.videoFlow.blob, 'practice.webm');
  formData.append('soundId', state.currentSoundId);
  formData.append('level', state.currentLevel);
  formData.append('targetText', target);
  formData.append('score', result?.score || avgSc);
  formData.append('notes', `Practice: ${sound?.label || ''} · ${state.currentLevel} · Audio: ${result?.score || 0}% · Mouth: ${avgSc}%`);
  formData.append('analysisData', analysisData);

  try {
    await apiUpload('/api/learner/submit-video', formData);
    showToast('Video + analysis sent to your doctor! 📹', 'success');
    discardVideo();
    const vidRes = await apiGet('/api/learner/videos');
    state.videoSubmissions = vidRes.videos || [];
    render();
  } catch (e) {
    showToast('Failed to send video. Please try again.', 'error');
  }
}

function showAssignDoctorModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.id = 'doctorModal';
  modal.innerHTML = `<div class="modal-card">
    <h3>🧑‍⚕️ Assign Your Doctor</h3>
    <p style="font-size:.9rem;color:var(--ink-soft);">Enter your doctor's email address. They will receive your practice video submissions for analysis.</p>
    <div class="field"><label>Doctor's Email</label><input id="modalDocEmail" type="email" placeholder="doctor@gmail.com"></div>
    <div class="result-actions" style="justify-content:flex-start;">
      <button class="btn btn-primary" onclick="assignDoctorFromModal()">Assign Doctor</button>
      <button class="btn btn-outline" onclick="document.getElementById('doctorModal').remove()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

async function assignDoctorFromModal() {
  const email = document.getElementById('modalDocEmail')?.value?.trim();
  if (!email) { showToast('Please enter a doctor email', 'error'); return; }
  try {
    await apiPost('/api/learner/assign-doctor', { doctorEmail: email });
    showToast('Doctor assigned successfully!', 'success');
    document.getElementById('doctorModal')?.remove();
    const progRes = await apiGet('/api/learner/progress');
    state.doctor = progRes.doctor;
    render();
  } catch (e) { showToast('Failed to assign doctor', 'error'); }
}

/* ---------------------------- PRACTICE FLOW ---------------------------- */
function startMic() {
  if (!state.consent) { state.showConsentModal = true; render(); return; }
  const target = currentTargetText();
  beginRecording(target, (res) => {
    if (res.error && !res.transcript) { state.rec.lastResult = { errorMessage: res.errorMessage || "Something went wrong." }; return; }
    let score, breakdown = null, bestTranscript = res.transcript;
    if (res.unsupported) { score = Math.round(60 + Math.random() * 25); }
    else { const assessed = assessAudioAttempt(target, res, getSound(state.currentSoundId), state.currentLevel); score = assessed.score; bestTranscript = assessed.transcript || res.transcript; }
    if (state.currentLevel === 'sentence') breakdown = wordLevelBreakdown(target, bestTranscript || '');
    state.rec.lastResult = { transcript: bestTranscript, score, confidence: res.confidence, breakdown };
    recordAttempt(state.currentSoundId, state.currentLevel, score);
    if (score >= 85) triggerConfetti();
  });
}
function stopMic() { endRecording(); }

async function recordAttempt(soundId, level, score) {
  try {
    await apiPost('/api/learner/attempt', { soundId, level, score, transcript: state.rec.lastResult?.transcript, targetText: currentTargetText() });
    const progRes = await apiGet('/api/learner/progress');
    state.progress = progRes.progress || [];
  } catch (e) { console.error('Record attempt error:', e); }
}

function continuePractice() {
  state.rec.lastResult = null; state.rec.transcript = '';
  render();
}

function consentModal() {
  return `<div class="modal-backdrop"><div class="modal-card">
    <h3>Before you record…</h3>
    <p style="font-size:.9rem;color:var(--ink-soft);">This uses your device's microphone and your browser's built-in speech recognition to give live feedback.</p>
    <div class="checkbox-row" style="margin:16px 0;"><input type="checkbox" id="consentCheck"><label for="consentCheck">I understand and agree to use the microphone for this session.</label></div>
    <button class="btn btn-primary btn-block" onclick="tryAcceptConsent()">Continue</button>
  </div></div>`;
}
function tryAcceptConsent() {
  const box = document.getElementById('consentCheck');
  if (box && box.checked) { acceptConsent(); render(); }
}

/* ---------------------------- VIEW: PROGRESS ---------------------------- */
function viewProgress() {
  const soundLabels = state.sounds.map(s => s.label);
  const soundVals = state.sounds.map(s => { const p = state.progress.find(pr => pr.sound_id === s.sound_id); return p?.points || 0; });
  const trend = lastN(state.attempts.map(a => a.score), 10);

  return `
  <div class="wrap" style="padding-top:28px;">
    <div class="page-head"><h2>Your Progress</h2></div>
    <div class="dashboard-grid">
      <div class="stat-card"><div class="num">${state.progress.reduce((a, p) => a + (p.sessions || 0), 0)}</div><div class="lbl">Practice sessions</div></div>
      <div class="stat-card"><div class="num">${state.attempts.length}</div><div class="lbl">Total attempts</div></div>
      <div class="stat-card"><div class="num">🔥${state.progress.reduce((a, p) => Math.max(a, p.streak || 0), 0)}</div><div class="lbl">Best streak</div></div>
      <div class="stat-card"><div class="num">${state.progress.reduce((a, p) => a + (p.points || 0), 0)}</div><div class="lbl">Points earned</div></div>
    </div>
    <div class="two-col">
      <div class="card"><h3>Points by sound</h3><canvas id="barChart" style="width:100%;height:220px;"></canvas></div>
      <div class="card"><h3>Recent trend</h3><canvas id="lineChart" style="width:100%;height:220px;"></canvas></div>
    </div>
  </div>`;
}

/* ---------------------------- VIEW: VIDEOS ---------------------------- */
function viewVideos() {
  return `<div class="wrap" style="padding-top:28px;">
    <div class="page-head"><h2>Video Submissions</h2><span class="pill">${state.videoSubmissions.length} videos</span></div>
    ${!state.doctor ? `<div class="card" style="margin-bottom:16px;"><p>📧 <strong>No doctor assigned.</strong> <button class="btn btn-ghost btn-sm" onclick="showAssignDoctorModal()">Add Doctor Email</button> to start sharing practice videos.</p></div>` : ''}
    ${state.videoSubmissions.length ? `<div class="video-list">
      ${state.videoSubmissions.map(v => `
        <div class="video-item">
          <div>
            <div style="font-weight:700;">${esc(v.sound_id || '')} · ${esc(v.level || '')} level</div>
            <div style="font-size:.8rem;color:var(--muted);">Score: ${v.score || 0}% · ${new Date(v.created_at).toLocaleDateString()}</div>
          </div>
          <div class="chip-row">
            <span class="video-status ${v.status}">${v.status === 'feedback_given' ? '✅ Feedback' : v.status === 'reviewed' ? '👁️ Reviewed' : '⏳ Pending'}</span>
          </div>
        </div>
        ${v.doctor_feedback ? `<div class="feedback-card"><div class="feedback-header"><strong>Doctor's Feedback</strong>${v.doctor_rating ? `<div class="feedback-stars">${'⭐'.repeat(v.doctor_rating)}</div>` : ''}</div><div class="feedback-text">${esc(v.doctor_feedback)}</div></div>` : ''}
      `).join('')}
    </div>` : '<div class="card"><p style="color:var(--muted);">No video submissions yet. Practice a sound and send a video to your doctor!</p></div>'}
  </div>`;
}

/* ---------------------------- VIEW: PROFILE ---------------------------- */
function viewProfile() {
  return `<div class="wrap" style="padding-top:28px;max-width:640px;">
    <div class="page-head"><h2>Profile</h2></div>
    <div class="card">
      <div class="field"><label>Name</label><input type="text" value="${esc(state.user?.name || '')}" disabled></div>
      <div class="field"><label>Email</label><input type="email" value="${esc(state.user?.email || '')}" disabled></div>
      <div class="field"><label>Role</label><input type="text" value="${state.user?.role === 'doctor' ? 'Doctor' : 'Learner'}" disabled></div>
      <div class="field"><label>Interface language</label>
        <select onchange="setLang(this.value)">
          <option value="en" ${state.lang === 'en' ? 'selected' : ''}>English</option>
          <option value="ta" ${state.lang === 'ta' ? 'selected' : ''}>தமிழ் (Tamil)</option>
        </select>
      </div>
      ${state.role === 'learner' ? `
      <hr class="divider">
      <h3>Doctor Assignment</h3>
      ${state.doctor ? `<p style="font-size:.9rem;">🧑‍⚕️ <strong>${esc(state.doctor.name)}</strong> (${esc(state.doctor.email)})</p>
        <button class="btn btn-outline btn-sm" onclick="showAssignDoctorModal()">Change Doctor</button>` :
        `<p style="font-size:.9rem;color:var(--muted);">No doctor assigned yet.</p>
        <button class="btn btn-ghost btn-sm" onclick="showAssignDoctorModal()">Add Doctor Email</button>`}
      ` : ''}
      <hr class="divider">
      <p style="font-size:.85rem;color:var(--ink-soft);">Smart Articulation Training System is a training aid and does not replace professional diagnosis or therapy.</p>
      <button class="btn btn-outline btn-block" onclick="logout()">Log out</button>
    </div>
  </div>`;
}

/* ---------------------------- DOCTOR VIEWS ---------------------------- */
function viewDoctorHome() {
  return `<div class="wrap" style="padding-top:28px;">
    <div class="page-head"><h2>Doctor Dashboard</h2><span class="pill">${state.doctorLearners.length} patients</span></div>
    <p style="color:var(--ink-soft)">Review patient progress and video submissions.</p>
    ${state.doctorLearners.length ? state.doctorLearners.map(l => `
      <div class="learner-row" onclick="openDoctorLearner(${l.id})" style="cursor:pointer;">
        <div>
          <div class="learner-name">${esc(l.name)}</div>
          <div style="font-size:.8rem;color:var(--muted)">${l.totalAttempts} attempts · Avg ${l.avgScore}%</div>
        </div>
        <div class="chip-row">
          <span class="mini-chip">📹 ${l.videoCount} videos</span>
          ${l.pendingVideos ? `<span class="mini-chip warn">⏳ ${l.pendingVideos} pending</span>` : ''}
        </div>
      </div>
    `).join('') : '<div class="card"><p style="color:var(--muted);">No patients assigned to you yet. Patients will appear here when they add your email.</p></div>'}
  </div>`;
}

async function openDoctorLearner(learnerId) {
  try {
    const res = await apiGet(`/api/doctor/learner/${learnerId}`);
    state.doctorActiveLearner = res;
    state.activeLearnerId = learnerId;
    state.view = 'learnerDetail';
    render();
  } catch (e) { showToast('Failed to load patient data', 'error'); }
}

function viewLearnerDetail() {
  const data = state.doctorActiveLearner;
  if (!data) return `<div class="wrap" style="padding-top:28px;">Loading... <button class="btn btn-ghost" onclick="goTo('doctorHome')">Back</button></div>`;
  const { learner, progress, recentAttempts, videos, notes, assigned } = data;

  return `<div class="wrap" style="padding-top:24px;">
    <div class="breadcrumbs"><button onclick="goTo('doctorHome')">← All patients</button></div>
    <div class="page-head"><h2>${esc(learner.name)}</h2></div>

    <div class="dashboard-grid">
      <div class="stat-card"><div class="num">${progress.reduce((a, p) => a + (p.sessions || 0), 0)}</div><div class="lbl">Sessions</div></div>
      <div class="stat-card"><div class="num">${recentAttempts.length}</div><div class="lbl">Recent attempts</div></div>
      <div class="stat-card"><div class="num">📹 ${videos.length}</div><div class="lbl">Videos</div></div>
      <div class="stat-card"><div class="num">${progress.reduce((a, p) => a + (p.points || 0), 0)}</div><div class="lbl">Points</div></div>
    </div>

    <div class="two-col">
      <div class="card">
        <h3>Assigned Sounds</h3>
        <div class="chip-row">${assigned.map(s => `<span class="mini-chip">${esc(s.label)} (${esc(s.category)})</span>`).join('') || '<span style="color:var(--muted)">No sounds assigned</span>'}</div>
        <hr class="divider">
        <h3>Recent Attempts</h3>
        ${recentAttempts.length ? recentAttempts.slice(0, 10).map(a => `<div class="attempt-row"><span>${esc(a.sound_id)} · ${esc(a.level)}</span><span class="mono">${a.score}%</span></div>`).join('') : '<p style="color:var(--muted);font-size:.85rem;">No attempts yet.</p>'}
      </div>
      <div class="card">
        <h3>Video Submissions</h3>
        ${videos.length ? videos.map(v => {
          let analysis = null;
          try { analysis = v.analysis_json ? JSON.parse(v.analysis_json) : null; } catch(e) {}
          return `
          <div style="margin-bottom:16px;padding:16px;background:var(--surface-2);border-radius:12px;border-left:4px solid ${v.status === 'feedback_given' ? 'var(--success)' : 'var(--accent)'};">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <div><strong>${esc(v.sound_id || '')} · ${esc(v.level || '')}</strong><br><span style="font-size:.8rem;color:var(--muted);">${new Date(v.created_at).toLocaleDateString()} · Score: ${v.score}%</span></div>
              <span class="video-status ${v.status}">${v.status === 'feedback_given' ? '✅ Feedback sent' : '⏳ Pending review'}</span>
            </div>

            <!-- Video player with audio — doctor can hear the patient practicing -->
            <div style="border-radius:12px;overflow:hidden;margin:10px 0;background:#000;">
              <video src="${v.video_path}" controls playsinline style="width:100%;max-height:320px;display:block;"></video>
            </div>
            <p style="font-size:.75rem;color:var(--muted);margin:4px 0 10px;">🔊 Video includes audio — listen to hear the patient's pronunciation practice.</p>

            ${analysis ? `
            <!-- Analysis Summary -->
            <div style="background:var(--surface);border-radius:10px;padding:12px;margin:10px 0;">
              <div style="font-weight:800;font-size:.85rem;margin-bottom:8px;">📊 Mouth Movement Analysis</div>
              <div class="facts-list" style="margin:0;">
                <div class="fact-row"><div class="k">Overall</div><div class="v"><strong>${analysis.avgScore || 0}%</strong> match</div></div>
                <div class="fact-row"><div class="k">Aperture</div><div class="v">${analysis.avgAperture || 0}% avg · ${analysis.peakAperture || 0}% peak</div></div>
                <div class="fact-row"><div class="k">Width</div><div class="v">${analysis.avgWidth || 0}% avg</div></div>
                <div class="fact-row"><div class="k">Movement</div><div class="v">${analysis.avgMovement || 0}% avg · ${analysis.peakMovement || 0}% peak</div></div>
                <div class="fact-row"><div class="k">Audio</div><div class="v">${analysis.audioScore || 0}% · "${esc(analysis.transcript || '—')}"</div></div>
                <div class="fact-row"><div class="k">Frames</div><div class="v">${analysis.frames || 0} analyzed</div></div>
              </div>
              ${analysis.target ? `<p style="font-size:.78rem;color:var(--muted);margin:8px 0 0;">Target: ${esc(analysis.target.desc || '')}</p>` : ''}
            </div>
            ` : ''}

            <!-- Doctor feedback form -->
            <div style="margin-top:10px;">
              <textarea id="feedback-${v.id}" rows="3" placeholder="Write your diagnosis and feedback for this patient..." style="width:100%;padding:10px;border:2px solid var(--line);border-radius:10px;font-family:var(--font-body);font-size:.85rem;">${esc(v.doctor_feedback || '')}</textarea>
              <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">
                <select id="rating-${v.id}" style="padding:8px;border:2px solid var(--line);border-radius:10px;font-size:.85rem;">
                  <option value="">Rate performance</option>
                  ${[1,2,3,4,5].map(r => `<option value="${r}" ${v.doctor_rating === r ? 'selected' : ''}>${'⭐'.repeat(r)} ${['Poor','Fair','Good','Very Good','Excellent'][r-1]}</option>`).join('')}
                </select>
                <button class="btn btn-primary btn-sm" onclick="submitDoctorFeedback(${v.id})">📤 Send Feedback to Patient</button>
              </div>
            </div>
          </div>`;
        }).join('') : '<p style="color:var(--muted);font-size:.85rem;">No videos submitted yet.</p>'}

        <hr class="divider">
        <h3>Doctor Notes</h3>
        <textarea id="newNote" rows="3" placeholder="Add a clinical note..." style="width:100%;padding:8px;border:2px solid var(--line);border-radius:8px;font-family:var(--font-body);font-size:.85rem;"></textarea>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="addDoctorNote(${learner.id})">Add Note</button>
        ${notes.length ? `<div style="margin-top:12px;">${notes.map(n => `<div style="padding:8px 12px;background:var(--surface-2);border-radius:8px;margin-bottom:6px;font-size:.85rem;"><strong>${new Date(n.created_at).toLocaleDateString()}</strong><br>${esc(n.note)}</div>`).join('')}</div>` : ''}
      </div>
    </div>
  </div>`;
}

async function submitDoctorFeedback(videoId) {
  const feedback = document.getElementById(`feedback-${videoId}`)?.value;
  const rating = document.getElementById(`rating-${videoId}`)?.value;
  try {
    await apiPost('/api/doctor/video-feedback', { videoId, feedback, rating: rating ? parseInt(rating) : null });
    showToast('Feedback sent!', 'success');
    // Reload
    const res = await apiGet(`/api/doctor/learner/${state.activeLearnerId}`);
    state.doctorActiveLearner = res;
    render();
  } catch (e) { showToast('Failed to send feedback', 'error'); }
}

async function addDoctorNote(learnerId) {
  const note = document.getElementById('newNote')?.value;
  if (!note) return;
  try {
    await apiPost('/api/doctor/note', { learnerId, note });
    showToast('Note added!', 'success');
    const res = await apiGet(`/api/doctor/learner/${state.activeLearnerId}`);
    state.doctorActiveLearner = res;
    render();
  } catch (e) { showToast('Failed to add note', 'error'); }
}

/* ---------------------------- ROUTER / RENDER ---------------------------- */
function goTo(view) {
  if (view !== 'practiceSession' && state.camera.enabled) stopCamera();
  state.view = view;
  render();
}
function setLang(l) { state.lang = l; render(); }

function bodyForView() {
  switch (state.view) {
    case 'landing': return viewLanding();
    case 'login': return viewLogin();
    case 'learnerHome': return viewLearnerHome();
    case 'practiceLibrary': return viewPracticeLibrary();
    case 'soundLearn': return viewSoundLearn();
    case 'practiceSession': return viewPracticeSession();
    case 'progress': return viewProgress();
    case 'videos': return viewVideos();
    case 'profile': return viewProfile();
    case 'doctorHome': return viewDoctorHome();
    case 'learnerDetail': return viewLearnerDetail();
    default: return viewLanding();
  }
}

function footerHTML() {
  return `<footer class="site-footer">Smart Articulation Training System — ${state.sounds.length} sounds · 3 therapy levels · Video practice to your doctor · Not a substitute for professional speech-language therapy.</footer>`;
}

function render() {
  ['mouth3d-learn', 'mouth3d-coach'].forEach(disposeMouth3D);
  const app = document.getElementById('app');
  app.innerHTML = `${topbar()}<main>${bodyForView()}</main>${footerHTML()}`;
  if (state.view === 'progress') {
    const soundLabels = state.sounds.map(s => s.label);
    const soundVals = state.sounds.map(s => { const p = state.progress.find(pr => pr.sound_id === s.sound_id); return p?.points || 0; });
    drawBarChart(document.getElementById('barChart'), soundLabels, soundVals);
    drawLineChart(document.getElementById('lineChart'), lastN(state.attempts.map(a => a.score), 10));
  }
  if (document.getElementById('mouth3d-learn')) {
    mountMouth3D('mouth3d-learn', state.currentSoundId, {
      rotate: diagramState.rotate, zoom: diagramState.zoom * 100,
      showLabels: diagramState.showLabels, slow: diagramState.slow, playing: diagramState.playing
    });
  }
  if (document.getElementById('mouth3d-coach')) {
    mountMouth3D('mouth3d-coach', state.currentSoundId, { rotate: -18, showLabels: false, playing: true });
  }
}
/* ---------------------------- CAMERA (minimal for now) ---------------------------- */
function stopCamera() {
  if (state.camera.rafId) cancelAnimationFrame(state.camera.rafId);
  if (state.camera.stream) state.camera.stream.getTracks().forEach(t => t.stop());
  state.camera.enabled = false; state.camera.stage = 'off'; state.camera.stream = null; state.camera.rafId = null;
}
function toggleCameraCoaching() {
  if (state.camera.enabled) { stopCamera(); render(); return; }
  if (!state.camera.consent) { state.camera.showConsentModal = true; render(); return; }
  state.camera.enabled = true; render();
}

/* ---------------------------- INIT ---------------------------- */
async function init() {
  const savedToken = localStorage.getItem('sat_token');
  const savedUser = localStorage.getItem('sat_user');
  if (savedToken && savedUser) {
    state.token = savedToken;
    try {
      state.user = JSON.parse(savedUser);
      state.role = state.user.role;
      await loadUserData();
      state.view = state.role === 'learner' ? 'learnerHome' : 'doctorHome';
    } catch (e) {
      localStorage.removeItem('sat_token');
      localStorage.removeItem('sat_user');
      state.token = null; state.user = null;
    }
  } else {
    // Load sounds for landing page
    try {
      const res = await fetch('/api/sounds');
      if (res.ok) { const data = await res.json(); state.sounds = data.sounds || []; }
    } catch (e) { }
  }
  render();
}

function logout() {
  if (state.camera.enabled) stopCamera();
  state.token = null; state.user = null; state.role = null; state.view = 'landing';
  state.progress = []; state.attempts = []; state.videoSubmissions = []; state.doctor = null;
  localStorage.removeItem('sat_token');
  localStorage.removeItem('sat_user');
  render();
}
// Make functions available to HTML onclick=""
window.goTo = goTo;
window.setRolePref = setRolePref;
window.setLang = setLang;
window.logout = logout;const googleBtn = document.getElementById("googleLoginBtn");

if (googleBtn) {
  googleBtn.addEventListener("click", async () => {
    try {
      const result = await signInWithPopup(auth, provider);
      const token = await result.user.getIdToken();

      const response = await fetch("/api/auth/google-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });

      const data = await response.json();

      if (response.ok) {
        localStorage.setItem("sat_token", data.token);
        localStorage.setItem("sat_user", JSON.stringify(data.user));

        state.token = data.token;
        state.user = data.user;
        state.role = data.user.role;

        await bootstrap();

        alert("Google Login Successful!");
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
      alert("Google Login Failed");
    }
  });
}   // <-- THIS WAS MISSING

init();