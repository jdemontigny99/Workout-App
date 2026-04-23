// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DAYS = ['Monday', 'Wednesday', 'Thursday', 'Friday'];

const KEYS = {
  completed: 'wt_completedIDs',
  workouts:  'wt_workouts',
  days:      'wt_days',
  dark:      'wt_isDarkMode',
  history:   'wt_weekHistory',
  logs:      'wt_logs',
  unit:      'wt_unit',
};

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  days:           [...DEFAULT_DAYS],
  workouts:       {},
  completedIDs:   new Set(),
  isDarkMode:     false,
  view:           'week',
  currentDay:     null,
  showModal:      false,
  editTarget:     null,
  filterCategory: null,
  showHistory:    false,
};

let pendingImg        = null;   // { dataURL } — uploaded file
let pendingImgURL     = null;   // string — pasted or auto-found URL
let editCurrentImg    = null;   // base64 of existing local image (edit mode)
let editCurrentImgURL = null;   // URL of existing URL image (edit mode)
let editImgRemoved    = false;
let showURLInput        = false;  // show URL text field in modal
let imageSearchResults  = null;   // null | [] | [{url,name,score}] — image picker state
let modalFormCache      = null;   // { name, category, notes } preserved across async renders
let _deferredInstallPrompt = null; // BeforeInstallPromptEvent
let _undoPendingSet   = null;   // { workoutId, setIndex, setData, timeoutId }
let _toastTimeout     = null;

// ─── Timer ────────────────────────────────────────────────────────────────────

const timer = {
  preset:     60,
  seconds:    60,
  initial:    60,
  running:    false,
  intervalId: null,
  expanded:   false,
};

// ─── Wake Lock ────────────────────────────────────────────────────────────────

let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) {}
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}

// Re-acquire if page becomes visible while in day view
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.view === 'day') acquireWakeLock();
});

// ─── IndexedDB ────────────────────────────────────────────────────────────────

let _db = null;

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('WorkoutTrackerDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('images', { keyPath: 'key' });
    req.onsuccess = e => { _db = e.target.result; resolve(); };
    req.onerror   = e => reject(e.target.error);
  });
}
function ensureDB() { return _db ? Promise.resolve() : initDB(); }

