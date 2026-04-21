// ─── Constants ────────────────────────────────────────────────────────────────

const WORKOUT_DAYS = ['Monday', 'Wednesday', 'Thursday', 'Friday'];

const SHEET_URL = 'https://gsx2json.com/api?id=19HocMTEu0Sf1QTj-bRzA84o9sTUaSyKg8hIry8AT1L8&sheet=Sheet1';

const KEYS = {
  completed: 'wt_completedIDs',
  edits:     'wt_customEdits',
  dark:      'wt_isDarkMode',
  cache:     'wt_sheetCache',
  history:   'wt_weekHistory',
};

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  sheetData:      [],
  completedIDs:   new Set(),
  customEdits:    {},
  isDarkMode:     false,
  isLoading:      false,
  errorMessage:   null,
  view:           'week',
  currentDay:     null,
  showModal:      false,   // false | 'add' | 'edit'
  editTarget:     null,    // { day, index } in edit mode
  filterCategory: null,
  showHistory:    false,
};

let pendingImg      = null;  // { dataURL } selected in modal, not yet saved
let editCurrentImg  = null;  // dataURL of existing image when editing
let editImgRemoved  = false; // user explicitly removed image in edit mode

// ─── Timer (independent of render cycle) ─────────────────────────────────────

const timer = {
  preset:     60,
  seconds:    60,
  initial:    60,
  running:    false,
  intervalId: null,
};

// ─── IndexedDB (Image Storage) ────────────────────────────────────────────────

let _db = null;

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('WorkoutTrackerDB', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('images', { keyPath: 'key' });
    };
    req.onsuccess = e => { _db = e.target.result; resolve(); };
    req.onerror   = e => reject(e.target.error);
  });
}