async function saveImage(key, dataURL) {
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = _db.transaction('images', 'readwrite');
    tx.objectStore('images').put({ key, dataURL });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

async function getImage(key) {
  if (!key) return null;
  await ensureDB();
  return new Promise((resolve, reject) => {
    const req = _db.transaction('images').objectStore('images').get(key);
    req.onsuccess = e => resolve(e.target.result?.dataURL ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteImage(key) {
  if (!key) return;
  await ensureDB();
  return new Promise((resolve, reject) => {
    const tx = _db.transaction('images', 'readwrite');
    tx.objectStore('images').delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

// ─── Image Utilities ──────────────────────────────────────────────────────────

function compressImage(file, maxWidth = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function pickImage() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async e => {
      const file = e.target.files[0];
      if (!file) { resolve(null); return; }
      try { resolve(await compressImage(file)); } catch { resolve(null); }
    };
    input.oncancel = () => resolve(null);
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 30000);
  });
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadState() {
  const dark = localStorage.getItem(KEYS.dark);
  state.isDarkMode = dark !== null
    ? dark === 'true'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;

  const comp = localStorage.getItem(KEYS.completed);
  try {
    const parsed = comp ? JSON.parse(comp) : [];
    state.completedIDs = new Set(Array.isArray(parsed) ? parsed : []);
  } catch { state.completedIDs = new Set(); }

  const savedDays = localStorage.getItem(KEYS.days);
  try { state.days = savedDays ? JSON.parse(savedDays) : [...DEFAULT_DAYS]; }
  catch { state.days = [...DEFAULT_DAYS]; }

  const savedWorkouts = localStorage.getItem(KEYS.workouts);
  if (savedWorkouts) {
    try { state.workouts = JSON.parse(savedWorkouts); } catch { state.workouts = {}; }
  }
  state.days.forEach(d => { if (!state.workouts[d]) state.workouts[d] = []; });
}

function saveState() {
  try {
    localStorage.setItem(KEYS.completed, JSON.stringify([...state.completedIDs]));
    localStorage.setItem(KEYS.days,      JSON.stringify(state.days));
    localStorage.setItem(KEYS.workouts,  JSON.stringify(state.workouts));
    localStorage.setItem(KEYS.dark,      String(state.isDarkMode));
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      showToast('Storage full — old logs trimmed to free space.', { duration: 5000 });
      pruneOldLogs();
      try { // retry once after pruning
        localStorage.setItem(KEYS.completed, JSON.stringify([...state.completedIDs]));
        localStorage.setItem(KEYS.days,      JSON.stringify(state.days));
        localStorage.setItem(KEYS.workouts,  JSON.stringify(state.workouts));
        localStorage.setItem(KEYS.dark,      String(state.isDarkMode));
      } catch (_) {}
    }
  }
}

// ─── Set / Rep Logs ───────────────────────────────────────────────────────────

function loadLogs() {
  try { return JSON.parse(localStorage.getItem(KEYS.logs) || '{}'); } catch { return {}; }
}
function saveLogs(logs) {
  try { localStorage.setItem(KEYS.logs, JSON.stringify(logs)); }
  catch (e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      showToast('Storage full — trimming old logs.', { duration: 5000 });
      pruneOldLogs();
      try { localStorage.setItem(KEYS.logs, JSON.stringify(logs)); } catch (_) {}
    }
  }
}

function pruneOldLogs() {
  const logs = loadLogs();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffKey = cutoff.toISOString().split('T')[0];
  const pruned = Object.fromEntries(Object.entries(logs).filter(([k]) => k >= cutoffKey));
  if (Object.keys(pruned).length !== Object.keys(logs).length) saveLogs(pruned);
}
function getTodayKey()  { return new Date().toISOString().split('T')[0]; }

function getWeightUnit() { return localStorage.getItem(KEYS.unit) || 'lbs'; }
function setWeightUnit(u) { localStorage.setItem(KEYS.unit, u); }

function getTodaySets(workoutId, logs = loadLogs(), todayKey = getTodayKey()) {
  return logs[todayKey]?.[workoutId] || [];
}

function getLastSessionLog(workoutId, logs = loadLogs(), todayKey = getTodayKey()) {
  for (const date of Object.keys(logs).sort().reverse()) {
    if (date >= todayKey) continue;
    if (logs[date][workoutId]?.length > 0) return { date, sets: logs[date][workoutId] };
  }
  return null;
}

function logSet(workoutId, reps, weight, unit) {
  const logs  = loadLogs();
  const today = getTodayKey();
  if (!logs[today])            logs[today] = {};
  if (!logs[today][workoutId]) logs[today][workoutId] = [];
  logs[today][workoutId].push({ reps, weight, unit });
  saveLogs(logs);
  return logs[today][workoutId];
}

function removeSet(workoutId, setIndex) {
  const logs  = loadLogs();
  const today = getTodayKey();
  if (!logs[today]?.[workoutId]) return [];
  logs[today][workoutId].splice(setIndex, 1);
  saveLogs(logs);
  return logs[today][workoutId];
}

function formatSet(s) {
  const unit = s.unit || 'lbs';
  const w = s.weight > 0 ? `${s.weight}${unit} × ` : '';
  return `${w}${s.reps} rep${s.reps !== 1 ? 's' : ''}`;
}

function formatLastSession(last) {
  if (!last || last.sets.length === 0) return null;
  const d    = new Date(last.date + 'T00:00:00');
  const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const sets  = last.sets;
  const first = sets[0];
  const unit  = first.unit || 'lbs';
  const wPart = first.weight > 0 ? ` @ ${first.weight}${unit}` : '';
  const summary = `${sets.length}×${first.reps}${wPart}`;
  return `${summary} · ${label}`;
}

function renderSetsList(workoutId, sets) {
  if (sets.length === 0) return '';
  return sets.map((s, i) => `
    <div class="log-set-row">
      <span class="log-set-badge">Set ${i + 1}</span>
      <span class="log-set-detail">${esc(formatSet(s))}</span>
      <button class="log-set-remove" data-action="remove-set"
              data-workout-id="${esc(workoutId)}" data-set-index="${i}">✕</button>
    </div>`).join('');
}

function renderLogSection(workoutId, logs = loadLogs(), todayKey = getTodayKey()) {
  const todaySets  = getTodaySets(workoutId, logs, todayKey);
  const lastSess   = getLastSessionLog(workoutId, logs, todayKey);
  const lastLabel  = formatLastSession(lastSess);
  const unit       = getWeightUnit();

  return `
    <div class="workout-log" id="workout-log-${esc(workoutId)}">
      ${lastLabel ? `<div class="log-last-session">Last session: ${esc(lastLabel)}</div>` : ''}
      <div class="log-sets-list" id="log-sets-${esc(workoutId)}">${renderSetsList(workoutId, todaySets)}</div>
      <div class="log-add-row">
        <input class="log-input log-weight" type="text" inputmode="decimal"
               id="log-weight-${esc(workoutId)}" placeholder="Weight" autocomplete="off">
        <button class="log-unit-btn" data-action="toggle-unit"
                data-workout-id="${esc(workoutId)}" data-unit="${esc(unit)}">${esc(unit)}</button>
        <span class="log-sep">×</span>
        <input class="log-input log-reps" type="text" inputmode="numeric"
               id="log-reps-${esc(workoutId)}" placeholder="Reps" autocomplete="off">
        <button class="log-add-btn" data-action="log-set"
                data-workout-id="${esc(workoutId)}">+ Set</button>
      </div>
    </div>`;
}

// ─── Week History ─────────────────────────────────────────────────────────────

function getWeekKey(date = new Date()) {
  const d   = new Date(date);
  const day = d.getDay();
  return new Date(d.setDate(d.getDate() - day + (day === 0 ? -6 : 1))).toISOString().split('T')[0];
}

function getPrevWeekKey(key) {
  const d = new Date(key + 'T00:00:00');
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

function loadWeekHistory() {
  try { return JSON.parse(localStorage.getItem(KEYS.history) || '{}'); } catch { return {}; }
}

function saveWeekSnapshot() {
  const history = loadWeekHistory();
  const key = getWeekKey();
  history[key] = {};
  for (const day of state.days) {
    const w = state.workouts[day] || [];
    history[key][day] = { done: w.filter(x => state.completedIDs.has(x.id)).length, total: w.length };
  }
  try { localStorage.setItem(KEYS.history, JSON.stringify(history)); } catch {}
}

function weekKeyToLabel(key) {
  const d = new Date(key + 'T00:00:00');
  return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function calculateStreak() {
  const history   = loadWeekHistory();
  const curWeek   = getWeekKey();
  const sorted    = Object.keys(history).sort().reverse();
  let streak = 0, lastCounted = null;

  for (const key of sorted) {
    if (key > curWeek) continue;
    if (lastCounted !== null && key !== getPrevWeekKey(lastCounted)) break; // gap

    const week      = history[key];
    const totalDone = Object.values(week).reduce((s, d) => s + (d.done || 0), 0);

    if (totalDone === 0) {
      if (key === curWeek) continue; // current week in progress — don't break
      break;
    }
    streak++;
    lastCounted = key;
  }
  return streak;
}

// ─── Date Utilities ───────────────────────────────────────────────────────────

function getTodayDayName() {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];
}

// ─── Data Logic ───────────────────────────────────────────────────────────────

function getAllCategories() {
  const cats = new Set();
  for (const day of state.days)
    for (const w of (state.workouts[day] || []))
      if (w.Category) cats.add(w.Category);
  return [...cats].sort();
}

function getCategories(day) {
  return [...new Set((state.workouts[day] || []).map(w => w.Category).filter(Boolean))];
}

function toggleCompletion(id) {
  const wasCompleted = state.completedIDs.has(id);
  wasCompleted ? state.completedIDs.delete(id) : state.completedIDs.add(id);
  saveState();
  saveWeekSnapshot();

  const checkBtn = document.querySelector(`[data-action="toggle"][data-id="${CSS.escape(id)}"]`);
  if (checkBtn) {
    const nowDone = !wasCompleted;
    checkBtn.innerHTML = nowDone ? ICONS.checked : ICONS.circle;
    checkBtn.setAttribute('aria-label', nowDone ? 'Mark incomplete' : 'Mark complete');
    const item = checkBtn.closest('.workout-item');
    if (item) {
      item.querySelector('.workout-name')?.classList.toggle('done', nowDone);
      if (nowDone) {
        item.classList.remove('just-completed');
        void item.offsetWidth;
        item.classList.add('just-completed');
        setTimeout(() => item.classList.remove('just-completed'), 700);
      }
    }
  } else {
    render();
    if (state.view === 'day') loadDayImages(state.currentDay);
  }
}

function completeAll(day) {
  (state.workouts[day] || []).forEach(w => state.completedIDs.add(w.id));
  saveState(); saveWeekSnapshot(); render(); loadDayImages(day);
}

function resetAll() {
  if (!confirm('Reset all progress?\n\nThis clears completion status for every day.')) return;
  state.completedIDs.clear(); saveState(); saveWeekSnapshot(); render();
}

function resetDay(day) {
  if (!confirm(`Reset ${day}?\n\nThis clears completion for ${day} only.`)) return;
  (state.workouts[day] || []).forEach(w => state.completedIDs.delete(w.id));
  saveState(); saveWeekSnapshot(); render(); loadDayImages(day);
}

function addWorkout(day, name, category, notes, imgKey, imgURL) {
  if (!state.workouts[day]) state.workouts[day] = [];
  const id = uuid();
  state.workouts[day].push({ id, Day: day, Workout: name, Category: category || null, Notes: notes || null, _imgKey: imgKey || id, _imgURL: imgURL || null });
  saveState();
}

function editWorkout(day, workoutId, name, category, notes, newImgURL, clearImgURL) {
  const idx = (state.workouts[day] || []).findIndex(w => w.id === workoutId);
  if (idx === -1) return;
  const prev = state.workouts[day][idx];
  state.workouts[day][idx] = {
    ...prev,
    Workout:  name,
    Category: category || null,
    Notes:    notes    || null,
    _imgURL:  clearImgURL ? null : (newImgURL !== undefined ? newImgURL : prev._imgURL),
  };
  saveState();
}

async function deleteWorkout(day, workoutId) {
  const workouts = state.workouts[day];
  if (!workouts) return;
  const idx = workouts.findIndex(w => w.id === workoutId);
  if (idx === -1) return;
  const row = workouts[idx];
  if (row._imgKey) await deleteImage(row._imgKey);
  workouts.splice(idx, 1);
  state.completedIDs.delete(workoutId);
  saveState(); saveWeekSnapshot();
  // Clear stale filter if the deleted workout was the last one in the active category
  if (state.filterCategory && !getCategories(day).includes(state.filterCategory)) {
    state.filterCategory = null;
  }
  render(); loadDayImages(day);
}

function addDay(name) {
  const t = name.trim();
  if (!t) return false;
  if (state.days.map(d => d.toLowerCase()).includes(t.toLowerCase())) { showToast(`"${t}" already exists.`); return false; }
  state.days.push(t); state.workouts[t] = []; saveState(); return true;
}

function renameDay(oldName, newName) {
  const t = newName.trim();
  if (!t || oldName === t) return false;
  if (state.days.filter(d => d !== oldName).map(d => d.toLowerCase()).includes(t.toLowerCase())) { showToast(`"${t}" already exists.`); return false; }
  const idx = state.days.indexOf(oldName); if (idx === -1) return false;
  state.days[idx] = t;
  state.workouts[t] = (state.workouts[oldName] || []).map(w => ({ ...w, Day: t }));
  delete state.workouts[oldName];
  if (state.currentDay === oldName) state.currentDay = t;
  saveState(); return true;
}

async function deleteDay(day) {
  if (!confirm(`Delete "${day}" and all its workouts?\n\nThis cannot be undone.`)) return;
  for (const w of (state.workouts[day] || [])) {
    if (w._imgKey) await deleteImage(w._imgKey);
    state.completedIDs.delete(w.id);
  }
  state.days = state.days.filter(d => d !== day);
  delete state.workouts[day];
  saveState(); saveWeekSnapshot();
  if (state.currentDay === day) { state.view = 'week'; state.currentDay = null; state.showModal = false; state.editTarget = null; }
  render();
}

async function duplicateDay(sourceName) {
  const base = `${sourceName} (Copy)`;
  let name = base, n = 2;
  while (state.days.map(d => d.toLowerCase()).includes(name.toLowerCase())) name = `${base} ${n++}`;

  const sourceWorkouts = state.workouts[sourceName] || [];
  const newWorkouts = sourceWorkouts.map(w => ({ ...w, id: uuid(), _imgKey: uuid(), Day: name }));
  state.days.push(name);
  state.workouts[name] = newWorkouts;
  saveState();

  // Copy images in background
  for (let i = 0; i < sourceWorkouts.length; i++) {
    const src = sourceWorkouts[i];
    if (!src._imgKey) continue;
    const data = await getImage(src._imgKey);
    if (data) await saveImage(newWorkouts[i]._imgKey, data);
    else if (src._imgURL) fetchAndCacheImage(src._imgURL, newWorkouts[i]._imgKey).catch(() => {});
  }
  return name;
}

// ─── Timer ────────────────────────────────────────────────────────────────────

function setTimerPreset(s) {
  if (timer.running) return;
  timer.preset = timer.seconds = timer.initial = s;
  updateTimerDisplay();
}

function startTimer() {
  if (timer.running) return;
  timer.expanded = true;
  timer.initial  = timer.seconds > 0 ? timer.seconds : timer.preset;
  timer.seconds  = timer.initial;
  timer.running  = true;
  timer.intervalId = setInterval(tickTimer, 1000);
  replaceTimerCard();
}

function pauseTimer() {
  if (!timer.running) return;
  timer.running = false; clearInterval(timer.intervalId); timer.intervalId = null;
  updateTimerDisplay();
}

function resetTimer() {
  clearInterval(timer.intervalId); timer.intervalId = null;
  timer.running = false; timer.seconds = timer.preset; timer.initial = timer.preset;
  updateTimerDisplay();
  document.getElementById('timer-card')?.classList.remove('timer-done');
}

function tickTimer() {
  if (timer.seconds > 0) {
    timer.seconds--; updateTimerDisplay();
  } else {
    clearInterval(timer.intervalId); timer.intervalId = null; timer.running = false;
    updateTimerDisplay();
    playTimerBeep();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    document.getElementById('timer-card')?.classList.add('timer-done');
  }
}

function playTimerBeep() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const beep = (freq, start, dur, vol = 0.35) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    };
    beep(880,  0,    0.12);
    beep(880,  0.18, 0.12);
    beep(1047, 0.36, 0.28, 0.45); // higher final tone
  } catch (_) {}
}

function updateTimerDisplay() {
  const displayEl  = document.getElementById('timer-display');
  const progressEl = document.getElementById('timer-progress');
  const startBtn   = document.getElementById('timer-start-btn');
  const card       = document.getElementById('timer-card');
  if (!displayEl) return;

  const mins = Math.floor(timer.seconds / 60);
  const secs = timer.seconds % 60;
  displayEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;

  if (progressEl) progressEl.style.width = `${timer.initial > 0 ? (timer.seconds / timer.initial) * 100 : 100}%`;
  if (startBtn) startBtn.innerHTML = timer.running
    ? `${ICONS.timerPause}<span>Pause</span>`
    : `${ICONS.timerPlay}<span>Start</span>`;
  document.querySelectorAll('.timer-preset-btn').forEach(b => {
    b.disabled = timer.running;
    b.classList.toggle('active', !timer.running && Number(b.dataset.seconds) === timer.preset);
  });
  if (card) card.classList.toggle('timer-running', timer.running);
}

function replaceTimerCard() {
  const existing = document.getElementById('timer-card');
  if (!existing) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderTimerCard();
  existing.replaceWith(tmp.firstElementChild);
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportData() {
  const data = {
    version: 3, exportedAt: new Date().toISOString(),
    days: state.days, workouts: state.workouts,
    completedIDs: [...state.completedIDs],
    weekHistory: loadWeekHistory(),
    logs: loadLogs(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `workout-backup-${getTodayKey()}.json` });
  a.click(); URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.days || !data.workouts) throw new Error('Not a valid Workout Tracker backup.');
    state.days = data.days; state.workouts = data.workouts;
    state.completedIDs = new Set(data.completedIDs || []);
    if (data.weekHistory) { try { localStorage.setItem(KEYS.history, JSON.stringify(data.weekHistory)); } catch {} }
    if (data.logs)        saveLogs(data.logs);
    pruneOldLogs();
    saveState();
    render();
    if (state.view === 'day') loadDayImages(state.currentDay);
    showToast('Import successful! Photos not included in backups.', { duration: 5000 });
  } catch (err) { showToast(`Import failed: ${err.message}`, { duration: 6000 }); }
}

function triggerImport() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  input.onchange = e => { if (e.target.files[0]) importData(e.target.files[0]); };
  document.body.appendChild(input); input.click();
  setTimeout(() => input.remove(), 10000);
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.isDarkMode ? 'dark' : 'light');
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = state.isDarkMode ? '#000000' : '#f2f2f7';
}

function toggleDarkMode() {
  state.isDarkMode = !state.isDarkMode; applyTheme(); saveState(); render();
  if (state.view === 'day') loadDayImages(state.currentDay);
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const ICONS = {
  sun:          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  moon:         `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  chevron:      `<svg class="day-chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>`,
  chevronUp:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="18 15 12 9 6 15"/></svg>`,
  back:         `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="15 18 9 12 15 6"/></svg>`,
  reset:        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.11"/></svg>`,
  trash:        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  plus:         `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>`,
  plusSimple:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  camera:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  cameraBig:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="32" height="32"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  circle:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>`,
  checked:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="11" fill="#34c759"/><polyline points="7 12.5 10.5 16 17 9" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  edit:         `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  copy:         `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  history:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.11"/><polyline points="12 7 12 12 15 15"/></svg>`,
  export:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  import:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  timerPlay:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  timerPause:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  timerReset:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.11"/></svg>`,
  checkAll:     `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>`,
  dotsVertical: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`,
  dragHandle:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="4" y="6" width="16" height="2" rx="1"/><rect x="4" y="11" width="16" height="2" rx="1"/><rect x="4" y="16" width="16" height="2" rx="1"/></svg>`,
  flame:        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M12 2C9 6 7 8.5 7 12a5 5 0 0 0 10 0c0-2.5-1-4.5-2-6-1 2-1.5 2.5-2 3-.5-.5-1-2-1-4z" opacity=".8"/><path d="M12 8c-.5 2-.8 3-2 4a3 3 0 0 0 6 0c0-1.5-.5-2.5-1-3.5-.5 1-.8 1.5-1.5 1.5C13 9.5 12.5 9 12 8z"/></svg>`,
  link:         `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  sparkle:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"/><path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" opacity=".6"/></svg>`,
  install:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M12 2v13"/><path d="M7 10l5 5 5-5"/><rect x="2" y="17" width="20" height="5" rx="1"/></svg>`,
  copyTo:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M12 12v4"/><path d="M10 14l2 2 2-2"/></svg>`,
};

// ─── HTML Helpers ─────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Toast Notifications ─────────────────────────────────────────────────────

function showToast(msg, opts = {}) {
  document.getElementById('app-toast')?.remove();
  clearTimeout(_toastTimeout);

  const toast = document.createElement('div');
  toast.id = 'app-toast';
  toast.className = 'toast';

  const msgEl = document.createElement('span');
  msgEl.className = 'toast-msg';
  msgEl.textContent = msg;
  toast.appendChild(msgEl);

  if (opts.undo) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'toast-undo-btn';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => {
      clearTimeout(_toastTimeout);
      toast.remove();
      opts.undo();
    });
    toast.appendChild(undoBtn);
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  _toastTimeout = setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, opts.duration ?? 4000);
}

// ─── Image Search ─────────────────────────────────────────────────────────────
// Primary:  oss.exercisedb.dev — 1,500 exercises, animated GIFs, no API key
// Fallback: wger.de            — 345 exercises, static images, no API key
// Returns up to `limit` results sorted by name-match score so the best fits
// appear first. The user picks from a grid rather than trusting a single guess.

function _buildSearchTerms(name) {
  const terms = [name];
  const lower = name.toLowerCase();
  const modifiers = ['barbell', 'dumbbell', 'cable', 'machine', 'ez-bar', 'ez bar',
                     'smith machine', 'resistance band', 'kettlebell', 'band',
                     'incline', 'decline', 'seated', 'standing', 'lying', 'with'];
  let stripped = lower;
  for (const m of modifiers)
    stripped = stripped.replace(new RegExp(`\\b${m}\\b`, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
  if (stripped && stripped !== lower) terms.push(stripped);
  const words = name.split(/\s+/).filter(w => w.length > 2);
  if (words.length > 2) terms.push(words.slice(0, 2).join(' '));
  return [...new Set(terms)];
}

function _scoreMatch(candidateName, searchTerm) {
  const cn = candidateName.toLowerCase();
  const st = searchTerm.toLowerCase();
  if (cn === st) return 100;
  if (cn.startsWith(st)) return 90;
  if (cn.includes(st)) return Math.max(50, 80 - Math.round((cn.length - st.length) / 3));
  const words = st.split(/\s+/).filter(Boolean);
  const hits  = words.filter(w => cn.includes(w)).length;
  return Math.round((hits / Math.max(words.length, 1)) * 40);
}

async function fetchExerciseImages(name, limit = 8) {
  const searchTerms = _buildSearchTerms(name.trim());
  const seen    = new Set();
  const results = [];

  const add = (url, exName, term) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    results.push({ url, name: exName, score: _scoreMatch(exName, term) });
  };

  for (const term of searchTerms) {
    if (results.length >= limit * 2) break;
    const q = encodeURIComponent(term);

    // Fire both sources in parallel — roughly halves total search time
    await Promise.allSettled([

      // ── ExerciseDB: animated GIFs ────────────────────────────────────────────
      fetch(`https://oss.exercisedb.dev/api/v1/exercises?limit=${limit}&name=${q}`,
        { signal: AbortSignal.timeout(7000) })
        .then(res => res.ok ? res.json() : null)
        .then(json => {
          if (!json) return;
          const list = Array.isArray(json) ? json : (json.data || json.exercises || []);
          for (const ex of list) {
            if (ex?.gifUrl) add(ex.gifUrl, ex.name || term, term);
          }
        })
        .catch(() => {}),

      // ── wger: static images ──────────────────────────────────────────────────
      fetch(`https://wger.de/api/v2/exerciseinfo/?format=json&language=2&limit=6&name=${q}`,
        { signal: AbortSignal.timeout(6000) })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (!data) return;
          for (const ex of (data.results || [])) {
            const img    = ex.images?.find(i => i.is_main) || ex.images?.[0];
            const exName = ex.translations?.find(t => t.language === 2)?.name
                        || ex.name || term;
            if (img?.image) add(img.image, exName, term);
          }
        })
        .catch(() => {}),
    ]);
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Fetch URL → compress → store in IndexedDB ────────────────────────────────
// Returns true if the image was successfully cached locally.
async function fetchAndCacheImage(url, imgKey) {
  try {
    const resp = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return false;
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/')) return false;

    const raw = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });

    // GIFs: store as-is so animation is preserved
    if (blob.type === 'image/gif') {
      await saveImage(imgKey, raw);
      return true;
    }

    // All other formats: compress to JPEG via canvas
    const compressed = await new Promise(res => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        const max = 1200;
        if (w > max) { h = Math.round(h * max / w); w = max; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        res(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => res(raw);
      img.src = raw;
    });
    await saveImage(imgKey, compressed);
    return true;
  } catch { return false; }
}