function ensureDB() {
  return _db ? Promise.resolve() : initDB();
}

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
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async e => {
      const file = e.target.files[0];
      if (!file) { resolve(null); return; }
      try { resolve(await compressImage(file)); }
      catch { resolve(null); }
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
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function getImageKey(workout) {
  if (workout._imgKey) return workout._imgKey;
  return `sheet-${workout.Day}-${workout.Index}`;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadState() {
  const dark = localStorage.getItem(KEYS.dark);
  state.isDarkMode = dark !== null
    ? dark === 'true'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;

  const comp = localStorage.getItem(KEYS.completed);
  state.completedIDs = comp ? new Set(JSON.parse(comp)) : new Set();

  const edits = localStorage.getItem(KEYS.edits);
  state.customEdits = edits ? JSON.parse(edits) : {};

  const cached = localStorage.getItem(KEYS.cache);
  if (cached) { try { state.sheetData = JSON.parse(cached); } catch (_) {} }
}

function saveState() {
  localStorage.setItem(KEYS.completed, JSON.stringify([...state.completedIDs]));
  localStorage.setItem(KEYS.edits,     JSON.stringify(state.customEdits));
  localStorage.setItem(KEYS.dark,      String(state.isDarkMode));
}

// ─── Week History ──────────────────────────────────────────────────────────────

function getWeekKey(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split('T')[0]; // "YYYY-MM-DD" of that Monday
}

function loadWeekHistory() {
  try { return JSON.parse(localStorage.getItem(KEYS.history) || '{}'); }
  catch { return {}; }
}

function saveWeekSnapshot() {
  const history = loadWeekHistory();
  const key = getWeekKey();
  history[key] = {};
  for (const day of WORKOUT_DAYS) {
    const workouts = getDayData(day);
    const done  = workouts.filter(w => state.completedIDs.has(workoutID(day, w.Index))).length;
    history[key][day] = { done, total: workouts.length };
  }
  localStorage.setItem(KEYS.history, JSON.stringify(history));
}

function weekKeyToLabel(key) {
  // key is "YYYY-MM-DD" (the Monday of that week)
  const d = new Date(key + 'T00:00:00');
  return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// ─── Date Utilities ────────────────────────────────────────────────────────────

function getTodayDayName() {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];
}

// ─── API Fetch ────────────────────────────────────────────────────────────────

async function fetchSheetData() {
  state.isLoading = true;
  state.errorMessage = null;
  render();

  try {
    const resp = await fetch(SHEET_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();

    if (!json.rows || !Array.isArray(json.rows)) {
      throw new Error("API response missing 'rows'.");
    }

    state.sheetData = json.rows.map((row, i) => ({
      Day:      row.Day      || '',
      Workout:  row.Workout  || '',
      Category: row.Category || null,
      Notes:    row.Notes    || null,
      Index:    i,
    }));

    localStorage.setItem(KEYS.cache, JSON.stringify(state.sheetData));
    state.errorMessage = null;
  } catch (err) {
    state.errorMessage = state.sheetData.length > 0
      ? '⚠️ Could not refresh — showing cached data.'
      : `⚠️ Failed to load workouts: ${err.message}`;
  }

  state.isLoading = false;
  render();
  if (state.view === 'day') loadDayImages(state.currentDay);
}

// ─── Data Logic ───────────────────────────────────────────────────────────────

function getDayData(day) {
  const fromSheet = state.sheetData.filter(r => r.Day === day);
  const custom    = state.customEdits[day] ?? [];
  const offset    = fromSheet.length;
  return [...fromSheet, ...custom.map((row, i) => ({ ...row, Index: offset + i }))];
}

function workoutID(day, index) {
  return `${day}-${index}`;
}

function getCategories(day) {
  return [...new Set(getDayData(day).map(w => w.Category).filter(Boolean))];
}

function toggleCompletion(id) {
  state.completedIDs.has(id)
    ? state.completedIDs.delete(id)
    : state.completedIDs.add(id);
  saveState();
  saveWeekSnapshot();
  render();
  if (state.view === 'day') loadDayImages(state.currentDay);
}

function completeAll(day) {
  getDayData(day).forEach(w => state.completedIDs.add(workoutID(day, w.Index)));
  saveState();
  saveWeekSnapshot();
  render();
  loadDayImages(day);
}

function resetAll() {
  if (!confirm('Reset all progress?\n\nThis clears completion status for every day.')) return;
  state.completedIDs.clear();
  saveState();
  saveWeekSnapshot();
  render();
}

function resetDay(day) {
  if (!confirm(`Reset ${day}?\n\nThis clears completion for ${day} only.`)) return;
  for (const id of [...state.completedIDs]) {
    if (id.startsWith(`${day}-`)) state.completedIDs.delete(id);
  }
  saveState();
  saveWeekSnapshot();
  render();
  loadDayImages(day);
}

function addWorkout(day, name, category, notes, imgKey) {
  const newIndex = getDayData(day).length;
  const row = {
    Day:      day,
    Workout:  name,
    Category: category || null,
    Notes:    notes    || null,
    Index:    newIndex,
    _custom:  true,
    _imgKey:  imgKey || uuid(),
  };
  if (!state.customEdits[day]) state.customEdits[day] = [];
  state.customEdits[day].push(row);
  saveState();
}

function editWorkout(day, index, name, category, notes) {
  const originalsCount = state.sheetData.filter(r => r.Day === day).length;
  const localIdx = index - originalsCount;
  if (!state.customEdits[day]?.[localIdx]) return;
  state.customEdits[day][localIdx] = {
    ...state.customEdits[day][localIdx],
    Workout:  name,
    Category: category || null,
    Notes:    notes    || null,
  };
  saveState();
}

async function deleteCustomWorkout(day, index) {
  if (!state.customEdits[day]) return;
  const localIdx = state.customEdits[day].findIndex(r => r.Index === index);
  if (localIdx === -1) return;

  const row = state.customEdits[day][localIdx];
  if (row._imgKey) await deleteImage(row._imgKey);

  state.customEdits[day].splice(localIdx, 1);
  state.completedIDs.delete(workoutID(day, index));

  const originalsCount = state.sheetData.filter(r => r.Day === day).length;
  state.customEdits[day] = state.customEdits[day].map((w, i) => {
    const newIdx = originalsCount + i;
    const oldID  = workoutID(day, w.Index);
    const newID  = workoutID(day, newIdx);
    if (state.completedIDs.has(oldID)) {
      state.completedIDs.delete(oldID);
      state.completedIDs.add(newID);
    }
    return { ...w, Index: newIdx };
  });

  saveState();
  render();
  loadDayImages(day);
}

// ─── Timer ────────────────────────────────────────────────────────────────────

function setTimerPreset(seconds) {
  if (timer.running) return;
  timer.preset  = seconds;
  timer.seconds = seconds;
  timer.initial = seconds;
  updateTimerDisplay();
}

function startTimer() {
  if (timer.running) return;
  timer.initial = timer.seconds > 0 ? timer.seconds : timer.preset;
  timer.seconds = timer.initial;
  timer.running = true;
  timer.intervalId = setInterval(tickTimer, 1000);
  updateTimerDisplay();
}

function pauseTimer() {
  if (!timer.running) return;
  timer.running = false;
  clearInterval(timer.intervalId);
  timer.intervalId = null;
  updateTimerDisplay();
}

function resetTimer() {
  clearInterval(timer.intervalId);
  timer.intervalId = null;
  timer.running = false;
  timer.seconds = timer.preset;
  timer.initial = timer.preset;
  updateTimerDisplay();
  const card = document.getElementById('timer-card');
  if (card) card.classList.remove('timer-done');
}

function tickTimer() {
  if (timer.seconds > 0) {
    timer.seconds--;
    updateTimerDisplay();
  } else {
    clearInterval(timer.intervalId);
    timer.intervalId = null;
    timer.running = false;
    updateTimerDisplay();
    // Vibrate on finish if supported
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    const card = document.getElementById('timer-card');
    if (card) card.classList.add('timer-done');
  }
}

function updateTimerDisplay() {
  const displayEl = document.getElementById('timer-display');
  const progressEl = document.getElementById('timer-progress');
  const startBtn   = document.getElementById('timer-start-btn');
  const card       = document.getElementById('timer-card');
  if (!displayEl) return;

  const mins = Math.floor(timer.seconds / 60);
  const secs = timer.seconds % 60;
  displayEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;

  if (progressEl) {
    const pct = timer.initial > 0 ? (timer.seconds / timer.initial) * 100 : 100;
    progressEl.style.width = `${pct}%`;
  }

  if (startBtn) {
    startBtn.innerHTML = timer.running
      ? `${ICONS.timerPause}<span>Pause</span>`
      : `${ICONS.timerPlay}<span>Start</span>`;
  }

  // Update preset buttons (disable while running)
  document.querySelectorAll('.timer-preset-btn').forEach(btn => {
    btn.disabled = timer.running;
    btn.classList.toggle('active', !timer.running && Number(btn.dataset.seconds) === timer.preset);
  });

  if (card) card.classList.toggle('timer-running', timer.running);
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportData() {
  const data = {
    version:      2,
    exportedAt:   new Date().toISOString(),
    customEdits:  state.customEdits,
    completedIDs: [...state.completedIDs],
    weekHistory:  loadWeekHistory(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `workout-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.customEdits && !data.completedIDs) {
      throw new Error('This file does not look like a Workout Tracker backup.');
    }
    if (data.customEdits)  state.customEdits  = data.customEdits;
    if (data.completedIDs) state.completedIDs = new Set(data.completedIDs);
    if (data.weekHistory)  localStorage.setItem(KEYS.history, JSON.stringify(data.weekHistory));
    saveState();
    alert('Import successful! Note: exercise photos are not included in backups.');
    render();
    if (state.view === 'day') loadDayImages(state.currentDay);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
}

function triggerImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = e => { if (e.target.files[0]) importData(e.target.files[0]); };
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 10000);
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.isDarkMode ? 'dark' : 'light');
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = state.isDarkMode ? '#000000' : '#f2f2f7';
}

function toggleDarkMode() {
  state.isDarkMode = !state.isDarkMode;
  applyTheme();
  saveState();
  render();
  if (state.view === 'day') loadDayImages(state.currentDay);
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const ICONS = {
  refresh:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  sun:        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  moon:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  chevron:    `<svg class="day-chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>`,
  back:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="15 18 9 12 15 6"/></svg>`,
  reset:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.11"/></svg>`,
  trash:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  plus:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>`,
  camera:     `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  cameraBig:  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="32" height="32"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  circle:     `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>`,
  checked:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="11" fill="#34c759"/><polyline points="7 12.5 10.5 16 17 9" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  edit:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  history:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.11"/><polyline points="12 7 12 12 15 15"/></svg>`,
  export:     `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  import:     `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  timerPlay:  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  timerPause: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  timerReset: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.11"/></svg>`,
  checkAll:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>`,
};

// ─── HTML Helpers ─────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Render: Week View ────────────────────────────────────────────────────────

function renderWeekView() {
  const today = getTodayDayName();

  const dayCards = WORKOUT_DAYS.map(day => {
    const workouts = getDayData(day);
    const done  = workouts.filter(w => state.completedIDs.has(workoutID(day, w.Index))).length;
    const total = workouts.length;
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
    const isToday = day === today;

    return `
      <button class="day-card${isToday ? ' today' : ''}" data-action="nav-day" data-day="${esc(day)}">
        <div class="day-card-left">
          <div class="day-name-row">
            <span class="day-name">${esc(day)}</span>
            ${isToday ? '<span class="today-badge">Today</span>' : ''}
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="day-card-right">
          <span class="day-count">${done}/${total}</span>
          <span class="day-pct">${pct}%</span>
          ${ICONS.chevron}
        </div>
      </button>`;
  }).join('');

  const statusHTML = state.isLoading
    ? `<div class="card"><div class="loading-row"><div class="spinner"></div>Loading workouts…</div></div>`
    : state.errorMessage
      ? `<div class="error-card">${esc(state.errorMessage)}</div>`
      : '';

  const historySheet = state.showHistory ? renderHistorySheet() : '';

  return `
    <div class="view week-view">
      <header class="app-header">
        <h1 class="app-title">Workout Tracker</h1>
        <div class="header-actions">
          <button class="icon-btn" data-action="show-history" title="View history">${ICONS.history}</button>
          <button class="icon-btn" data-action="refresh" title="Refresh workouts">${ICONS.refresh}</button>
          <button class="icon-btn" data-action="toggle-dark" title="Toggle dark mode">
            ${state.isDarkMode ? ICONS.sun : ICONS.moon}
          </button>
        </div>
      </header>
      <div class="content">
        ${statusHTML}
        <div class="section-label">Weekly Plan</div>
        <div class="card">${dayCards}</div>

        <div class="data-actions">
          <button class="data-action-btn" data-action="export">${ICONS.export} Export Backup</button>
          <button class="data-action-btn" data-action="import">${ICONS.import} Import Backup</button>
        </div>

        <div class="reset-all-wrap">
          <button class="btn-destructive" data-action="reset-all">
            ${ICONS.trash} Reset All Progress
          </button>
        </div>
      </div>
    </div>
    ${historySheet}`;
}

// ─── Render: History Sheet ────────────────────────────────────────────────────

function renderHistorySheet() {
  const history = loadWeekHistory();
  const weeks   = Object.keys(history).sort().reverse().slice(0, 10);

  const content = weeks.length === 0
    ? '<div class="empty-state">No history yet — complete some workouts first.</div>'
    : weeks.map(key => {
        const week = history[key];
        const totalDone  = WORKOUT_DAYS.reduce((s, d) => s + (week[d]?.done  || 0), 0);
        const totalAll   = WORKOUT_DAYS.reduce((s, d) => s + (week[d]?.total || 0), 0);
        const overallPct = totalAll > 0 ? Math.round(totalDone / totalAll * 100) : 0;

        const dayDots = WORKOUT_DAYS.map(day => {
          const d   = week[day] || { done: 0, total: 0 };
          const pct = d.total > 0 ? Math.round(d.done / d.total * 100) : -1;
          const cls = pct === 100 ? 'full' : pct > 0 ? 'partial' : pct === 0 ? 'none' : 'missing';
          return `<div class="hist-day-col">
            <span class="hist-day-label">${day.slice(0, 3)}</span>
            <div class="hist-dot ${cls}"></div>
            <span class="hist-day-pct">${pct >= 0 ? pct + '%' : '—'}</span>
          </div>`;
        }).join('');

        return `
          <div class="hist-row">
            <div class="hist-row-top">
              <span class="hist-week-label">${weekKeyToLabel(key)}</span>
              <span class="hist-overall-pct ${overallPct === 100 ? 'perfect' : ''}">${overallPct}%</span>
            </div>
            <div class="hist-days">${dayDots}</div>
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

// ─── Render: Day View ─────────────────────────────────────────────────────────

function renderDayView() {
  const day            = state.currentDay;
  const allWorkouts    = getDayData(day);
  const originalsCount = state.sheetData.filter(r => r.Day === day).length;
  const categories     = getCategories(day);

  const filtered = state.filterCategory
    ? allWorkouts.filter(w => w.Category === state.filterCategory)
    : allWorkouts;

  const items = filtered.map(w => {
    const id       = workoutID(day, w.Index);
    const done     = state.completedIDs.has(id);
    const isCustom = w.Index >= originalsCount;
    const imgKey   = getImageKey(w);
    const badge    = w.Category ? `<span class="badge">${esc(w.Category)}</span>` : '';
    const notes    = w.Notes    ? `<p class="workout-notes">${esc(w.Notes)}</p>`  : '';

    const actions = isCustom
      ? `<div class="workout-actions">
           <button class="edit-btn" data-action="edit-workout" data-day="${esc(day)}" data-index="${w.Index}" title="Edit">${ICONS.edit}</button>
           <button class="delete-btn" data-action="delete-workout" data-day="${esc(day)}" data-index="${w.Index}" title="Delete">${ICONS.trash}</button>
         </div>`
      : '';

    return `
      <div class="workout-item" style="--swipe-x:0px">
        <button class="check-btn" data-action="toggle" data-id="${esc(id)}" aria-label="${done ? 'Mark incomplete' : 'Mark complete'}">
          ${done ? ICONS.checked : ICONS.circle}
        </button>
        <div class="workout-body">
          <div class="workout-title-row">
            <span class="workout-name${done ? ' done' : ''}">${esc(w.Workout)}</span>
            ${badge}
          </div>
          ${notes}
          <img class="workout-img" data-img-key="${esc(imgKey)}"
               src="" alt="Exercise photo" data-action="view-image" style="display:none">
          <button class="photo-btn" data-action="add-image"
                  data-day="${esc(day)}" data-index="${w.Index}"
                  data-img-key="${esc(imgKey)}">
            ${ICONS.camera}<span class="photo-btn-label">Add Photo</span>
          </button>
        </div>
        ${actions}
      </div>`;
  }).join('');

  // Category filter pills
  const filterPills = categories.length > 1
    ? `<div class="filter-bar">
        <button class="filter-pill${!state.filterCategory ? ' active' : ''}" data-action="filter" data-cat="">All</button>
        ${categories.map(c =>
          `<button class="filter-pill${state.filterCategory === c ? ' active' : ''}" data-action="filter" data-cat="${esc(c)}">${esc(c)}</button>`
        ).join('')}
       </div>`
    : '';

  const modalHTML = state.showModal ? renderModal() : '';

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
          <button class="list-btn orange" data-action="reset-day" data-day="${esc(day)}">
            ${ICONS.reset} Reset Day Progress
          </button>
        </div>

        <div class="section-header">
          <span class="section-label" style="margin:0">Workouts</span>
          <button class="complete-all-btn" data-action="complete-all" data-day="${esc(day)}">
            ${ICONS.checkAll} Complete All
          </button>
        </div>
        ${filterPills}
        <div class="card">
          ${items || '<div class="empty-state">No workouts found.</div>'}
        </div>

        <div class="card">
          <button class="list-btn blue" data-action="show-modal" data-day="${esc(day)}">
            ${ICONS.plus} Add Custom Workout
          </button>
        </div>
      </div>
    </div>
    ${modalHTML}`;
}

// ─── Render: Timer Card ───────────────────────────────────────────────────────

function renderTimerCard() {
  const mins    = Math.floor(timer.seconds / 60);
  const secs    = timer.seconds % 60;
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;
  const pct     = timer.initial > 0 ? (timer.seconds / timer.initial) * 100 : 100;

  const presets = [
    { s: 30,  label: '30s' },
    { s: 60,  label: '1m'  },
    { s: 90,  label: '90s' },
    { s: 120, label: '2m'  },
  ];

  const presetBtns = presets.map(p =>
    `<button class="timer-preset-btn${timer.preset === p.s && !timer.running ? ' active' : ''}"
             data-action="timer-preset" data-seconds="${p.s}"
             ${timer.running ? 'disabled' : ''}>${p.label}</button>`
  ).join('');

  return `
    <div class="card timer-card${timer.running ? ' timer-running' : ''}" id="timer-card">
      <div class="timer-progress-wrap">
        <div class="timer-progress" id="timer-progress" style="width:${pct}%"></div>
      </div>
      <div class="timer-inner">
        <div class="timer-left">
          <span class="timer-label">REST TIMER</span>
          <div class="timer-preset-row">${presetBtns}</div>
        </div>
        <div class="timer-right">
          <span class="timer-display" id="timer-display">${timeStr}</span>
          <div class="timer-btn-row">
            <button class="timer-start-btn" id="timer-start-btn" data-action="timer-toggle">
              ${timer.running ? ICONS.timerPause + '<span>Pause</span>' : ICONS.timerPlay + '<span>Start</span>'}
            </button>
            <button class="timer-reset-icon-btn" data-action="timer-reset" title="Reset timer">
              ${ICONS.timerReset}
            </button>
          </div>
        </div>
      </div>
    </div>`;
}

// ─── Render: Add / Edit Workout Modal ─────────────────────────────────────────

function renderModal() {
  const isEdit = state.showModal === 'edit';
  let prefill  = { name: '', category: '', notes: '' };

  if (isEdit && state.editTarget) {
    const { day, index } = state.editTarget;
    const originalsCount = state.sheetData.filter(r => r.Day === day).length;
    const row = state.customEdits[day]?.[index - originalsCount];
    if (row) {
      prefill.name     = row.Workout  || '';
      prefill.category = row.Category || '';
      prefill.notes    = row.Notes    || '';
    }
  }

  // Image section: pendingImg > editCurrentImg > placeholder
  const imgDataURL = pendingImg?.dataURL || (!editImgRemoved ? editCurrentImg : null);
  const imgSection = imgDataURL
    ? `<div class="img-upload-has-image">
         <img src="${esc(imgDataURL)}" class="img-upload-preview" alt="Preview">
         <button type="button" class="img-remove-btn" data-action="remove-modal-image">✕ Remove</button>
       </div>`
    : `<div class="img-upload-placeholder" data-action="pick-modal-image">
         ${ICONS.cameraBig}
         <span>Tap to add a reference photo</span>
       </div>`;

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" role="dialog" aria-modal="true" id="modal-box">
        <div class="modal-header">
          <button class="modal-cancel" data-action="close-modal">Cancel</button>
          <span class="modal-title">${isEdit ? 'Edit Workout' : 'New Workout'}</span>
          <button class="modal-save" data-action="save-workout"
                  data-day="${esc(isEdit ? state.editTarget.day : state.currentDay)}"
                  data-edit="${isEdit}">${isEdit ? 'Save' : 'Add'}</button>
        </div>
        <form class="modal-form" id="add-form" onsubmit="return false">
          <div class="form-section">
            <label class="form-label">Workout Details</label>
            <div class="form-card">
              <input id="f-name"     class="form-input" type="text"
                     placeholder="Workout Name (required)" autocomplete="off"
                     value="${esc(prefill.name)}">
              <div class="form-divider"></div>
              <input id="f-category" class="form-input" type="text"
                     placeholder="Category (optional)" autocomplete="off"
                     value="${esc(prefill.category)}">
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
  app.innerHTML = state.view === 'week' ? renderWeekView() : renderDayView();
  if (state.showModal) {
    requestAnimationFrame(() => {
      const nameInput = document.getElementById('f-name');
      if (nameInput) {
        nameInput.focus();
        // Move cursor to end for edit mode
        const len = nameInput.value.length;
        nameInput.setSelectionRange(len, len);
      }
    });
  }
}

// ─── Async Image Loading ──────────────────────────────────────────────────────

async function loadDayImages(day) {
  const workouts = getDayData(day);
  for (const w of workouts) {
    const key    = getImageKey(w);
    const dataURL = await getImage(key);
    if (!dataURL) continue;
    const imgEl = document.querySelector(`img[data-img-key="${CSS.escape(key)}"]`);
    if (!imgEl) continue;
    imgEl.src = dataURL;
    imgEl.style.display = '';
    const label = imgEl.closest('.workout-body')?.querySelector('.photo-btn-label');
    if (label) label.textContent = 'Change Photo';
  }
}

// ─── Full-Screen Image Viewer ─────────────────────────────────────────────────

function showImageViewer(dataURL) {
  document.getElementById('img-viewer')?.remove();
  const viewer = document.createElement('div');
  viewer.id = 'img-viewer';
  viewer.className = 'img-viewer';
  viewer.innerHTML = `
    <div class="img-viewer-backdrop"></div>
    <img class="img-viewer-img" src="${dataURL}" alt="Exercise photo">
    <button class="img-viewer-close" aria-label="Close">✕</button>`;
  viewer.addEventListener('click', e => {
    if (!e.target.closest('.img-viewer-img')) viewer.remove();
  });
  document.body.appendChild(viewer);
}

// ─── Swipe-to-Complete ────────────────────────────────────────────────────────

function setupSwipeHandlers() {
  let touch = null;

  document.addEventListener('touchstart', e => {
    const item = e.target.closest('.workout-item');
    if (!item) return;
    touch = {
      el:       item,
      startX:   e.touches[0].clientX,
      startY:   e.touches[0].clientY,
      swiping:  false,
      triggered: false,
    };
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!touch || touch.triggered) return;
    const dx = e.touches[0].clientX - touch.startX;
    const dy = e.touches[0].clientY - touch.startY;

    if (!touch.swiping && Math.abs(dx) > 8) {
      touch.swiping = Math.abs(dx) > Math.abs(dy);
    }
    if (touch.swiping && dx > 0) {
      const clamped = Math.min(dx * 0.6, 80);
      touch.el.style.setProperty('--swipe-x', `${clamped}px`);
    }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.startX;
    const dy = e.changedTouches[0].clientY - touch.startY;

    touch.el.style.setProperty('--swipe-x', '0px');

    if (touch.swiping && dx > 75 && Math.abs(dx) > Math.abs(dy) * 2) {
      const checkBtn = touch.el.querySelector('[data-action="toggle"]');
      if (checkBtn) toggleCompletion(checkBtn.dataset.id);
    }
    touch = null;
  }, { passive: true });
}

// ─── Events ───────────────────────────────────────────────────────────────────

document.addEventListener('click', async e => {
  // Tap overlay background to close
  if (e.target.id === 'modal-overlay') {
    pendingImg = null; editCurrentImg = null; editImgRemoved = false;
    state.showModal  = false;
    state.editTarget = null;
    state.showHistory = false;
    render();
    if (state.view === 'day') loadDayImages(state.currentDay);
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  switch (btn.dataset.action) {

    case 'nav-day':
      state.view           = 'day';
      state.currentDay     = btn.dataset.day;
      state.filterCategory = null;
      render();
      window.scrollTo(0, 0);
      loadDayImages(btn.dataset.day);
      break;

    case 'back':
      state.view       = 'week';
      state.currentDay = null;
      state.showModal  = false;
      state.editTarget = null;
      pendingImg = null; editCurrentImg = null; editImgRemoved = false;
      render();
      window.scrollTo(0, 0);
      break;

    case 'toggle':
      toggleCompletion(btn.dataset.id);
      break;

    case 'toggle-dark':
      toggleDarkMode();
      break;

    case 'refresh':
      fetchSheetData();
      break;

    case 'reset-all':
      resetAll();
      break;

    case 'reset-day':
      resetDay(btn.dataset.day);
      break;

    case 'complete-all':
      completeAll(btn.dataset.day);
      break;

    case 'show-modal':
      pendingImg = null; editCurrentImg = null; editImgRemoved = false;
      state.showModal  = 'add';
      state.editTarget = null;
      render();
      break;

    case 'close-modal':
      pendingImg = null; editCurrentImg = null; editImgRemoved = false;
      state.showModal  = false;
      state.editTarget = null;
      render();
      if (state.view === 'day') loadDayImages(state.currentDay);
      break;

    case 'pick-modal-image': {
      const dataURL = await pickImage();
      if (!dataURL) return;
      pendingImg = { dataURL };
      editImgRemoved = false;
      render();
      break;
    }

    case 'remove-modal-image':
      pendingImg = null;
      editCurrentImg = null;
      editImgRemoved = true;
      render();
      break;

    case 'save-workout': {
      const name  = document.getElementById('f-name')?.value.trim();
      const cat   = document.getElementById('f-category')?.value.trim();
      const notes = document.getElementById('f-notes')?.value.trim();
      const day   = btn.dataset.day;
      const isEdit = btn.dataset.edit === 'true';

      if (!name) { document.getElementById('f-name')?.focus(); return; }

      if (isEdit && state.editTarget) {
        const { index } = state.editTarget;
        const originalsCount = state.sheetData.filter(r => r.Day === day).length;
        const row = state.customEdits[day]?.[index - originalsCount];

        if (pendingImg && row?._imgKey) {
          await saveImage(row._imgKey, pendingImg.dataURL);
        } else if (editImgRemoved && row?._imgKey) {
          await deleteImage(row._imgKey);
        }
        editWorkout(day, index, name, cat, notes);
      } else {
        let imgKey = null;
        if (pendingImg) {
          imgKey = uuid();
          await saveImage(imgKey, pendingImg.dataURL);
        }
        addWorkout(day, name, cat, notes, imgKey);
      }

      pendingImg = null; editCurrentImg = null; editImgRemoved = false;
      state.showModal  = false;
      state.editTarget = null;
      render();
      loadDayImages(state.currentDay);
      break;
    }

    case 'edit-workout': {
      const day   = btn.dataset.day;
      const index = parseInt(btn.dataset.index, 10);
      const originalsCount = state.sheetData.filter(r => r.Day === day).length;
      const row   = state.customEdits[day]?.[index - originalsCount];
      // Pre-load the existing image for display in the modal
      editCurrentImg  = row?._imgKey ? await getImage(row._imgKey) : null;
      editImgRemoved  = false;
      pendingImg      = null;
      state.showModal  = 'edit';
      state.editTarget = { day, index };
      render();
      break;
    }

    case 'delete-workout': {
      const day   = btn.dataset.day;
      const index = parseInt(btn.dataset.index, 10);
      if (confirm('Delete this custom workout?')) {
        await deleteCustomWorkout(day, index);
      }
      break;
    }

    case 'add-image': {
      const imgKey  = btn.dataset.imgKey;
      const dataURL = await pickImage();
      if (!dataURL) return;
      await saveImage(imgKey, dataURL);
      const imgEl = document.querySelector(`img[data-img-key="${CSS.escape(imgKey)}"]`);
      if (imgEl) {
        imgEl.src = dataURL;
        imgEl.style.display = '';
        const label = imgEl.closest('.workout-body')?.querySelector('.photo-btn-label');
        if (label) label.textContent = 'Change Photo';
      }
      break;
    }

    case 'view-image': {
      const src = btn.getAttribute('src');
      if (src) showImageViewer(src);
      break;
    }

    case 'filter':
      state.filterCategory = btn.dataset.cat || null;
      render();
      loadDayImages(state.currentDay);
      break;

    case 'timer-toggle':
      timer.running ? pauseTimer() : startTimer();
      break;

    case 'timer-preset':
      setTimerPreset(Number(btn.dataset.seconds));
      break;

    case 'timer-reset':
      resetTimer();
      break;

    case 'show-history':
      state.showHistory = true;
      render();
      break;

    case 'close-history':
      state.showHistory = false;
      render();
      break;

    case 'export':
      exportData();
      break;

    case 'import':
      triggerImport();
      break;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('img-viewer')?.remove();
    if (state.showModal) {
      pendingImg = null; editCurrentImg = null; editImgRemoved = false;
      state.showModal  = false;
      state.editTarget = null;
      render();
      if (state.view === 'day') loadDayImages(state.currentDay);
    }
    if (state.showHistory) {
      state.showHistory = false;
      render();
    }
  }
});

// ─── Service Worker ───────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('Service worker registration failed:', err));
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadState();
applyTheme();
render();
fetchSheetData();
setupSwipeHandlers();