// ─── Render: Week View ────────────────────────────────────────────────────────

function renderWeekView() {
  const today = getTodayDayName();
  const totalDone = state.days.reduce((s,d) => s + (state.workouts[d]||[]).filter(w=>state.completedIDs.has(w.id)).length, 0);
  const totalAll  = state.days.reduce((s,d) => s + (state.workouts[d]||[]).length, 0);
  const weekPct   = totalAll > 0 ? Math.round(totalDone / totalAll * 100) : 0;
  const streak    = calculateStreak();

  const summaryHTML = totalAll > 0 ? `
    <div class="week-summary">
      <span class="week-summary-label">This week</span>
      <div class="week-summary-track"><div class="week-summary-fill" style="width:${weekPct}%"></div></div>
      <span class="week-summary-stat">${totalDone}/${totalAll} · ${weekPct}%</span>
      ${streak > 0 ? `<span class="streak-badge">${ICONS.flame}${streak}w</span>` : ''}
    </div>` : '';

  const dayRows = state.days.map(day => {
    const workouts = state.workouts[day] || [];
    const done  = workouts.filter(w => state.completedIDs.has(w.id)).length;
    const total = workouts.length;
    const pct   = total > 0 ? Math.round(done / total * 100) : 0;
    const isToday = day === today;

    const rightContent = total === 0
      ? `<span class="day-empty-hint">Add workouts</span>`
      : `<span class="day-count">${done}/${total}</span><span class="day-pct">${pct}%</span>`;

    return `
      <div class="day-row">
        <button class="day-card${isToday ? ' today' : ''}" data-action="nav-day" data-day="${esc(day)}">
          <div class="day-card-left">
            <div class="day-name-row">
              <span class="day-name">${esc(day)}</span>
              ${isToday ? '<span class="today-badge">Today</span>' : ''}
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="day-card-right">${rightContent}${ICONS.chevron}</div>
        </button>
        <button class="day-options-btn" data-action="edit-day" data-day="${esc(day)}" title="Edit ${esc(day)}">
          ${ICONS.dotsVertical}
        </button>
      </div>`;
  }).join('');

  const historySheet = state.showHistory ? renderHistorySheet() : '';
  const modalHTML    = state.showModal === 'add-day'  ? renderAddDayModal()
                     : state.showModal === 'edit-day' ? renderEditDayModal()
                     : '';

  return `
    <div class="view week-view">
      <header class="app-header">
        <h1 class="app-title">Workout Tracker</h1>
        <div class="header-actions">
          ${_deferredInstallPrompt ? `<button class="icon-btn" data-action="install-pwa" title="Install app">${ICONS.install}</button>` : ''}
          <button class="icon-btn" data-action="show-history" title="History">${ICONS.history}</button>
          <button class="icon-btn" data-action="toggle-dark"  title="Toggle dark mode">
            ${state.isDarkMode ? ICONS.sun : ICONS.moon}
          </button>
        </div>
      </header>
      <div class="content">
        ${summaryHTML}
        <div class="section-label">Weekly Plan</div>
        <div class="card">${dayRows || '<div class="empty-state">No training days yet — add one below.</div>'}</div>
        <button class="add-day-btn" data-action="show-add-day">${ICONS.plusSimple} Add Training Day</button>
        <div class="data-actions">
          <button class="data-action-btn" data-action="export">${ICONS.export} Export Backup</button>
          <button class="data-action-btn" data-action="import">${ICONS.import} Import Backup</button>
        </div>
        <div class="reset-all-wrap">
          <button class="btn-destructive" data-action="reset-all">${ICONS.trash} Reset All Progress</button>
        </div>
      </div>
    </div>
    ${historySheet}${modalHTML}`;
}

// ─── Render: History Sheet ────────────────────────────────────────────────────

function renderHistorySheet() {
  const history = loadWeekHistory();
  const weeks   = Object.keys(history).sort().reverse().slice(0, 10);
  const content = weeks.length === 0
    ? '<div class="empty-state">No history yet — complete some workouts first.</div>'
    : weeks.map(key => {
        const week = history[key], histDays = Object.keys(week);
        const tDone = histDays.reduce((s,d) => s + (week[d]?.done||0), 0);
        const tAll  = histDays.reduce((s,d) => s + (week[d]?.total||0), 0);
        const pct   = tAll > 0 ? Math.round(tDone/tAll*100) : 0;
        const dots  = histDays.map(day => {
          const d = week[day]||{done:0,total:0};
          const p = d.total > 0 ? Math.round(d.done/d.total*100) : -1;
          const cls = p===100?'full':p>0?'partial':p===0?'none':'missing';
          return `<div class="hist-day-col">
            <span class="hist-day-label">${esc(day.slice(0,3))}</span>
            <div class="hist-dot ${cls}"></div>
            <span class="hist-day-pct">${p>=0?p+'%':'—'}</span>
          </div>`;
        }).join('');
        return `<div class="hist-row">
          <div class="hist-row-top">
            <span class="hist-week-label">${weekKeyToLabel(key)}</span>
            <span class="hist-overall-pct${pct===100?' perfect':''}">${pct}%</span>
          </div>
          <div class="hist-days">${dots}</div>
        </div>`;
      }).join('');

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <div style="min-width:52px"></div>
          <span class="modal-title">History</span>
          <button class="modal-cancel" data-action="close-history">Done</button>
        </div>
        <div class="history-content">${content}</div>
      </div>
    </div>`;
}

// ─── Render: Day Modals ───────────────────────────────────────────────────────

function renderAddDayModal() {
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <button class="modal-cancel" data-action="close-modal">Cancel</button>
          <span class="modal-title">New Training Day</span>
          <button class="modal-save" data-action="save-day">Add</button>
        </div>
        <form class="modal-form" onsubmit="return false">
          <div class="form-section">
            <label class="form-label">Day Name</label>
            <div class="form-card">
              <input id="f-day-name" class="form-input" type="text"
                     placeholder="e.g. Tuesday, Leg Day…" autocomplete="off">
            </div>
          </div>
        </form>
      </div>
    </div>`;
}

function renderEditDayModal() {
  const day = state.editTarget?.day || '';
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <button class="modal-cancel" data-action="close-modal">Cancel</button>
          <span class="modal-title">Edit Day</span>
          <button class="modal-save" data-action="save-rename-day" data-day="${esc(day)}">Save</button>
        </div>
        <form class="modal-form" onsubmit="return false">
          <div class="form-section">
            <label class="form-label">Rename</label>
            <div class="form-card">
              <input id="f-day-name" class="form-input" type="text"
                     placeholder="Day name" autocomplete="off" value="${esc(day)}">
            </div>
          </div>
          <div class="form-section">
            <div class="card">
              <button type="button" class="list-btn blue" data-action="duplicate-day" data-day="${esc(day)}">
                ${ICONS.copy} Duplicate Day
              </button>
            </div>
          </div>
          <div class="form-section">
            <button type="button" class="btn-destructive" data-action="delete-day"
                    data-day="${esc(day)}" style="width:100%;justify-content:center">
              ${ICONS.trash} Delete "${esc(day)}" and All Its Workouts
            </button>
          </div>
        </form>
      </div>
    </div>`;
}

// ─── Render: Copy Workout Sheet ──────────────────────────────────────────────

function renderCopyWorkoutSheet() {
  const { day, workoutId } = state.editTarget || {};
  const w = (state.workouts[day]||[]).find(x => x.id === workoutId);
  const otherDays = state.days.filter(d => d !== day);
  const dayBtns = otherDays.length
    ? otherDays.map((d, i) => `
        ${i > 0 ? '<div class="form-divider"></div>' : ''}
        <button type="button" class="list-btn blue" data-action="confirm-copy-workout"
                data-day="${esc(d)}">${esc(d)}</button>`).join('')
    : '<div class="empty-state">No other training days to copy to.</div>';

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <button class="modal-cancel" data-action="close-modal">Cancel</button>
          <span class="modal-title">Copy to…</span>
          <div style="min-width:52px"></div>
        </div>
        <div class="modal-form">
          <div class="form-section">
            <label class="form-label">Copy "${esc(w?.Workout||'')}" to</label>
            <div class="form-card">${dayBtns}</div>
          </div>
        </div>
      </div>
    </div>`;
}

// ─── Render: Day View ─────────────────────────────────────────────────────────

function renderDayView() {
  const day        = state.currentDay;
  const workouts   = state.workouts[day] || [];
  const categories = getCategories(day);

  // Load logs once for the whole render — passed down to each renderLogSection
  const _logs     = loadLogs();
  const _todayKey = getTodayKey();

  const filtered = state.filterCategory
    ? workouts.filter(w => w.Category === state.filterCategory)
    : workouts;

  const items = filtered.map(w => {
    const done  = state.completedIDs.has(w.id);
    const badge = w.Category ? `<span class="badge">${esc(w.Category)}</span>` : '';
    const notes = w.Notes    ? `<p class="workout-notes">${esc(w.Notes)}</p>`   : '';

    return `
      <div class="workout-item" style="--swipe-x:0px" data-workout-id="${esc(w.id)}" data-day="${esc(day)}">
        <button class="drag-handle" data-action="drag-noop" aria-label="Drag to reorder">${ICONS.dragHandle}</button>
        <button class="check-btn" data-action="toggle" data-id="${esc(w.id)}"
                aria-label="${done ? 'Mark incomplete' : 'Mark complete'}">
          ${done ? ICONS.checked : ICONS.circle}
        </button>
        <div class="workout-body">
          <div class="workout-title-row">
            <span class="workout-name${done ? ' done' : ''}">${esc(w.Workout)}</span>
            ${badge}
          </div>
          ${notes}
          <img class="workout-img" data-img-key="${esc(w._imgKey)}"
               src="${esc(w._imgURL || '')}" alt="Exercise photo" data-action="view-image"
               style="${w._imgURL ? '' : 'display:none'}">
          <button class="photo-btn" data-action="add-image"
                  data-day="${esc(day)}" data-workout-id="${esc(w.id)}" data-img-key="${esc(w._imgKey)}">
            ${ICONS.camera}<span class="photo-btn-label">${(w._imgURL) ? 'Change Photo' : 'Add Photo'}</span>
          </button>
          ${renderLogSection(w.id, _logs, _todayKey)}
        </div>
        <button class="workout-more-btn" data-action="expand-workout"
                data-workout-id="${esc(w.id)}" aria-label="More options">${ICONS.dotsVertical}</button>
        <div class="workout-actions">
          <button class="copy-btn"   data-action="copy-workout"   data-day="${esc(day)}" data-workout-id="${esc(w.id)}" title="Copy to day">${ICONS.copyTo}</button>
          <button class="edit-btn"   data-action="edit-workout"   data-day="${esc(day)}" data-workout-id="${esc(w.id)}" title="Edit">${ICONS.edit}</button>
          <button class="delete-btn" data-action="delete-workout" data-day="${esc(day)}" data-workout-id="${esc(w.id)}" title="Delete">${ICONS.trash}</button>
        </div>
      </div>`;
  }).join('');

  const filterPills = categories.length > 1
    ? `<div class="filter-bar">
        <button class="filter-pill${!state.filterCategory?' active':''}" data-action="filter" data-cat="">All</button>
        ${categories.map(c=>`<button class="filter-pill${state.filterCategory===c?' active':''}" data-action="filter" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
       </div>` : '';

  const modalHTML = state.showModal==='add'||state.showModal==='edit' ? renderWorkoutModal()
                 : state.showModal==='copy-workout' ? renderCopyWorkoutSheet()
                 : '';

  return `
    <div class="view day-view">
      <header class="app-header">
        <button class="back-btn" data-action="back">${ICONS.back} Back</button>
        <h1 class="app-title">${esc(day)}</h1>
        <div class="header-spacer"></div>
      </header>
      <div class="content">
        ${renderTimerCard()}
        <div class="card">
          <button class="list-btn orange" data-action="reset-day" data-day="${esc(day)}">${ICONS.reset} Reset Day Progress</button>
        </div>
        <div class="section-header">
          <span class="section-label" style="margin:0">Workouts</span>
          <button class="complete-all-btn" data-action="complete-all" data-day="${esc(day)}">${ICONS.checkAll} Complete All</button>
        </div>
        ${filterPills}
        <div class="card">${items || (state.filterCategory
          ? `<div class="empty-state">No workouts in "${esc(state.filterCategory)}" — try a different filter.</div>`
          : '<div class="empty-state">No workouts yet — tap + to add your first one.</div>')}</div>
      </div>
      <button class="fab" data-action="show-modal" aria-label="Add workout">${ICONS.plusSimple}</button>
    </div>
    ${modalHTML}`;
}

// ─── Render: Timer Card ───────────────────────────────────────────────────────

function renderTimerCard() {
  const mins    = Math.floor(timer.seconds / 60);
  const secs    = timer.seconds % 60;
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;

  if (!timer.expanded && !timer.running) {
    return `
      <button class="timer-pill" data-action="timer-expand" id="timer-card">
        ${ICONS.timerPlay}
        <span class="timer-pill-label">Rest Timer</span>
        <span class="timer-pill-chevron">${ICONS.chevron}</span>
      </button>`;
  }

  const pct     = timer.initial > 0 ? (timer.seconds / timer.initial) * 100 : 100;
  const presets = [{s:30,l:'30s'},{s:60,l:'1m'},{s:90,l:'90s'},{s:120,l:'2m'}];
  const presetBtns = presets.map(p =>
    `<button class="timer-preset-btn${timer.preset===p.s&&!timer.running?' active':''}"
             data-action="timer-preset" data-seconds="${p.s}"
             ${timer.running?'disabled':''}>${p.l}</button>`).join('');

  return `
    <div class="card timer-card${timer.running?' timer-running':''}" id="timer-card">
      <div class="timer-progress-wrap"><div class="timer-progress" id="timer-progress" style="width:${pct}%"></div></div>
      <div class="timer-inner">
        <div class="timer-left">
          <div class="timer-label-row">
            <span class="timer-label">REST TIMER</span>
            ${!timer.running?`<button class="timer-collapse-btn" data-action="timer-expand" title="Minimize">${ICONS.chevronUp}</button>`:''}
          </div>
          <div class="timer-preset-row">${presetBtns}</div>
        </div>
        <div class="timer-right">
          <span class="timer-display" id="timer-display">${timeStr}</span>
          <div class="timer-btn-row">
            <button class="timer-start-btn" id="timer-start-btn" data-action="timer-toggle">
              ${timer.running?ICONS.timerPause+'<span>Pause</span>':ICONS.timerPlay+'<span>Start</span>'}
            </button>
            <button class="timer-reset-icon-btn" data-action="timer-reset" title="Reset">${ICONS.timerReset}</button>
          </div>
        </div>
      </div>
    </div>`;
}

// ─── Render: Workout Modal ────────────────────────────────────────────────────

function renderWorkoutModal() {
  const isEdit = state.showModal === 'edit';
  let prefill  = { name: '', category: '', notes: '' };

  // Use cached form values (preserved across async auto-find renders)
  if (modalFormCache) {
    prefill = modalFormCache;
  } else if (isEdit && state.editTarget) {
    const { day, workoutId } = state.editTarget;
    const w = (state.workouts[day]||[]).find(x => x.id === workoutId);
    if (w) { prefill.name = w.Workout||''; prefill.category = w.Category||''; prefill.notes = w.Notes||''; }
  }

  const allCats = getAllCategories();
  const datalist = allCats.length
    ? `<datalist id="category-list">${allCats.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>`
    : '';

  // Resolve what image to show (upload > URL > existing)
  const imgDataURL = pendingImg?.dataURL || (!editImgRemoved && !pendingImgURL ? editCurrentImg : null);
  const imgURL     = pendingImgURL || (!editImgRemoved && !pendingImg ? editCurrentImgURL : null);
  const imgSrc     = imgDataURL || imgURL;

  let imgSection;
  if (imgSrc) {
    // Show editable URL field when image came from a URL (not a local upload)
    const showUrlEdit = !!(imgURL); // has a URL source
    imgSection = `
      <div class="img-upload-has-image">
        <img src="${esc(imgSrc)}" class="img-upload-preview" alt="Preview">
        ${showUrlEdit ? `
        <div class="img-url-source-row">
          <input id="img-source-url" class="img-url-source-input" type="url"
                 value="${esc(imgURL)}" placeholder="Image URL" autocomplete="off">
          <button type="button" class="img-url-reload-btn" data-action="reload-img-url"
                  title="Load new URL">${ICONS.reset}</button>
        </div>` : ''}
        <button type="button" class="img-remove-btn" data-action="remove-modal-image">✕ Remove</button>
      </div>`;
  } else if (showURLInput) {
    imgSection = `
      <div class="img-url-wrap">
        <input id="img-url-field" class="form-input" type="url"
               placeholder="https://example.com/photo.jpg" autocomplete="off">
        <div class="img-url-btns">
          <button type="button" class="img-url-cancel-btn" data-action="cancel-url-input">Cancel</button>
          <button type="button" class="img-url-confirm-btn" data-action="confirm-url-input">Use URL</button>
        </div>
      </div>`;
  } else if (imageSearchResults !== null) {
    // Image picker grid — shown after user taps "Find Images"
    if (imageSearchResults.length === 0) {
      imgSection = `
        <div class="img-search-empty">
          <span>No images found for "${esc(prefill.name)}".</span>
          <button type="button" class="img-search-cancel-btn" data-action="cancel-img-search">
            ← Back
          </button>
        </div>`;
    } else {
      imgSection = `
        <div class="img-search-grid">
          ${imageSearchResults.map((r, i) => `
            <button type="button" class="img-search-result"
                    data-action="pick-search-result" data-index="${i}">
              <img src="${esc(r.url)}" alt="${esc(r.name)}" loading="lazy"
                   onerror="this.closest('.img-search-result').style.display='none'">
              <span class="img-search-result-name">${esc(r.name)}</span>
            </button>`).join('')}
        </div>
        <button type="button" class="img-search-cancel-btn" data-action="cancel-img-search">
          Cancel
        </button>`;
    }
  } else {
    imgSection = `
      <div class="img-source-options">
        <button type="button" class="img-source-btn" data-action="pick-modal-image">
          ${ICONS.camera}<span>Upload</span>
        </button>
        <button type="button" class="img-source-btn" data-action="show-url-input">
          ${ICONS.link}<span>Paste URL</span>
        </button>
        <button type="button" class="img-source-btn" data-action="auto-find-image">
          ${ICONS.sparkle}<span>Find Images</span>
        </button>
      </div>`;
  }

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <button class="modal-cancel" data-action="close-modal">Cancel</button>
          <span class="modal-title">${isEdit ? 'Edit Workout' : 'New Workout'}</span>
          <button class="modal-save" data-action="save-workout"
                  data-day="${esc(isEdit?state.editTarget.day:state.currentDay)}"
                  data-edit="${isEdit}">${isEdit?'Save':'Add'}</button>
        </div>
        <form class="modal-form" onsubmit="return false">
          ${datalist}
          <div class="form-section">
            <label class="form-label">Workout Details</label>
            <div class="form-card">
              <input id="f-name" class="form-input" type="text"
                     placeholder="Workout Name (required)" autocomplete="off" value="${esc(prefill.name)}">
              <div class="form-divider"></div>
              <input id="f-category" class="form-input" type="text"
                     placeholder="Category (optional)" autocomplete="off"
                     list="category-list" value="${esc(prefill.category)}">
            </div>
          </div>
          <div class="form-section">
            <label class="form-label">Reference Photo (Optional)</label>
            <div class="form-card">${imgSection}</div>
          </div>
          <div class="form-section">
            <label class="form-label">Notes</label>
            <div class="form-card">
              <textarea id="f-notes" class="form-textarea"
                        placeholder="e.g. 3 sets × 10 reps" rows="4">${esc(prefill.notes)}</textarea>
            </div>
          </div>
        </form>
      </div>
    </div>`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  try {
    app.innerHTML = state.view === 'week' ? renderWeekView() : renderDayView();
    // Don't steal focus when the image picker grid is visible — keyboard would
    // pop up on mobile and scroll the modal away from the grid.
    if (state.showModal && imageSearchResults === null) {
      requestAnimationFrame(() => {
        const first = document.getElementById('f-day-name')
                   || document.getElementById('img-url-field')
                   || document.getElementById('f-name');
        if (first) { first.focus(); first.setSelectionRange?.(first.value.length, first.value.length); }
      });
    }
  } catch (err) {
    console.error('Render error:', err);
    app.innerHTML = `
      <div style="padding:60px 24px;text-align:center;max-width:320px;margin:0 auto">
        <div style="font-size:40px;margin-bottom:16px">⚠️</div>
        <div style="font-weight:600;font-size:18px;margin-bottom:8px;color:var(--text)">Something went wrong</div>
        <div style="color:var(--text-secondary);font-size:14px;margin-bottom:28px">${esc(err?.message||'Unexpected error')}</div>
        <button onclick="location.reload()"
          style="background:var(--accent);color:#fff;border:none;border-radius:10px;
                 padding:12px 28px;font-size:16px;font-family:inherit;cursor:pointer">
          Reload App
        </button>
      </div>`;
  }
}

// ─── Async Image Loading ──────────────────────────────────────────────────────

async function loadDayImages(day) {
  const workouts = state.workouts[day] || [];
  // Kick off all DB reads in parallel for faster initial paint
  await Promise.all(workouts.map(async w => {
    const imgEl = document.querySelector(`img[data-img-key="${CSS.escape(w._imgKey || '')}"]`);
    if (!imgEl) return;

    // Prefer locally-stored copy (IndexedDB) over the raw URL
    const local = w._imgKey ? await getImage(w._imgKey) : null;
    if (local) {
      imgEl.src = local; imgEl.style.display = '';
    } else if (w._imgURL) {
      // No local copy yet (CORS blocked or first load) — show directly from URL
      imgEl.src = w._imgURL; imgEl.style.display = '';
    } else {
      return; // no image at all
    }

    const label = imgEl.closest('.workout-body')?.querySelector('.photo-btn-label');
    if (label) label.textContent = 'Change Photo';
  }));
}

// ─── Full-Screen Image Viewer ─────────────────────────────────────────────────

function showImageViewer(dataURL) {
  document.getElementById('img-viewer')?.remove();
  const viewer = document.createElement('div');
  viewer.id = 'img-viewer'; viewer.className = 'img-viewer';
  viewer.innerHTML = `
    <div class="img-viewer-backdrop"></div>
    <img class="img-viewer-img" src="${dataURL}" alt="Exercise photo">
    <button class="img-viewer-close" aria-label="Close">✕</button>`;
  viewer.addEventListener('click', e => { if (!e.target.closest('.img-viewer-img')) viewer.remove(); });
  document.body.appendChild(viewer);
}

// ─── Swipe-to-Complete ────────────────────────────────────────────────────────

function setupSwipeHandlers() {
  let touch = null;

  document.addEventListener('touchstart', e => {
    if (e.target.closest('.drag-handle')) return;
    const item = e.target.closest('.workout-item');
    if (!item) return;
    touch = { el: item, startX: e.touches[0].clientX, startY: e.touches[0].clientY, swiping: false };
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!touch) return;
    const dx = e.touches[0].clientX - touch.startX;
    const dy = e.touches[0].clientY - touch.startY;
    if (!touch.swiping && Math.abs(dx) > 8) touch.swiping = Math.abs(dx) > Math.abs(dy);
    if (touch.swiping && dx > 0) touch.el.style.setProperty('--swipe-x', `${Math.min(dx*0.6,80)}px`);
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.startX;
    const dy = e.changedTouches[0].clientY - touch.startY;
    touch.el.style.setProperty('--swipe-x', '0px');
    if (touch.swiping && dx > 75 && Math.abs(dx) > Math.abs(dy) * 2) {
      const cb = touch.el.querySelector('[data-action="toggle"]');
      if (cb) toggleCompletion(cb.dataset.id);
    }
    touch = null;
  }, { passive: true });
}

// ─── Drag-to-Reorder ──────────────────────────────────────────────────────────

function setupReorderHandlers() {
  let drag = null;

  document.addEventListener('touchstart', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    e.preventDefault();
    const item = handle.closest('.workout-item');
    if (!item) return;
    const rect  = item.getBoundingClientRect();
    const touch = e.touches[0];
    const ghost = item.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;`;
    document.body.appendChild(ghost);
    item.classList.add('drag-src');
    drag = { item, ghost, day: state.currentDay, workoutId: item.dataset.workoutId, offsetY: touch.clientY - rect.top, overItem: null, overAbove: true };
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!drag) return;
    e.preventDefault();
    const touchY = e.touches[0].clientY;
    drag.ghost.style.top = `${touchY - drag.offsetY}px`;
    document.querySelectorAll('.workout-item:not(.drag-src)').forEach(el => el.classList.remove('drag-over-above','drag-over-below'));
    let found = null, foundAbove = true;
    for (const el of document.querySelectorAll('.workout-item:not(.drag-src)')) {
      const r = el.getBoundingClientRect();
      if (touchY >= r.top && touchY <= r.bottom) { found = el; foundAbove = touchY < r.top + r.height/2; break; }
    }
    if (found) { found.classList.add(foundAbove?'drag-over-above':'drag-over-below'); drag.overItem = found; drag.overAbove = foundAbove; }
    else drag.overItem = null;
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!drag) return;
    drag.ghost.remove(); drag.item.classList.remove('drag-src');
    document.querySelectorAll('.drag-over-above,.drag-over-below').forEach(el => el.classList.remove('drag-over-above','drag-over-below'));
    if (drag.overItem && drag.day) {
      const wk  = state.workouts[drag.day];
      const fi  = wk.findIndex(w => w.id === drag.workoutId);
      const tId = drag.overItem.dataset.workoutId;
      const ti  = wk.findIndex(w => w.id === tId);
      if (fi !== -1 && ti !== -1 && fi !== ti) {
        const [moved] = wk.splice(fi, 1);
        const ni = wk.findIndex(w => w.id === tId);
        wk.splice(drag.overAbove ? ni : ni+1, 0, moved);
        saveState(); render(); loadDayImages(drag.day);
      }
    }
    drag = null;
  }, { passive: true });
}

// ─── Events ───────────────────────────────────────────────────────────────────

document.addEventListener('click', async e => {
  if (e.target.id === 'modal-overlay') {
    pendingImg = null; pendingImgURL = null; editCurrentImg = null; editCurrentImgURL = null;
    editImgRemoved = false; showURLInput = false; imageSearchResults = null; modalFormCache = null;
    state.showModal = false; state.editTarget = null; state.showHistory = false;
    render(); if (state.view === 'day') loadDayImages(state.currentDay); return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  switch (btn.dataset.action) {

    case 'nav-day':
      state.view = 'day'; state.currentDay = btn.dataset.day; state.filterCategory = null;
      render(); window.scrollTo(0,0); loadDayImages(btn.dataset.day); acquireWakeLock();
      break;

    case 'back':
      pauseTimer(); // stop interval before leaving day view
      state.view = 'week'; state.currentDay = null; state.showModal = false; state.editTarget = null;
      pendingImg = null; pendingImgURL = null; editCurrentImg = null; editCurrentImgURL = null;
      editImgRemoved = false; showURLInput = false; imageSearchResults = null; modalFormCache = null;
      releaseWakeLock(); render(); window.scrollTo(0,0);
      break;

    case 'toggle': toggleCompletion(btn.dataset.id); break;
    case 'toggle-dark': toggleDarkMode(); break;
    case 'reset-all': resetAll(); break;
    case 'reset-day': resetDay(btn.dataset.day); break;
    case 'complete-all': completeAll(btn.dataset.day); break;

    case 'expand-workout': {
      const item = btn.closest('.workout-item');
      if (!item) break;
      const wasExpanded = item.classList.contains('expanded');
      document.querySelectorAll('.workout-item.expanded').forEach(el => el.classList.remove('expanded'));
      if (!wasExpanded) item.classList.add('expanded');
      break;
    }

    // ── Set / Rep Logging ──────────────────────────────────────────────────────

    case 'log-set': {
      const wid     = btn.dataset.workoutId;
      const repsVal = document.getElementById(`log-reps-${wid}`)?.value.trim();
      const wtVal   = document.getElementById(`log-weight-${wid}`)?.value.trim();
      const unitBtn = document.querySelector(`[data-action="toggle-unit"][data-workout-id="${wid}"]`);
      const unit    = unitBtn?.dataset.unit || getWeightUnit();
      const reps    = parseInt(repsVal) || 0;
      const weight  = parseFloat(wtVal) || 0;
      if (reps <= 0) { document.getElementById(`log-reps-${wid}`)?.focus(); break; }
      const sets = logSet(wid, reps, weight, unit);
      const setsEl = document.getElementById(`log-sets-${wid}`);
      if (setsEl) setsEl.innerHTML = renderSetsList(wid, sets);
      // Clear reps, keep weight (common: same weight multiple sets)
      const repsEl = document.getElementById(`log-reps-${wid}`);
      if (repsEl) { repsEl.value = ''; repsEl.focus(); }
      break;
    }

    case 'remove-set': {
      const wid = btn.dataset.workoutId;
      const idx = parseInt(btn.dataset.setIndex, 10);
      // Capture set data before removal for potential undo
      const logs = loadLogs();
      const setData = logs[getTodayKey()]?.[wid]?.[idx];
      // Clear any previous pending undo first (new removal replaces old one)
      _undoPendingSet = null;
      const sets = removeSet(wid, idx);
      const setsEl = document.getElementById(`log-sets-${wid}`);
      if (setsEl) setsEl.innerHTML = renderSetsList(wid, sets);
      if (setData) {
        _undoPendingSet = { workoutId: wid, setIndex: idx, setData };
        showToast('Set removed', {
          undo: () => {
            _undoPendingSet = null;
            const l = loadLogs(); const today = getTodayKey();
            if (!l[today]) l[today] = {};
            if (!l[today][wid]) l[today][wid] = [];
            l[today][wid].splice(idx, 0, setData);
            saveLogs(l);
            const el = document.getElementById(`log-sets-${wid}`);
            if (el) el.innerHTML = renderSetsList(wid, l[today][wid]);
          }
        });
      }
      break;
    }

    case 'toggle-unit': {
      const wid     = btn.dataset.workoutId;
      const newUnit = btn.dataset.unit === 'lbs' ? 'kg' : 'lbs';
      btn.dataset.unit = newUnit; btn.textContent = newUnit;
      setWeightUnit(newUnit);
      break;
    }

    // ── Timer ──────────────────────────────────────────────────────────────────

    case 'timer-expand':
      timer.expanded = !timer.expanded; replaceTimerCard(); break;
    case 'timer-toggle':
      timer.running ? pauseTimer() : startTimer(); break;
    case 'timer-preset': setTimerPreset(Number(btn.dataset.seconds)); break;
    case 'timer-reset':  resetTimer(); break;

    // ── Workout modal ──────────────────────────────────────────────────────────

    case 'show-modal':
      pendingImg = null; pendingImgURL = null; editCurrentImg = null; editCurrentImgURL = null;
      editImgRemoved = false; showURLInput = false; imageSearchResults = null; modalFormCache = null;
      state.showModal = 'add'; state.editTarget = null; render(); break;

    case 'close-modal':
      pendingImg = null; pendingImgURL = null; editCurrentImg = null; editCurrentImgURL = null;
      editImgRemoved = false; showURLInput = false; imageSearchResults = null; modalFormCache = null;
      state.showModal = false; state.editTarget = null; render();
      if (state.view === 'day') loadDayImages(state.currentDay); break;

    case 'pick-modal-image': {
      const dataURL = await pickImage(); if (!dataURL) return;
      pendingImg = { dataURL }; pendingImgURL = null; editImgRemoved = false; render(); break;
    }
    case 'remove-modal-image':
      pendingImg = null; pendingImgURL = null; editCurrentImg = null; editCurrentImgURL = null;
      editImgRemoved = true; showURLInput = false; imageSearchResults = null; render(); break;

    // ── URL image input ────────────────────────────────────────────────────────
    case 'show-url-input': {
      // Cache form values so they survive the re-render
      const name  = document.getElementById('f-name')?.value.trim()     || '';
      const cat   = document.getElementById('f-category')?.value.trim() || '';
      const notes = document.getElementById('f-notes')?.value.trim()    || '';
      // Keep modalFormCache set while URL input is visible so cancel can restore it
      modalFormCache = { name, category: cat, notes };
      showURLInput = true; render(); break;
    }
    case 'cancel-url-input': {
      // modalFormCache still holds the values saved when show-url-input was clicked
      showURLInput = false; render(); modalFormCache = null; break;
    }
    case 'confirm-url-input': {
      const url   = document.getElementById('img-url-field')?.value.trim();
      const modal = btn.closest('.modal');
      const name  = modal?.querySelector('#f-name')?.value.trim()     || modalFormCache?.name  || '';
      const cat   = modal?.querySelector('#f-category')?.value.trim() || modalFormCache?.category || '';
      const notes = modal?.querySelector('#f-notes')?.value.trim()    || modalFormCache?.notes    || '';
      if (!url) { document.getElementById('img-url-field')?.focus(); break; }
      pendingImgURL = url; pendingImg = null; editImgRemoved = false;
      modalFormCache = { name, category: cat, notes };
      showURLInput = false; render(); modalFormCache = null;
      // Background-cache the image so it works offline
      const tmpKey = state.editTarget
        ? (state.workouts[state.editTarget.day]||[]).find(x=>x.id===state.editTarget.workoutId)?._imgKey
        : null;
      if (tmpKey) fetchAndCacheImage(url, tmpKey).catch(()=>{});
      break;
    }

    case 'reload-img-url': {
      // User edited the URL field on the image preview — reload from new URL
      const url   = document.getElementById('img-source-url')?.value.trim();
      const modal = btn.closest('.modal');
      const name  = modal?.querySelector('#f-name')?.value.trim()     || '';
      const cat   = modal?.querySelector('#f-category')?.value.trim() || '';
      const notes = modal?.querySelector('#f-notes')?.value.trim()    || '';
      if (!url) break;
      pendingImgURL = url; pendingImg = null; editImgRemoved = false;
      modalFormCache = { name, category: cat, notes };
      render(); modalFormCache = null;
      const tmpKey = state.editTarget
        ? (state.workouts[state.editTarget.day]||[]).find(x=>x.id===state.editTarget.workoutId)?._imgKey
        : null;
      if (tmpKey) fetchAndCacheImage(url, tmpKey).catch(()=>{});
      break;
    }

    // ── Image search / picker ──────────────────────────────────────────────────
    case 'auto-find-image': {
      const name  = document.getElementById('f-name')?.value.trim()     || '';
      const cat   = document.getElementById('f-category')?.value.trim() || '';
      const notes = document.getElementById('f-notes')?.value.trim()    || '';
      if (!name) { document.getElementById('f-name')?.focus(); break; }
      modalFormCache = { name, category: cat, notes };

      // Show spinner in-place while fetching
      const imgCard = btn.closest('.form-card');
      if (imgCard) imgCard.innerHTML = `
        <div class="img-auto-loading">
          <div class="spinner"></div>
          <span>Finding images for "${esc(name)}"…</span>
        </div>`;

      const results = await fetchExerciseImages(name, 8);
      imageSearchResults = results;  // [] triggers "no results" UI
      render(); modalFormCache = null; break;
    }

    case 'pick-search-result': {
      const idx    = parseInt(btn.dataset.index, 10);
      const result = imageSearchResults?.[idx];
      if (result) {
        // Preserve form values — modalFormCache was cleared after the grid rendered
        modalFormCache = {
          name:     document.getElementById('f-name')?.value.trim()     || modalFormCache?.name     || '',
          category: document.getElementById('f-category')?.value.trim() || modalFormCache?.category || '',
          notes:    document.getElementById('f-notes')?.value.trim()    || modalFormCache?.notes    || '',
        };
        pendingImgURL = result.url; pendingImg = null; editImgRemoved = false;
        imageSearchResults = null;
        render(); modalFormCache = null;
        // Background-cache for edit mode (add mode handled in save-workout)
        if (state.editTarget) {
          const tmpKey = (state.workouts[state.editTarget.day]||[])
            .find(x => x.id === state.editTarget.workoutId)?._imgKey;
          if (tmpKey) fetchAndCacheImage(result.url, tmpKey).catch(() => {});
        }
      }
      break;
    }

    case 'cancel-img-search':
      // Preserve form values — modalFormCache was cleared after the grid rendered
      modalFormCache = {
        name:     document.getElementById('f-name')?.value.trim()     || modalFormCache?.name     || '',
        category: document.getElementById('f-category')?.value.trim() || modalFormCache?.category || '',
        notes:    document.getElementById('f-notes')?.value.trim()    || modalFormCache?.notes    || '',
      };
      imageSearchResults = null; render(); modalFormCache = null; break;

    case 'save-workout': {
      const name   = document.getElementById('f-name')?.value.trim();
      const cat    = document.getElementById('f-category')?.value.trim();
      const notes  = document.getElementById('f-notes')?.value.trim();
      const day    = btn.dataset.day;
      const isEdit = btn.dataset.edit === 'true';
      if (!name) { document.getElementById('f-name')?.focus(); return; }

      if (isEdit && state.editTarget) {
        const { workoutId } = state.editTarget;
        const w = (state.workouts[day]||[]).find(x => x.id === workoutId);
        if (pendingImg && w?._imgKey) {
          await saveImage(w._imgKey, pendingImg.dataURL);
          editWorkout(day, workoutId, name, cat, notes, undefined, true); // clear any URL
        } else if (pendingImgURL !== null) {
          if (editImgRemoved && w?._imgKey) await deleteImage(w._imgKey);
          editWorkout(day, workoutId, name, cat, notes, pendingImgURL, false);
        } else if (editImgRemoved) {
          if (w?._imgKey) await deleteImage(w._imgKey);
          editWorkout(day, workoutId, name, cat, notes, undefined, true);
        } else {
          editWorkout(day, workoutId, name, cat, notes);
        }
      } else {
        let imgKey = null, imgURL = null;
        if (pendingImg) {
          imgKey = uuid(); await saveImage(imgKey, pendingImg.dataURL);
        } else if (pendingImgURL) {
          imgKey = uuid(); imgURL = pendingImgURL; // pre-generate key so caching uses the exact key
        }
        addWorkout(day, name, cat, notes, imgKey, imgURL);
        // Background-cache URL image under the pre-generated key
        if (imgURL && imgKey) fetchAndCacheImage(imgURL, imgKey).catch(()=>{});
      }

      pendingImg = null; pendingImgURL = null; editCurrentImg = null; editCurrentImgURL = null;
      editImgRemoved = false; showURLInput = false; imageSearchResults = null; modalFormCache = null;
      state.showModal = false; state.editTarget = null;
      // Clear stale filter if the active category no longer exists on this day
      if (state.filterCategory && !getCategories(state.currentDay).includes(state.filterCategory)) {
        state.filterCategory = null;
      }
      render(); loadDayImages(state.currentDay); break;
    }

    case 'edit-workout': {
      const day = btn.dataset.day, wid = btn.dataset.workoutId;
      const w   = (state.workouts[day]||[]).find(x => x.id === wid);
      editCurrentImg    = w?._imgKey && !w._imgURL ? await getImage(w._imgKey) : null;
      editCurrentImgURL = w?._imgURL || null;
      editImgRemoved = false; pendingImg = null; pendingImgURL = null;
      showURLInput = false; modalFormCache = null;
      state.showModal = 'edit'; state.editTarget = { day, workoutId: wid }; render(); break;
    }

    case 'delete-workout':
      if (confirm('Delete this workout?')) await deleteWorkout(btn.dataset.day, btn.dataset.workoutId); break;

    case 'copy-workout':
      state.showModal = 'copy-workout';
      state.editTarget = { day: btn.dataset.day, workoutId: btn.dataset.workoutId };
      render(); break;

    case 'confirm-copy-workout': {
      const { day: srcDay, workoutId: srcId } = state.editTarget || {};
      const targetDay = btn.dataset.day;
      const srcW = (state.workouts[srcDay]||[]).find(x => x.id === srcId);
      if (srcW && targetDay) {
        const newId = uuid(), newKey = uuid();
        if (!state.workouts[targetDay]) state.workouts[targetDay] = [];
        state.workouts[targetDay].push({ ...srcW, id: newId, _imgKey: newKey, Day: targetDay });
        saveState();
        // Copy image in background (IndexedDB first, URL fallback for URL-only images)
        if (srcW._imgKey) getImage(srcW._imgKey).then(data => {
          if (data) saveImage(newKey, data);
          else if (srcW._imgURL) fetchAndCacheImage(srcW._imgURL, newKey).catch(() => {});
        });
      }
      state.showModal = false; state.editTarget = null;
      render(); loadDayImages(state.currentDay);
      showToast(`Copied to ${targetDay}`);
      break;
    }

    case 'install-pwa':
      if (_deferredInstallPrompt) {
        _deferredInstallPrompt.prompt();
        _deferredInstallPrompt.userChoice.then(() => { _deferredInstallPrompt = null; render(); });
      }
      break;

    case 'add-image': {
      const imgKey = btn.dataset.imgKey, dataURL = await pickImage();
      if (!dataURL) return;
      await saveImage(imgKey, dataURL);
      // Clear any stale _imgURL so the local copy is always canonical
      const aiDay = btn.dataset.day, aiWid = btn.dataset.workoutId;
      if (aiDay && aiWid) {
        const aiW = (state.workouts[aiDay]||[]).find(x => x.id === aiWid);
        if (aiW) editWorkout(aiDay, aiWid, aiW.Workout, aiW.Category, aiW.Notes, undefined, true);
      }
      const imgEl = document.querySelector(`img[data-img-key="${CSS.escape(imgKey)}"]`);
      if (imgEl) { imgEl.src = dataURL; imgEl.style.display = ''; const l = imgEl.closest('.workout-body')?.querySelector('.photo-btn-label'); if(l) l.textContent='Change Photo'; }
      break;
    }

    case 'view-image': { const src = btn.src || btn.getAttribute('src'); if (src) showImageViewer(src); break; }

    // ── Day management ─────────────────────────────────────────────────────────

    case 'show-add-day': state.showModal = 'add-day'; state.editTarget = null; render(); break;
    case 'save-day': {
      const n = document.getElementById('f-day-name')?.value;
      if (addDay(n)) { state.showModal = false; state.editTarget = null; render(); } break;
    }
    case 'edit-day': state.showModal = 'edit-day'; state.editTarget = { day: btn.dataset.day }; render(); break;
    case 'save-rename-day': {
      const renamed = renameDay(btn.dataset.day, document.getElementById('f-day-name')?.value);
      if (!renamed) break; // stay in modal — duplicate shows toast, empty name just keeps focus
      state.showModal = false; state.editTarget = null; render();
      if (state.view === 'day') loadDayImages(state.currentDay); break;
    }
    case 'delete-day':
      state.showModal = false; state.editTarget = null; await deleteDay(btn.dataset.day); break;

    case 'duplicate-day': {
      state.showModal = false; state.editTarget = null;
      const newName = await duplicateDay(btn.dataset.day);
      state.view = 'day'; state.currentDay = newName; state.filterCategory = null;
      render(); window.scrollTo(0,0); loadDayImages(newName); acquireWakeLock(); break;
    }

    // ── Filter ─────────────────────────────────────────────────────────────────
    case 'filter': state.filterCategory = btn.dataset.cat||null; render(); loadDayImages(state.currentDay); break;

    // ── History ────────────────────────────────────────────────────────────────
    case 'show-history':  state.showHistory = true;  render(); break;
    case 'close-history': state.showHistory = false; render(); break;

    case 'export': exportData(); break;
    case 'import': triggerImport(); break;
    case 'drag-noop': break;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const t = e.target;
    if (t.id === 'img-url-field') {
      e.preventDefault();
      document.querySelector('[data-action="confirm-url-input"]')?.click();
    } else if (t.id === 'img-source-url') {
      e.preventDefault();
      document.querySelector('[data-action="reload-img-url"]')?.click();
    } else if (t.id === 'f-day-name') {
      // Enter in Add Day / Rename Day modal submits the form
      e.preventDefault();
      (document.querySelector('[data-action="save-day"]') ||
       document.querySelector('[data-action="save-rename-day"]'))?.click();
    } else if (t.id?.startsWith('log-weight-')) {
      // Enter in weight field advances focus to the reps field
      e.preventDefault();
      const wid = t.id.replace('log-weight-', '');
      document.getElementById(`log-reps-${wid}`)?.focus();
    } else if (t.id?.startsWith('log-reps-')) {
      e.preventDefault();
      const wid = t.id.replace('log-reps-', '');
      document.querySelector(`[data-action="log-set"][data-workout-id="${CSS.escape(wid)}"]`)?.click();
    }
  }
  if (e.key === 'Escape') {
    document.getElementById('img-viewer')?.remove();
    if (state.showModal) {
      pendingImg = null; pendingImgURL = null;
      editCurrentImg = null; editCurrentImgURL = null;
      editImgRemoved = false; showURLInput = false; imageSearchResults = null; modalFormCache = null;
      state.showModal = false; state.editTarget = null; render();
      if (state.view === 'day') loadDayImages(state.currentDay);
    }
    if (state.showHistory) { state.showHistory = false; render(); }
  }
});

// ─── Service Worker ───────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW failed:', e));
  });
}

// ─── PWA Install Prompt ───────────────────────────────────────────────────────

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  if (state.view === 'week') render(); // show install button in header
});

window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  if (state.view === 'week') render();
  showToast('App installed! Open from your home screen.');
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadState();
pruneOldLogs();
applyTheme();
render();
setupSwipeHandlers();
setupReorderHandlers();
