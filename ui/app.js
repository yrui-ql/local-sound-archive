'use strict';

/* ---------- tiny utils ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  page: 'library',
  library: [],
  formats: {},
  totalBytes: 0,
  libraryLoaded: false,
  query: '',
  filter: 'all',
  sort: 'time',
  limit: 80,
  recent: [],
  search: [],
  searchLoading: false,
  selected: new Set(),
  playing: null,
  isPlaying: false,
  playQueue: [],
  queueIndex: -1,
  shuffle: false,
  repeat: 'off',
  busy: false,
  progressEl: null,
  downloads: null,
  downloadsLoading: false,
  downloadsError: null,
  downloadTab: 'active',
  likes: null,
  likesRunning: false,
  account: { source: null, key: null, timer: null, previous: null, closeTimer: null },
  record: false,
  recordSeconds: 0,
  recordPolling: false,
  fx: { enabled: false, bypass: false, preset: 'flat', intensity: 1, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bass: 0, treble: 0, width: 100 },
  extensions: [],
  extensionSafeMode: false,
  agents: [],
  aiControl: null,
};

let seq = 0;
const pending = new Map();
let downloadTimer = null;
let infoTrigger = null;
const webview = window.chrome && window.chrome.webview ? window.chrome.webview : null;
const PLAYER_PREFS_KEY = 'musicArchivePlayer';
function savePlayerPrefs() {
  try {
    localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify({
      volume: Number($('#volume').value),
      muted: !!audio.muted,
      mode: currentPlayMode(),
      sort: state.sort,
    }));
  } catch { }
}
function loadPlayerPrefs() {
  let prefs = { volume: 80, muted: false, mode: 'order' };
  try {
    const raw = localStorage.getItem(PLAYER_PREFS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v.volume === 'number') prefs.volume = Math.max(0, Math.min(100, v.volume));
      if (typeof v.muted === 'boolean') prefs.muted = v.muted;
      if (!v.mode && v.shuffle) prefs.mode = 'shuffle';
      else if (['order', 'all', 'one', 'shuffle'].includes(v.mode)) prefs.mode = v.mode;
      if (['time', 'artist', 'title', 'size', 'format'].includes(v.sort)) state.sort = v.sort;
    }
  } catch { }
  $('#libSort').value = state.sort;
  $('#volume').value = String(prefs.volume);
  audio.volume = prefs.volume / 100;
  audio.muted = prefs.muted;
  setPlayMode(prefs.mode, true);
  updateMute();
}

/* ---------- appearance theme ---------- */
const THEME_KEY = 'musicArchiveTheme';
const THEME_MODES = ['vinyl', 'paper', 'celadon', 'ocean', 'cherry', 'system'];
const THEME_META = {
  vinyl: { label: '黑胶', tone: '深色' },
  paper: { label: '纸页', tone: '浅色' },
  celadon: { label: '青瓷', tone: '深色' },
  ocean: { label: '夜蓝', tone: '深色' },
  cherry: { label: '樱桃', tone: '深色' },
  system: { label: '跟随系统', tone: '' },
};
const SYSTEM_THEME_QUERY = window.matchMedia('(prefers-color-scheme: light)');
let currentThemeMode = 'vinyl';
let currentResolvedTheme = 'vinyl';
function resolveThemeMode(mode) {
  if (mode === 'system') return SYSTEM_THEME_QUERY.matches ? 'paper' : 'vinyl';
  return THEME_MODES.includes(mode) && mode !== 'system' ? mode : 'vinyl';
}
function applyThemeMode(mode, persist = true) {
  const normalized = mode === 'dark' ? 'vinyl' : mode === 'light' ? 'paper' : mode;
  currentThemeMode = THEME_MODES.includes(normalized) ? normalized : 'vinyl';
  const resolved = resolveThemeMode(currentThemeMode);
  currentResolvedTheme = resolved;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = currentThemeMode;
  const meta = THEME_META[currentThemeMode];
  const tone = THEME_META[resolved]?.tone || '';
  $('#themeState').textContent = currentThemeMode === 'system' ? '跟随系统 · ' + THEME_META[resolved].label : meta.label;
  $$('.theme-option').forEach((button) => {
    const active = button.dataset.themeMode === currentThemeMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  document.documentElement.classList.add('theme-switching');
  clearTimeout(applyThemeMode._timer);
  applyThemeMode._timer = setTimeout(() => document.documentElement.classList.remove('theme-switching'), 320);
  if (persist) { try { localStorage.setItem(THEME_KEY, currentThemeMode); } catch { } }
  call('setTheme', { dark: resolved !== 'paper' }).catch(() => {});
}
function initTheme() {
  let stored = 'vinyl';
  try { stored = localStorage.getItem(THEME_KEY) || 'vinyl'; } catch { }
  applyThemeMode(stored, false);
  SYSTEM_THEME_QUERY.addEventListener('change', () => { if (currentThemeMode === 'system') applyThemeMode('system', false); });
  $$('.theme-option').forEach((button) => {
    button.addEventListener('click', () => applyThemeMode(button.dataset.themeMode));
  });
}

/* ---------- interface scale ---------- */
const UI_SCALE_KEY = 'musicArchiveUiScaleV3';
const UI_SCALE_MIN = 0.9;
const UI_SCALE_MAX = 1.5;
let currentUiScale = 1;
let uiScaleFrame = 0;
let pendingUiScale = null;
function applyUiScaleRequest(scale) {
  pendingUiScale = scale;
  if (uiScaleFrame) return;
  uiScaleFrame = requestAnimationFrame(() => {
    uiScaleFrame = 0;
    const value = pendingUiScale;
    pendingUiScale = null;
    if (value === null) return;
    call('setUiScale', { scale: value }).catch(() => {});
  });
}
function previewUiScale(value) {
  let scale = Number(value);
  if (!Number.isFinite(scale)) scale = 1;
  scale = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, scale));
  scale = Math.round(scale * 100) / 100;
  currentUiScale = scale;
  $('#uiScaleValue').textContent = Math.round(scale * 100) + '%';
  applyUiScaleRequest(scale);
}
function applyUiScale(value, persist = true) {
  let scale = Number(value);
  if (!Number.isFinite(scale)) scale = 1;
  scale = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, scale));
  scale = Math.round(scale * 100) / 100;
  currentUiScale = scale;
  const percent = Math.round(scale * 100);
  $('#uiScaleRange').value = String(percent);
  $('#uiScaleValue').textContent = percent + '%';
  if (persist) { try { localStorage.setItem(UI_SCALE_KEY, String(scale)); } catch { } }
  applyUiScaleRequest(scale);
}
function stepUiScale(direction) {
  applyUiScale(currentUiScale + direction * 0.05);
  toast('界面比例 ' + Math.round(currentUiScale * 100) + '%', 'ok');
}
function initUiScale() {
  let stored = 1;
  try {
    const raw = Number(localStorage.getItem(UI_SCALE_KEY));
    if (Number.isFinite(raw) && raw >= UI_SCALE_MIN && raw <= UI_SCALE_MAX) stored = raw;
  } catch { }
  applyUiScale(stored, false);
  const range = $('#uiScaleRange');
  range.addEventListener('input', () => previewUiScale(Number(range.value) / 100));
  range.addEventListener('change', () => applyUiScale(Number(range.value) / 100));
  $('#btnUiScaleReset').addEventListener('click', () => { applyUiScale(1); toast('界面比例已重置', 'ok'); });
}

/* ---------- user-defined shortcuts ---------- */
const SHORTCUT_KEY = 'musicArchiveShortcuts';
const SHORTCUT_ACTIONS = [
  { id: 'togglePlay', label: '播放 / 暂停', hint: '和下方播放按钮相同', run: () => togglePlay() },
  { id: 'prevTrack', label: '上一首', hint: '切到队列中的上一首', run: () => prevTrack() },
  { id: 'nextTrack', label: '下一首', hint: '切到队列中的下一首', run: () => nextTrack() },
  { id: 'focusSearch', label: '聚焦音乐库搜索', hint: '打开音乐库并聚焦搜索框', run: () => { showPage('library'); setTimeout(() => $('#libSearch').focus(), 30); } },
  { id: 'toggleQueue', label: '打开 / 关闭播放队列', hint: '和播放器右侧队列按钮相同', run: () => { queueOpen ? closeQueueDrawer() : openQueueDrawer(); } },
  { id: 'scaleUp', label: '放大界面比例', hint: '和外观里的比例滑块相同', run: () => stepUiScale(1) },
  { id: 'scaleDown', label: '缩小界面比例', hint: '和外观里的比例滑块相同', run: () => stepUiScale(-1) },
];
let shortcutBindings = {};
let shortcutCapture = null;
function formatShortcut(combo) { return combo ? combo.split('+').map((part) => part.length === 1 ? part : part).join(' + ') : ''; }
function comboFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key === 'Escape') key = 'Esc';
  else if (key.length === 1) key = key.toUpperCase();
  return mods.concat(key).join('+');
}
function saveShortcuts() { try { localStorage.setItem(SHORTCUT_KEY, JSON.stringify(shortcutBindings)); } catch { } }
function loadShortcuts() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHORTCUT_KEY) || '{}');
    shortcutBindings = raw && typeof raw === 'object' ? raw : {};
  } catch { shortcutBindings = {}; }
  for (const key of Object.keys(shortcutBindings)) {
    if (!SHORTCUT_ACTIONS.some((action) => action.id === key) || typeof shortcutBindings[key] !== 'string') delete shortcutBindings[key];
  }
}
function renderShortcuts() {
  const list = $('#shortcutList');
  if (!list) return;
  list.innerHTML = SHORTCUT_ACTIONS.map((action) => '<div class="shortcut-row">' +
    '<div class="shortcut-copy"><strong>' + esc(action.label) + '</strong><small>' + esc(action.hint) + '</small></div>' +
    '<kbd class="shortcut-value' + (shortcutBindings[action.id] ? ' set' : '') + '">' + esc(formatShortcut(shortcutBindings[action.id]) || '未设置') + '</kbd>' +
    '<div class="shortcut-actions"><button class="btn ghost small" data-shortcut-set="' + action.id + '">设置</button><button class="btn ghost small" data-shortcut-clear="' + action.id + '">清除</button></div>' +
    '</div>').join('');
  list.querySelectorAll('[data-shortcut-set]').forEach((button) => button.addEventListener('click', () => beginShortcutCapture(button.dataset.shortcutSet)));
  list.querySelectorAll('[data-shortcut-clear]').forEach((button) => button.addEventListener('click', () => {
    delete shortcutBindings[button.dataset.shortcutClear]; saveShortcuts(); renderShortcuts();
  }));
}
function beginShortcutCapture(id) {
  if (!SHORTCUT_ACTIONS.some((action) => action.id === id)) return;
  shortcutCapture = id;
  document.body.classList.add('shortcut-capturing');
  toast('请按下新的组合键，Esc 取消', 'ok');
}
function cancelShortcutCapture() {
  shortcutCapture = null;
  document.body.classList.remove('shortcut-capturing');
}
function onShortcutCapture(e) {
  if (!shortcutCapture) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelShortcutCapture(); toast('已取消快捷键设置'); return; }
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  const combo = comboFromEvent(e);
  if (!combo) { cancelShortcutCapture(); return; }
  for (const [id, value] of Object.entries(shortcutBindings)) if (value === combo && id !== shortcutCapture) delete shortcutBindings[id];
  shortcutBindings[shortcutCapture] = combo;
  saveShortcuts();
  cancelShortcutCapture();
  renderShortcuts();
  toast('快捷键已设置：' + formatShortcut(combo), 'ok');
}
function runShortcut(id) {
  const action = SHORTCUT_ACTIONS.find((item) => item.id === id);
  if (action) { try { action.run(); } catch { } }
}
document.addEventListener('keydown', onShortcutCapture, true);
$('#btnClearShortcuts').addEventListener('click', () => { shortcutBindings = {}; saveShortcuts(); renderShortcuts(); toast('快捷键已全部清除', 'ok'); });
loadShortcuts();
renderShortcuts();

// 桌面客户端保留标准文本选择行为；快捷键只走用户配置表。

function call(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    if (!webview) { reject(new Error('当前不在客户端内运行')); return; }
    const id = 'r' + (++seq);
    pending.set(id, { resolve, reject });
    try { webview.postMessage({ id, cmd, args }); }
    catch (err) { pending.delete(id); reject(err); }
  });
}

if (webview) webview.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'progress') { setProgress(String(msg.data || '')); return; }
  if (msg.type === 'likes') { handleLikesEvent(msg.data || {}); return; }
  if (msg.type === 'ai-command') {
    handleAiCommand(String(msg.action || ''), msg.args || {}).then((result) => {
      call('aiResult', { requestId: msg.id, result }).catch(() => {});
    }).catch((error) => {
      call('aiResult', { requestId: msg.id, error: error.message || String(error) }).catch(() => {});
    });
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.data);
  else p.reject(new Error(msg.error || '操作失败'));
});

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function icon(name, cls = '') {
  return '<svg class="icon ' + cls + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
}
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
}
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function safeCover(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : '';
}
function hueFor(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function artMarkup(name, sub, cover, extraClass = '') {
  const safe = safeCover(cover);
  const initial = esc((String(name || '?').trim() || '?').slice(0, 1).toUpperCase());
  return '<div class="art ' + extraClass + '" style="--h:' + hueFor(String(name) + '|' + String(sub)) + '" aria-hidden="true">' +
    '<span class="art-initial">' + initial + '</span>' +
    (safe ? '<img src="' + esc(safe) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
    '</div>';
}
function sourceLabel(source) {
  return ({ netease: '网易云', qq: 'QQ', soda: '汽水', kugou: '酷狗', kuwo: '酷我', migu: '咪咕', bilibili: 'B站', qianqian: '千千', joox: 'JOOX', apple: 'Apple', jamendo: 'Jamendo', fivesing: '5sing' })[source] || (source || '在线');
}
function statusLabel(status) {
  return ({ waiting: '等待', downloading: '下载中', success: '成功', failed: '失败', skipped: '跳过', canceled: '已取消' })[status] || status || '未知';
}
function statusClass(status) { return 'status-' + (status || 'waiting'); }
function emptyState(iconName, title, text, action = '') {
  return '<div class="empty"><div class="empty-icon">' + icon(iconName) + '</div><b>' + esc(title) + '</b><span>' + esc(text) + '</span>' + action + '</div>';
}
function setProgress(text) {
  if (state.progressEl && document.contains(state.progressEl)) state.progressEl.textContent = text;
}

/* ---------- toast / modal ---------- */
function toast(text, kind = '', action = null) {
  const wrap = $('#toasts');
  while (wrap.children.length >= 3) wrap.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.setAttribute('role', 'status');
  const copy = document.createElement('span');
  copy.textContent = text;
  el.appendChild(copy);
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { close(); action.onClick(); });
    el.appendChild(b);
    timer = setTimeout(close, 6800);
  } else {
    timer = setTimeout(close, 4600);
  }
  wrap.appendChild(el);
}

function openModal({ title, text, confirmLabel = '确定', cancelLabel = '取消', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const previous = document.activeElement;
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    const ok = $('#modalOk');
    const cancel = $('#modalCancel');
    ok.textContent = confirmLabel;
    cancel.textContent = cancelLabel;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    const focusables = () => $$('#modal button:not(:disabled)').filter((el) => el.offsetParent !== null);
    const finish = (value) => {
      modal.classList.add('closing');
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey, true);
      modal.removeEventListener('click', onBackdrop);
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      if (previous && typeof previous.focus === 'function') previous.focus();
      setTimeout(() => {
        modal.classList.remove('closing');
        modal.classList.add('hidden');
        resolve(value);
      }, 150);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => { if (e.target === modal) finish(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    (danger ? cancel : ok).focus();
  });
}

/* ---------- tooltips ---------- */
function openInfo(btn) {
  const tip = btn.dataset.tip;
  if (!tip) return;
  if (infoTrigger === btn) { closeInfo(); return; }
  closeInfo();
  infoTrigger = btn;
  btn.setAttribute('aria-expanded', 'true');
  const pop = $('#infoPopover');
  pop.textContent = tip;
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const width = Math.min(310, window.innerWidth - 28);
  const left = Math.max(14, Math.min(r.left, window.innerWidth - width - 14));
  let top = r.bottom + 8;
  if (top + pop.offsetHeight > window.innerHeight - 96) top = Math.max(12, r.top - pop.offsetHeight - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.style.width = width + 'px';
}
function closeInfo() {
  if (infoTrigger) infoTrigger.setAttribute('aria-expanded', 'false');
  infoTrigger = null;
  $('#infoPopover').hidden = true;
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.info-btn');
  if (btn) { e.preventDefault(); e.stopPropagation(); openInfo(btn); return; }
  if (!e.target.closest('#infoPopover')) closeInfo();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInfo(); });
window.addEventListener('resize', closeInfo);
document.addEventListener('scroll', closeInfo, true);

/* ---------- navigation ---------- */
const PAGES = ['library', 'search', 'downloads', 'likes', 'record', 'settings', 'extensions', 'recent'];
function showPage(name) {
  if (!PAGES.includes(name)) return;
  state.page = name;
  $$('.nav-item').forEach((b) => {
    const active = b.dataset.page === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  const main = $('#main');
  if (main) main.scrollTop = 0;
  closeInfo();
  if (name === 'search') setTimeout(() => $('#searchInput').focus(), 40);
  if (name === 'record') loadRecordings();
  if (name === 'settings') { loadAppInfo(); loadAiControl(); }
  if (name === 'extensions') { loadExtensions(); loadAgents(); }
  if (name === 'likes') loadLikes();
  if (name === 'recent') renderRecent();
  if (name === 'downloads') { loadDownloads(true); startDownloadPolling(); }
  else stopDownloadPolling();
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

/* ---------- library ---------- */
const FORMAT_ORDER = ['flac', 'm4a', 'mp3', 'wav', 'ogg', 'aac', 'opus', 'ape'];
function isOtherFormat(ext) { return !['flac', 'mp3', 'm4a'].includes(ext); }
function sortTracks(list) {
  const arr = list.slice();
  const loc = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN', { sensitivity: 'base', numeric: true });
  if (state.sort === 'time') arr.sort((a, b) => (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0) || loc(a.title, b.title));
  else if (state.sort === 'title') arr.sort((a, b) => loc(a.title, b.title) || loc(a.artist, b.artist));
  else if (state.sort === 'size') arr.sort((a, b) => (b.size || 0) - (a.size || 0));
  else if (state.sort === 'format') arr.sort((a, b) => loc(a.ext, b.ext) || loc(a.artist, b.artist));
  else arr.sort((a, b) => loc(a.artist, b.artist) || loc(a.title, b.title) || loc(a.album, b.album));
  return arr;
}
function filteredLibrary() {
  const q = state.query.trim().toLowerCase();
  let list = state.library.filter((t) => {
    if (state.filter === 'other') { if (!isOtherFormat(t.ext)) return false; }
    else if (state.filter !== 'all' && t.ext !== state.filter) return false;
    if (!q) return true;
    return (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q);
  });
  return sortTracks(list);
}

/* ---------- recently played ---------- */
const RECENT_KEY = 'musicArchiveRecent';
function readRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(value) ? value.filter((x) => x && x.url).slice(0, 60) : [];
  } catch { return []; }
}
function saveRecent() {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent.slice(0, 60))); } catch { }
}
function recordRecent(track) {
  if (!track || !track.url) return;
  state.recent = state.recent.filter((x) => x.url !== track.url);
  state.recent.unshift({
    url: track.url, title: track.title || '', artist: track.artist || '', album: track.album || '',
    size: track.size || 0, ext: track.ext || '', addedAt: track.addedAt || '', at: new Date().toISOString(),
  });
  state.recent = state.recent.slice(0, 60);
  saveRecent();
  if (state.page === 'recent') renderRecent();
}
function recentWhen(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return '今天 ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  return (date.getMonth() + 1) + '/' + date.getDate() + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
function renderRecent() {
  const list = $('#recentList');
  if (!list) return;
  $('#recentCount').textContent = state.recent.length ? state.recent.length + ' 首' : '';
  $('#recentSub').textContent = state.recent.length ? '本机记录，最近 ' + state.recent.length + ' 首' : '本机记录，最近 60 首';
  if (!state.recent.length) {
    list.innerHTML = '<div class="recent-empty">' + icon('history') + '<b>还没有播放记录</b><span>在音乐库里双击一首歌，之后可以从这里继续播放。</span></div>';
    return;
  }
  list.innerHTML = state.recent.map((track, index) => {
    const active = state.playing && state.playing.url === track.url;
    const fmt = track.ext ? String(track.ext).toUpperCase() : '';
    return '<button class="recent-item' + (active ? ' active' : '') + '" data-recent-i="' + index + '" role="listitem" style="--h:' + hueFor((track.title || '') + '|' + (track.artist || '')) + '">' +
      '<span class="recent-index">' + (active ? '▶' : String(index + 1).padStart(2, '0')) + '</span>' +
      '<span class="art recent-art"><span class="art-initial">' + esc(String(track.title || '?').slice(0, 1).toUpperCase()) + '</span></span>' +
      '<span class="recent-copy"><b>' + esc(track.title || '未知歌曲') + '</b><small>' + esc(track.artist || '未知歌手') + (fmt ? ' · ' + esc(fmt) : '') + '</small></span>' +
      '<span class="recent-when">' + esc(recentWhen(track.at)) + '</span>' +
    '</button>';
  }).join('');
  list.querySelectorAll('[data-recent-i]').forEach((el) => {
    el.addEventListener('click', () => {
      const track = state.recent[Number(el.dataset.recentI)];
      if (track) playTrack(track, state.recent);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const track = state.recent[Number(el.dataset.recentI)];
      if (track) openTrackMenu(track, state.recent, e.clientX, e.clientY);
    });
  });
}
function selectTrack(url) {
  state.selectedTrack = url;
  $$('#libList .row').forEach((row) => {
    const on = row.dataset.url === url;
    row.classList.toggle('selected', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}
function updateStats() {
  const n = state.library.length;
  $('#statCount').textContent = n ? String(n) : '0';
  $('#navCount').textContent = n ? String(n) : '0';
  $('#statSize').textContent = formatSize(state.totalBytes);
  const parts = FORMAT_ORDER.filter((k) => state.formats[k]).map((k) => k.toUpperCase() + ' ' + state.formats[k]);
  const other = Object.keys(state.formats).filter((k) => !FORMAT_ORDER.includes(k)).reduce((s, k) => s + state.formats[k], 0);
  if (other) parts.push('其他 ' + other);
  $('#statFormats').textContent = parts.join(' · ') || '—';
  $('#libSub').textContent = n ? '本地文件索引 · 不移动源文件' : '等待本地索引…';
  $('#sidebarMeta').textContent = n ? n + ' 首 · ' + formatSize(state.totalBytes) : '正在加载索引';
  $('#indexState').textContent = state.libraryLoaded ? '索引就绪' : '载入中';
}
function updateRowPlayIcons() {
  $$('#libList .row').forEach((row) => {
    const isPlaying = state.playing && state.playing.url === row.dataset.url && state.isPlaying;
    const use = row.querySelector('.row-play use');
    if (use) use.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
    row.classList.toggle('playing', !!(state.playing && state.playing.url === row.dataset.url));
  });
}
function renderLibrary() {
  const list = $('#libList');
  if (!state.libraryLoaded) return;
  const filtered = filteredLibrary();
  const shown = filtered.slice(0, state.limit);
  const currentUrl = state.playing ? state.playing.url : null;
  if (!filtered.length) {
    list.innerHTML = emptyState('library', state.library.length ? '没有匹配的歌曲' : '音乐库还是空的',
      state.library.length ? '换个关键词，或切换格式筛选。' : '先到「搜索下载」拿几首歌，或在设置里整理音乐库。',
      state.library.length ? '' : '<button class="btn primary small" data-go="search">去搜索</button>');
    const go = list.querySelector('[data-go="search"]');
    if (go) go.addEventListener('click', () => showPage('search'));
  } else {
    list.innerHTML = shown.map((t, i) => {
      const playing = currentUrl === t.url;
      const selected = state.selectedTrack === t.url;
      const dur = t.duration ? formatTime(t.duration) : '';
      return '<div class="row lib-grid' + (playing ? ' playing' : '') + (selected ? ' selected' : '') + '" data-url="' + esc(t.url) + '" tabindex="0" role="option" aria-selected="' + (selected ? 'true' : 'false') + '" aria-label="' + esc(t.title + '，' + t.artist) + '">' +
        '<span class="idx">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<div class="cover-cell">' + artMarkup(t.title, t.artist) + '<div class="cell"><div class="cell-title" title="' + esc(t.title) + '">' + esc(t.title) + '</div><div class="cell-sub" title="' + esc(t.artist) + '">' + esc(t.artist) + '</div></div></div>' +
        '<div class="cell cell-muted col-album" title="' + esc(t.album || '—') + '">' + esc(t.album || '—') + '</div>' +
        '<div><span class="badge' + (t.ext === 'flac' ? ' accent' : '') + '">' + esc(t.ext.toUpperCase()) + '</span></div>' +
        '<div class="cell-muted">' + formatSize(t.size) + (dur ? ' <span class="cell-sub">' + dur + '</span>' : '') + '</div>' +
        '<button class="row-play" tabindex="-1" data-play="' + esc(t.url) + '" aria-label="' + (playing && state.isPlaying ? '暂停' : '播放') + ' ' + esc(t.title) + '">' + icon(playing && state.isPlaying ? 'pause' : 'play') + '</button>' +
        '</div>';
    }).join('');
  }
  list.querySelectorAll('.row').forEach((row) => {
    const track = state.library.find((x) => x.url === row.dataset.url);
    if (!track) return;
    row.addEventListener('click', (e) => { if (!e.target.closest('[data-play]')) selectTrack(track.url); });
    row.addEventListener('dblclick', () => playTrack(track, filtered));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openTrackMenu(track, filtered, e.clientX, e.clientY); });
    row.addEventListener('keydown', (e) => {
      const rows = Array.from(list.querySelectorAll('.row'));
      const i = rows.indexOf(row);
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playTrack(track, filtered); }
      else if (e.key === 'ArrowDown' && rows[i + 1]) { e.preventDefault(); rows[i + 1].focus(); selectTrack(rows[i + 1].dataset.url); }
      else if (e.key === 'ArrowUp' && rows[i - 1]) { e.preventDefault(); rows[i - 1].focus(); selectTrack(rows[i - 1].dataset.url); }
      else if (e.key === 'Home' && rows[0]) { e.preventDefault(); rows[0].focus(); selectTrack(rows[0].dataset.url); }
      else if (e.key === 'End' && rows[rows.length - 1]) { e.preventDefault(); rows[rows.length - 1].focus(); selectTrack(rows[rows.length - 1].dataset.url); }
    });
    const btn = row.querySelector('[data-play]');
    if (btn) btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.playing && state.playing.url === track.url) togglePlay();
      else playTrack(track, filtered);
    });
  });
  const shownCount = shown.length;
  $('#libFoot').textContent = filtered.length
    ? (filtered.length > shownCount ? '显示 ' + shownCount + ' / ' + filtered.length + ' 首 · 向下滚动自动加载' : '已显示全部 ' + filtered.length + ' 首')
    : '';
  $('#btnMore').classList.add('hidden');
  updateStats();
}
let libAutoLoading = false;
function loadMoreLibrary() {
  if (libAutoLoading) return;
  const filtered = filteredLibrary();
  if (state.limit >= filtered.length) return;
  libAutoLoading = true;
  state.limit += 80;
  renderLibrary();
  requestAnimationFrame(() => { libAutoLoading = false; });
}
const libScrollRoot = document.querySelector('.main');
const libFootObserver = new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) loadMoreLibrary();
}, { root: libScrollRoot, rootMargin: '0px 0px 520px 0px', threshold: 0 });
libFootObserver.observe($('#libFoot'));
function skeletonRows(n) {
  return Array.from({ length: n }, () => '<div class="skeleton-row"><div class="sk sk-art"></div><div class="sk-lines"><div class="sk sk-line w60"></div><div class="sk sk-line w30"></div></div><div class="sk sk-line" style="width:18%"></div><div class="sk sk-line" style="width:9%"></div></div>').join('');
}
async function loadLibrary() {
  $('#libSkeleton').innerHTML = skeletonRows(6);
  $('#libSkeleton').classList.remove('hidden');
  $('#libList').innerHTML = '';
  try {
    const data = await call('getLibrary');
    state.library = data.tracks || [];
    state.formats = data.formats || {};
    state.totalBytes = data.totalBytes || 0;
    state.libraryLoaded = true;
    $('#libSkeleton').classList.add('hidden');
    renderLibrary();
  } catch (err) {
    $('#libSkeleton').classList.add('hidden');
    state.libraryLoaded = true;
    $('#libSub').textContent = '加载本地索引失败：' + err.message;
    $('#indexState').textContent = '索引失败';
    $('#libList').innerHTML = emptyState('info', '加载失败', err.message, '<button class="btn ghost small" data-retry>重试</button>');
    const retry = $('#libList [data-retry]');
    if (retry) retry.addEventListener('click', loadLibrary);
    toast('音乐库加载失败：' + err.message, 'err');
  }
}
$('#libSearch').addEventListener('input', (e) => { state.query = e.target.value; state.limit = 80; renderLibrary(); });

function bindSearchClear(inputSelector, buttonSelector) {
  const input = $(inputSelector);
  const button = $(buttonSelector);
  if (!input || !button) return;
  const sync = () => button.classList.toggle('hidden', !input.value);
  input.addEventListener('input', sync);
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    sync();
    input.focus();
  });
  sync();
}
bindSearchClear('#libSearch', '#libSearchClear');
bindSearchClear('#searchInput', '#searchInputClear');
$('#libFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  state.limit = 80;
  $$('#libFilters .chip').forEach((x) => x.classList.toggle('active', x === btn));
  renderLibrary();
});
$('#libSort').addEventListener('change', (e) => { state.sort = e.target.value; state.limit = 80; savePlayerPrefs(); renderLibrary(); });
$('#btnMore').addEventListener('click', () => { state.limit += 80; renderLibrary(); });
$('#btnOpenLib').addEventListener('click', () => call('openFolder', { kind: 'library' }).catch(() => {}));
$('#btnExportM3u').addEventListener('click', async () => {
  const tracks = filteredLibrary().map((t) => ({ url: t.url, title: t.title, artist: t.artist }));
  if (!tracks.length) { toast('当前筛选下没有歌曲'); return; }
  const ok = await openModal({
    title: '导出 M3U 歌单',
    text: '把当前筛选出的 ' + tracks.length + ' 首歌导出为 M3U8 文件，保存到音乐库的 _导出 目录；文件保持原位置，不移动。',
    confirmLabel: '导出',
  });
  if (!ok) return;
  try {
    const res = await call('exportM3u', { tracks });
    if (res && res.ok) toast('已导出 ' + res.added + ' 首：' + res.path, 'ok');
    else toast('导出失败：' + ((res && res.error) || '未知错误'), 'err');
  } catch (err) { toast('导出失败：' + err.message, 'err'); }
});
$('#btnRefresh').addEventListener('click', loadLibrary);

/* ---------- player ---------- */
const audio = $('#audio');
audio.crossOrigin = 'anonymous';
function setPlayerArt(track) {
  const el = $('#playerArt');
  el.style.setProperty('--h', hueFor((track ? track.title : '') + '|' + (track ? track.artist : '')));
  el.querySelector('.art-initial').textContent = track ? String(track.title || '?').slice(0, 1).toUpperCase() : '♪';
}
function updateNowPlaying(track) {
  $('#playerTitle').textContent = track ? track.title : '未在播放';
  $('#playerArtist').textContent = track ? track.artist + (track.album ? ' · ' + track.album : '') : '从音乐库选一首歌';
  const fmt = (track && track.ext ? track.ext : '').toUpperCase();
  $('#playerFmt').textContent = fmt;
  $('#playerFmt').classList.toggle('hidden', !fmt);
  setPlayerArt(track);
  if (lyricsOpen) { updateLyricsHeader(track); loadLyricsFor(track); }
}
function updatePlayButton() {
  $('#playIcon').setAttribute('href', state.isPlaying ? '#i-pause' : '#i-play');
  $('#btnPlay').setAttribute('aria-label', state.isPlaying ? '暂停' : '播放');
  updateRowPlayIcons();
}
function currentPlayMode() {
  if (state.shuffle) return 'shuffle';
  if (state.repeat === 'one') return 'one';
  if (state.repeat === 'all') return 'all';
  return 'order';
}
const PLAY_MODE_META = {
  order: { icon: '#i-order', label: '顺序播放', tip: '顺序播放：播放到列表末尾后停止' },
  all: { icon: '#i-repeat', label: '列表循环', tip: '列表循环：播放到末尾后从头继续' },
  one: { icon: '#i-repeat', label: '单曲循环', tip: '单曲循环：当前歌曲反复播放' },
  shuffle: { icon: '#i-shuffle', label: '随机播放', tip: '随机播放：随机选择下一首' },
};
function setPlayMode(mode, quiet = false) {
  if (!['order', 'all', 'one', 'shuffle'].includes(mode)) mode = 'order';
  state.shuffle = mode === 'shuffle';
  state.repeat = mode === 'one' ? 'one' : mode === 'all' ? 'all' : 'off';
  updateTransport();
  if (!quiet) savePlayerPrefs();
}
function updateTransport() {
  const mode = currentPlayMode();
  const meta = PLAY_MODE_META[mode];
  $('#playModeIcon').setAttribute('href', meta.icon);
  $('#btnPlayMode').title = meta.tip;
  $('#btnPlayMode').setAttribute('aria-label', '播放模式：' + meta.label);
  $('#btnPlayMode').classList.toggle('mode-active', mode !== 'order');
  $('#playModeOne').classList.toggle('hidden', mode !== 'one');
  const q = state.playQueue.length;
  const queue = $('#playerQueue');
  const hasQueue = q > 0 && state.queueIndex >= 0;
  queue.textContent = hasQueue ? (state.queueIndex + 1) + ' / ' + q : '';
  queue.classList.toggle('hidden', !hasQueue);
  updateQueueBadge();
}

/* ---------- resume position and last session ---------- */
const LAST_PLAYBACK_KEY = 'musicArchiveLastPlayback';
const POSITIONS_KEY = 'musicArchivePositions';
let pendingResume = 0;
let lastPositionSaveAt = 0;
function readPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function getSavedPosition(url) {
  const item = readPositions()[url];
  if (!item || typeof item.position !== 'number') return 0;
  const position = Math.max(0, item.position);
  if (item.duration > 0 && position >= item.duration - 2) return 0;
  return position;
}
function saveTrackPosition(url, position, duration) {
  if (!url || !Number.isFinite(position)) return;
  let pos = Math.max(0, position);
  if (duration > 0 && pos >= duration - 2) pos = 0;
  const positions = readPositions();
  positions[url] = { position: pos, duration: Number(duration) || 0, updated: Date.now() };
  const entries = Object.entries(positions).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0)).slice(0, 300);
  try { localStorage.setItem(POSITIONS_KEY, JSON.stringify(Object.fromEntries(entries))); } catch { }
}
function saveLastPlayback() {
  if (!state.playing) return;
  const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  saveTrackPosition(state.playing.url, position, duration);
  try {
    localStorage.setItem(LAST_PLAYBACK_KEY, JSON.stringify({
      url: state.playing.url,
      position,
      queue: state.playQueue.map((track) => track.url).slice(0, 200),
      queueIndex: state.queueIndex,
      updated: Date.now(),
    }));
  } catch { }
}
function restoreLastPlayback() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_PLAYBACK_KEY) || 'null'); } catch { }
  if (!last || !last.url) return;
  const track = state.library.find((item) => item.url === last.url);
  if (!track) return;
  const queue = Array.isArray(last.queue)
    ? last.queue.map((url) => state.library.find((item) => item.url === url)).filter(Boolean)
    : [];
  state.playQueue = queue.length ? queue : [track];
  const foundIndex = state.playQueue.findIndex((item) => item.url === track.url);
  state.queueIndex = foundIndex >= 0 ? foundIndex : 0;
  state.playing = track;
  const mappedPosition = readPositions()[track.url];
  pendingResume = mappedPosition ? getSavedPosition(track.url) : (Number(last.position) || 0);
  audio.src = track.url;
  audio.volume = Number($('#volume').value) / 100;
  audio.muted = false;
  audio.pause();
  state.isPlaying = false;
  updateNowPlaying(track);
  updateTransport();
  updatePlayButton();
  updateRowPlayIcons();
}


/* ---------- play queue ---------- */
let queueOpen = false;
function updateQueueBadge() {
  const badge = $('#queueBadge');
  const count = state.playQueue.length;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('hidden', count === 0);
  $('#btnQueue').title = count ? '播放队列 · ' + count + ' 首' : '播放队列';
}
function renderQueueDrawer() {
  const list = $('#queueList');
  $('#queueSub').textContent = state.playQueue.length + ' 首';
  $('#queueNow').textContent = state.playing ? '正在播放 · ' + state.playing.title : '未在播放';
  if (!state.playQueue.length) {
    list.innerHTML = '<div class="queue-empty">' + icon('queue') + '<b>队列是空的</b><span>从音乐库播放歌曲后，队列会出现在这里。</span></div>';
    updateQueueBadge();
    return;
  }
  list.innerHTML = state.playQueue.map((track, index) => {
    const active = index === state.queueIndex;
    const ext = track.ext ? String(track.ext).toUpperCase() : '';
    return '<div class="queue-item' + (active ? ' active' : '') + '" data-queue-i="' + index + '" draggable="true" tabindex="0" role="button" style="--h:' + hueFor((track.title || '') + '|' + (track.artist || '')) + '" aria-current="' + (active ? 'true' : 'false') + '" aria-label="播放 ' + esc(track.title || '未知歌曲') + '">' +
      '<span class="queue-item-index">' + (active ? '▶' : String(index + 1).padStart(2, '0')) + '</span>' +
      '<span class="art"><span class="art-initial">' + esc(String(track.title || '?').slice(0, 1).toUpperCase()) + '</span></span>' +
      '<span class="queue-item-copy"><b>' + esc(track.title || '未知歌曲') + '</b><small>' + esc(track.artist || '未知歌手') + '</small></span>' +
      '<span class="queue-item-warn">' + esc(ext) + '</span>' +
      (active ? '' : '<button type="button" class="queue-remove" data-queue-remove="' + index + '" aria-label="从队列移除" title="从队列移除"><svg class="icon"><use href="#i-x"/></svg></button>') +
    '</div>';
  }).join('');
  let queueDragIndex = -1;
  list.querySelectorAll('[data-queue-i]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-queue-remove]')) return;
      const track = state.playQueue[Number(el.dataset.queueI)];
      if (track) { playTrack(track, state.playQueue); renderQueueDrawer(); }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const track = state.playQueue[Number(el.dataset.queueI)];
        if (track) { playTrack(track, state.playQueue); renderQueueDrawer(); }
      }
    });
    el.addEventListener('dragstart', (e) => {
      queueDragIndex = Number(el.dataset.queueI);
      el.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(queueDragIndex)); }
    });
    el.addEventListener('dragend', () => { queueDragIndex = -1; list.querySelectorAll('.queue-item').forEach((x) => x.classList.remove('dragging', 'drag-over')); });
    el.addEventListener('dragover', (e) => { e.preventDefault(); if (!el.classList.contains('dragging')) el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const to = Number(el.dataset.queueI);
      const from = queueDragIndex;
      el.classList.remove('drag-over');
      if (!Number.isInteger(from) || from < 0 || from === to) return;
      const currentUrl = state.playing && state.playing.url;
      const [moved] = state.playQueue.splice(from, 1);
      state.playQueue.splice(to, 0, moved);
      state.queueIndex = state.playQueue.findIndex((x) => x.url === currentUrl);
      if (queueOpen) renderQueueDrawer();
      updateTransport();
      toast('队列顺序已调整', 'ok');
    });
  });
  list.querySelectorAll('[data-queue-remove]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeQueueItem(Number(btn.dataset.queueRemove));
    });
  });
  updateQueueBadge();
  requestAnimationFrame(() => {
    const active = list.querySelector('.queue-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  });
}
function removeQueueItem(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.playQueue.length) return;
  const track = state.playQueue[index];
  if (state.playing && track.url === state.playing.url) { toast('正在播放的歌曲不能直接移除'); return; }
  state.playQueue.splice(index, 1);
  if (state.queueIndex > index) state.queueIndex -= 1;
  if (!state.playQueue.length) state.queueIndex = -1;
  renderQueueDrawer();
  updateTransport();
  toast('已从队列移除', 'ok');
}
function openQueueDrawer() {
  if (queueOpen) return;
  if (lyricsOpen) closeLyricsView();
  if ($('#fxDrawer').classList.contains('open')) closeFx();
  queueOpen = true;
  $('#queueDrawer').classList.add('open');
  $('#queueDrawer').setAttribute('aria-hidden', 'false');
  $('#queueScrim').classList.remove('hidden');
  $('#btnQueue').setAttribute('aria-expanded', 'true');
  renderQueueDrawer();
  setTimeout(() => $('#queueClose').focus(), 120);
}
function closeQueueDrawer() {
  if (!queueOpen) return;
  queueOpen = false;
  $('#queueDrawer').classList.remove('open');
  $('#queueDrawer').setAttribute('aria-hidden', 'true');
  $('#queueScrim').classList.add('hidden');
  $('#btnQueue').setAttribute('aria-expanded', 'false');
  $('#btnQueue').focus();
}
$('#btnQueue').addEventListener('click', () => { queueOpen ? closeQueueDrawer() : openQueueDrawer(); });
$('#queueClose').addEventListener('click', closeQueueDrawer);
$('#queueScrim').addEventListener('click', closeQueueDrawer);
$('#queueClear').addEventListener('click', () => {
  state.playQueue = [];
  state.queueIndex = -1;
  renderQueueDrawer();
  updateTransport();
  toast('播放队列已清空', 'ok');
  $('#queueClose').focus();
});

/* ---------- track context menu ---------- */
let trackMenuTrack = null;
let trackMenuList = null;
function openTrackMenu(track, list, x, y) {
  if (!track) return;
  trackMenuTrack = track;
  trackMenuList = list || null;
  const menu = $('#trackMenu');
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(x, window.innerWidth - width - 10);
  const top = Math.min(y, window.innerHeight - height - 10);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
  menu.querySelector('[data-track-action="play"]').focus();
}
function closeTrackMenu() {
  $('#trackMenu').classList.add('hidden');
  trackMenuTrack = null;
  trackMenuList = null;
}
function ensureCurrentQueue() {
  if (!state.playing) return false;
  if (!state.playQueue.length) {
    state.playQueue = [state.playing];
    state.queueIndex = 0;
  }
  return true;
}
function playNextTrack(track, list) {
  if (!track) return;
  if (!state.playing) { playTrack(track, list); return; }
  ensureCurrentQueue();
  if (track.url === state.playing.url) { toast('这首歌正在播放'); return; }
  const queue = state.playQueue.filter((x) => x.url !== track.url);
  const current = queue.findIndex((x) => x.url === state.playing.url);
  if (current >= 0) queue.splice(current + 1, 0, track);
  else queue.push(track);
  state.playQueue = queue;
  state.queueIndex = queue.findIndex((x) => x.url === state.playing.url);
  updateTransport();
  if (queueOpen) renderQueueDrawer();
  toast('已设为下一首播放', 'ok');
}
function addTrackToQueue(track, list) {
  if (!track) return;
  if (!state.playing) { playTrack(track, list); return; }
  ensureCurrentQueue();
  if (state.playQueue.some((x) => x.url === track.url)) { toast('这首歌已经在队列里'); return; }
  state.playQueue.push(track);
  updateTransport();
  if (queueOpen) renderQueueDrawer();
  toast('已加入播放队列', 'ok');
}
$('#trackMenu').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-track-action]');
  if (!button || !trackMenuTrack) return;
  const track = trackMenuTrack;
  const list = trackMenuList;
  const action = button.dataset.trackAction;
  closeTrackMenu();
  if (action === 'play') playTrack(track, list);
  else if (action === 'next') playNextTrack(track, list);
  else if (action === 'queue') addTrackToQueue(track, list);
  else if (action === 'copy') {
    try { await navigator.clipboard.writeText((track.title || '') + ' - ' + (track.artist || '')); toast('已复制歌曲信息', 'ok'); }
    catch { toast('复制失败', 'err'); }
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('#trackMenu')) closeTrackMenu(); });
document.addEventListener('scroll', closeTrackMenu, true);
window.addEventListener('resize', closeTrackMenu);

/* ---------- sleep timer ---------- */
let sleepTimer = null;
let sleepMinutes = 0;
function openSleepMenu() {
  closeTrackMenu();
  const menu = $('#sleepMenu');
  menu.classList.remove('hidden');
  const rect = $('#btnSleep').getBoundingClientRect();
  menu.style.left = '0px';
  menu.style.top = '0px';
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 10)) + 'px';
  menu.style.top = Math.max(8, rect.top - height - 8) + 'px';
  menu.querySelectorAll('[data-sleep]').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.sleep) === sleepMinutes));
  $('#btnSleep').setAttribute('aria-expanded', 'true');
  menu.querySelector('[data-sleep="30"]').focus();
}
function closeSleepMenu() {
  $('#sleepMenu').classList.add('hidden');
  $('#btnSleep').setAttribute('aria-expanded', 'false');
}
function setSleepTimer(minutes) {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepMinutes = Number(minutes) || 0;
  $('#btnSleep').classList.toggle('sleep-active', sleepMinutes > 0);
  if (!sleepMinutes) {
    $('#btnSleep').title = '睡眠定时';
    toast('睡眠定时已关闭', 'ok');
    closeSleepMenu();
    return;
  }
  sleepTimer = setTimeout(() => {
    if (!audio.paused) audio.pause();
    sleepMinutes = 0;
    sleepTimer = null;
    $('#btnSleep').classList.remove('sleep-active');
    $('#btnSleep').title = '睡眠定时';
    toast('睡眠定时结束，播放已暂停', 'ok');
  }, sleepMinutes * 60 * 1000);
  $('#btnSleep').title = '睡眠定时 · ' + sleepMinutes + ' 分钟';
  toast(sleepMinutes + ' 分钟后暂停播放', 'ok');
  closeSleepMenu();
}
$('#btnSleep').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('#sleepMenu').classList.contains('hidden')) openSleepMenu();
  else closeSleepMenu();
});
$('#sleepMenu').addEventListener('click', (e) => {
  const button = e.target.closest('[data-sleep]');
  if (button) setSleepTimer(button.dataset.sleep);
});
document.addEventListener('click', (e) => { if (!e.target.closest('#sleepMenu') && !e.target.closest('#btnSleep')) closeSleepMenu(); });

function ensureQueue(track, list) {
  let q = (list && list.length ? list.slice() : filteredLibrary());
  if (!q.some((x) => x.url === track.url)) q.unshift(track);
  state.playQueue = q;
  state.queueIndex = q.findIndex((x) => x.url === track.url);
  if (state.queueIndex < 0) state.queueIndex = 0;
}
function playTrack(track, list) {
  if (!track) return;
  if (state.playing) saveLastPlayback();
  ensureQueue(track, list);
  state.playing = track;
  pendingResume = getSavedPosition(track.url);
  recordRecent(track);
  state.isPlaying = false;
  audio.src = track.url;
  audio.volume = Number($('#volume').value) / 100;
  audio.muted = false;
  updateNowPlaying(track);
  updateTransport();
  updatePlayButton();
  if (queueOpen) renderQueueDrawer();
  audio.play().catch((err) => toast('无法播放：' + err.message, 'err'));
  updateRowPlayIcons();
}
function togglePlay() {
  if (!state.playing) { const first = filteredLibrary()[0]; if (first) playTrack(first); return; }
  if (audio.paused) audio.play().catch((err) => toast('无法播放：' + err.message, 'err'));
  else audio.pause();
}
function nextTrack(auto = false) {
  if (!state.playQueue.length) return;
  if (state.shuffle) {
    if (state.playQueue.length === 1) { playTrack(state.playQueue[0], state.playQueue); return; }
    let i = state.queueIndex;
    while (i === state.queueIndex) i = Math.floor(Math.random() * state.playQueue.length);
    playTrack(state.playQueue[i], state.playQueue);
    return;
  }
  let i = state.queueIndex + 1;
  if (i >= state.playQueue.length) {
    if (state.repeat === 'all') i = 0;
    else { audio.pause(); audio.currentTime = 0; state.isPlaying = false; updatePlayButton(); return; }
  }
  playTrack(state.playQueue[i], state.playQueue);
}
function prevTrack() {
  if (!state.playQueue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let i = state.queueIndex - 1;
  if (i < 0) i = state.repeat === 'all' ? state.playQueue.length - 1 : 0;
  playTrack(state.playQueue[i], state.playQueue);
}

/* ---------- local AI control bridge ---------- */
function aiTrack(track) {
  if (!track) return null;
  return {
    id: track.url,
    url: track.url,
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    duration: track.duration || 0,
    format: track.ext || '',
  };
}
function aiStatus() {
  return {
    ok: true,
    playing: !!state.playing,
    isPlaying: !audio.paused && !!state.playing,
    track: aiTrack(state.playing),
    position: Number(audio.currentTime) || 0,
    duration: Number(audio.duration) || 0,
    volume: Math.round(audio.volume * 100),
    muted: !!audio.muted,
    queueIndex: state.queueIndex,
    queueLength: state.playQueue.length,
  };
}
function findAiTrack(args) {
  if (!args) return null;
  if (args.url) {
    const byUrl = state.library.find((track) => track.url === args.url);
    if (byUrl) return byUrl;
  }
  const query = String(args.query || '').trim().toLowerCase();
  if (!query) return null;
  return state.library.find((track) =>
    String(track.title || '').toLowerCase() === query ||
    String(track.artist || '').toLowerCase() === query) ||
    state.library.find((track) =>
      String(track.title || '').toLowerCase().includes(query) ||
      String(track.artist || '').toLowerCase().includes(query));
}
async function handleAiCommand(action, args = {}) {
  switch (action) {
    case 'status':
      return aiStatus();
    case 'librarySearch': {
      const query = String(args.query || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const matches = (query
        ? state.library.filter((track) => [track.title, track.artist, track.album].some((value) => String(value || '').toLowerCase().includes(query)))
        : state.library).slice(0, limit);
      return { ok: true, songs: matches.map(aiTrack), count: matches.length };
    }
    case 'play': {
      const track = findAiTrack(args);
      if (!track) throw new Error('没有找到匹配的本地歌曲');
      playTrack(track, filteredLibrary());
      return aiStatus();
    }
    case 'pause':
      audio.pause();
      return aiStatus();
    case 'resume':
      if (state.playing) await audio.play().catch((error) => { throw new Error(error.message); });
      return aiStatus();
    case 'next':
      nextTrack();
      return aiStatus();
    case 'previous':
      prevTrack();
      return aiStatus();
    case 'seek': {
      const seconds = Math.max(0, Number(args.seconds) || 0);
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error('当前歌曲还没有可跳转的时长');
      audio.currentTime = Math.min(seconds, Math.max(0, audio.duration - 0.2));
      return aiStatus();
    }
    case 'volume': {
      const volume = Math.max(0, Math.min(100, Number(args.volume) || 0));
      $('#volume').value = String(volume);
      audio.volume = volume / 100;
      audio.muted = false;
      savePlayerPrefs();
      updateMute();
      return aiStatus();
    }
    case 'queueList':
      return {
        ok: true,
        queueIndex: state.queueIndex,
        queueLength: state.playQueue.length,
        queue: state.playQueue.slice(0, 200).map(aiTrack),
      };
    default:
      throw new Error('未知 AI 控制动作：' + action);
  }
}
audio.addEventListener('play', () => { state.isPlaying = true; updatePlayButton(); });
audio.addEventListener('pause', () => { state.isPlaying = false; updatePlayButton(); saveLastPlayback(); });
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0;
  const seek = $('#seek');
  $('#curTime').textContent = formatTime(audio.currentTime);
  $('#durTime').textContent = formatTime(d);
  if (d > 0) {
    const progress = Math.max(0, Math.min(1, audio.currentTime / d));
    const percent = (progress * 100).toFixed(2) + '%';
    seek.value = String(Math.floor(progress * 1000));
    seek.style.setProperty('--progress', percent);
    if (!seekHovering) seek.style.setProperty('--hover', percent);
    seek.title = formatTime(audio.currentTime) + ' / ' + formatTime(d);
    $('#playerProgress').dataset.time = formatTime(audio.currentTime) + ' / ' + formatTime(d);
  }
  syncLyricsProgress(audio.currentTime);
  const now = Date.now();
  if (state.playing && !audio.paused && now - lastPositionSaveAt > 2000) {
    lastPositionSaveAt = now;
    saveLastPlayback();
  }
});
audio.addEventListener('loadedmetadata', () => {
  $('#durTime').textContent = formatTime(audio.duration || 0);
  if (pendingResume > 1) {
    const duration = audio.duration || 0;
    audio.currentTime = duration > 0 ? Math.min(pendingResume, Math.max(0, duration - 1)) : pendingResume;
    pendingResume = 0;
    audio.dispatchEvent(new Event('timeupdate'));
  }
});
audio.addEventListener('ended', () => {
  if (state.playing) { saveTrackPosition(state.playing.url, 0, audio.duration || 0); saveLastPlayback(); }
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  nextTrack(true);
});
audio.addEventListener('error', () => toast('这个文件无法在客户端内播放（编码或文件可能不完整）', 'err'));
window.addEventListener('beforeunload', saveLastPlayback);
window.addEventListener('pagehide', saveLastPlayback);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveLastPlayback(); });
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnNext').addEventListener('click', () => nextTrack(false));
$('#btnPrev').addEventListener('click', prevTrack);

/* ---------- immersive lyrics ---------- */
let lyricsOpen = false;
let lyricsLines = [];
let lyricsActive = -1;
let lyricsToken = 0;
let lyricsAutoScrolling = false;
let lyricsOffset = 0;
let lyricsKey = '';
let lyricsRaf = 0;
const lyricsCache = new Map();
const LYRIC_OFFSET_KEY = 'musicArchiveLyricOffsets';
const LYRIC_CREDIT = /^(作词|作曲|编曲|制作人?|混音|母带|出品|监制|录音|吉他|贝斯|鼓|和声|和音|OP|SP|发行|策划|统筹|艺人|词|曲|词曲|制作)\s*[:：]/;

function loadLyricOffset(track) {
  lyricsKey = track ? (track.title || '') + '|' + (track.artist || '') : '';
  lyricsOffset = 0;
  try {
    const map = JSON.parse(localStorage.getItem(LYRIC_OFFSET_KEY) || '{}');
    const value = Number(map[lyricsKey]);
    if (Number.isFinite(value)) lyricsOffset = Math.max(-5, Math.min(5, value));
  } catch { }
  updateLyricOffsetDisplay();
}
function saveLyricOffset() {
  try {
    const map = JSON.parse(localStorage.getItem(LYRIC_OFFSET_KEY) || '{}');
    if (!lyricsOffset) delete map[lyricsKey];
    else map[lyricsKey] = Number(lyricsOffset.toFixed(2));
    localStorage.setItem(LYRIC_OFFSET_KEY, JSON.stringify(map));
  } catch { }
}
function updateLyricOffsetDisplay() {
  const value = Math.abs(lyricsOffset) < 0.01 ? '0.0s' : (lyricsOffset > 0 ? '+' : '') + lyricsOffset.toFixed(1) + 's';
  $('#lyricsOffsetValue').textContent = value;
}
function changeLyricOffset(delta) {
  lyricsOffset = Math.max(-5, Math.min(5, Math.round((lyricsOffset + delta) * 10) / 10));
  updateLyricOffsetDisplay();
  saveLyricOffset();
  syncLyricsProgress(audio.currentTime);
}
function resetLyricOffset() {
  lyricsOffset = 0;
  updateLyricOffsetDisplay();
  saveLyricOffset();
  syncLyricsProgress(audio.currentTime);
}
function startLyricsRaf() {
  stopLyricsRaf();
  const tick = () => {
    if (!lyricsOpen) return;
    syncLyricsProgress(audio.currentTime);
    lyricsRaf = requestAnimationFrame(tick);
  };
  lyricsRaf = requestAnimationFrame(tick);
}
function stopLyricsRaf() {
  if (lyricsRaf) cancelAnimationFrame(lyricsRaf);
  lyricsRaf = 0;
}

function openLyricsView() {
  if (!state.playing) { toast('先播放一首歌，再查看歌词', 'ok'); return; }
  if (lyricsOpen) return;
  lyricsOpen = true;
  const view = $('#lyricsView');
  view.classList.add('open');
  view.setAttribute('aria-hidden', 'false');
  $('#playerArt').classList.add('is-open');
  document.body.classList.add('lyrics-open');
  updateLyricsHeader(state.playing);
  loadLyricOffset(state.playing);
  loadLyricsFor(state.playing);
  startLyricsRaf();
  setTimeout(() => $('#btnLyricsBack').focus(), 120);
}
function closeLyricsView() {
  if (!lyricsOpen) return;
  lyricsOpen = false;
  stopLyricsRaf();
  const view = $('#lyricsView');
  view.classList.remove('open');
  view.setAttribute('aria-hidden', 'true');
  $('#playerArt').classList.remove('is-open');
  document.body.classList.remove('lyrics-open');
  $('#playerArt').focus();
}
function toggleLyricsView() { lyricsOpen ? closeLyricsView() : openLyricsView(); }

function updateLyricsHeader(track) {
  const title = track ? (track.title || '未知歌曲') : '未在播放';
  const artist = track ? (track.artist || '未知歌手') : '从音乐库选一首歌';
  $('#lyricsTrackTitle').textContent = title;
  $('#lyricsTrackArtist').textContent = track && track.album ? artist + ' · ' + track.album : artist;
  $('#lyricsInitial').textContent = String(title || '♪').slice(0, 1).toUpperCase();
  $('#lyricsBadge').textContent = track && track.ext ? String(track.ext).toUpperCase() : '';
  $('#lyricsBadge').classList.toggle('hidden', !(track && track.ext));
  const cover = $('#lyricsCover');
  cover.style.setProperty('--h', hueFor(title + '|' + artist));
  cover.style.backgroundImage = '';
  cover.classList.remove('has-image');
  $('#lyricsBg').style.backgroundImage = '';
}

function parseLyrics(lrc, tlyric) {
  const pick = (text) => {
    const map = new Map();
    for (const raw of String(text || '').split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      if (!stamps.length) continue;
      const body = raw.replace(/\[[^\]]*\]/g, '').trim();
      if (!body || LYRIC_CREDIT.test(body)) continue;
      for (const m of stamps) {
        const ms = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
        const time = Number(m[1]) * 60 + Number(m[2]) + ms / 1000;
        if (!map.has(time) || !map.get(time)) map.set(time, body);
      }
    }
    return map;
  };
  const origin = pick(lrc);
  const translated = pick(tlyric);
  const lines = [...origin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, text]) => ({ time, text, translation: translated.get(time) || '' }));
  return lines;
}

function showLyricsMessage(message, detail = '') {
  lyricsLines = [];
  lyricsActive = -1;
  $('#lyricsList').innerHTML = '<p class="lyrics-empty">' + esc(message) + (detail ? '<br><span>' + esc(detail) + '</span>' : '') + '</p>';
  $('#lyricsState').textContent = detail || message;
  $('#lyricsScroll').scrollTop = 0;
}
function showLyricsLoading() {
  $('#lyricsList').innerHTML = '<div class="lyrics-loading" aria-label="歌词加载中"><i></i><i></i><i></i></div>';
  $('#lyricsState').textContent = '正在匹配歌词…';
  $('#lyricsScroll').scrollTop = 0;
}
async function loadLyricsFor(track) {
  if (!lyricsOpen) return;
  if (!track) { showLyricsMessage('未在播放', '选择一首歌后这里会显示同步歌词'); return; }
  loadLyricOffset(track);
  const key = (track.title || '') + '|' + (track.artist || '') + '|' + Math.round(audio.duration || 0);
  const token = ++lyricsToken;
  showLyricsLoading();
  const cached = lyricsCache.get(key);
  let result = cached;
  if (!result) {
    try { result = await call('getLyrics', { title: track.title || '', artist: track.artist || '', duration: String(audio.duration || 0), url: track.url || '' }); }
    catch (err) { result = { ok: false, error: err.message }; }
    lyricsCache.set(key, result);
  }
  if (token !== lyricsToken || !lyricsOpen) return;
  if (!result || !result.ok) {
    showLyricsMessage('暂无歌词', (result && result.error) ? result.error : '这首歌暂时没有匹配到歌词');
    return;
  }
  if (result.cover) {
    const url = String(result.cover).replace(/^http:/, 'https:').replace(/"/g, '%22');
    $('#lyricsCover').style.backgroundImage = 'url("' + url + '")';
    $('#lyricsCover').classList.add('has-image');
    $('#lyricsBg').style.backgroundImage = 'url("' + url + '")';
  }
  lyricsLines = parseLyrics(result.lrc, result.tlyric);
  lyricsActive = -1;
  if (!lyricsLines.length) { showLyricsMessage('暂无歌词', '这首歌暂时没有可用歌词'); return; }
  $('#lyricsList').innerHTML = lyricsLines.map((line, i) => {
    const tr = line.translation ? '<span class="lyric-trans">' + esc(line.translation) + '</span>' : '';
    return '<button class="lyric-line" data-lyric-i="' + i + '" role="listitem" style="--lyric-i:' + i + '"><span class="lyric-orig">' + esc(line.text) + '</span>' + tr + '</button>';
  }).join('');
  $('#lyricsState').textContent = (result.source === 'local' ? '本地歌词' : result.source === 'lrclib' ? '歌词来自 LRCLIB' : '歌词来自网易云') +
    (result.local || result.saved ? ' · 已保存到歌曲目录' : ' · 按播放进度同步');
  $$('#lyricsList .lyric-line').forEach((el) => {
    el.addEventListener('click', () => {
      const line = lyricsLines[Number(el.dataset.lyricI)];
      if (!line) return;
      audio.currentTime = Math.max(0, line.time - lyricsOffset);
      if (audio.paused) audio.play().catch(() => {});
      syncLyricsProgress(audio.currentTime);
    });
  });
  syncLyricsProgress(audio.currentTime);
}

function syncLyricsProgress(time) {
  if (!lyricsOpen || !lyricsLines.length) return;
  const effective = time + lyricsOffset;
  let index = -1;
  for (let i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].time <= effective + 0.06) index = i;
    else break;
  }
  if (index === lyricsActive) return;
  lyricsActive = index;
  $$('#lyricsList .lyric-line').forEach((el, i) => el.classList.toggle('active', i === index));
  const el = index >= 0 ? $('#lyricsList .lyric-line[data-lyric-i="' + index + '"]') : null;
  if (!el) return;
  const scroll = $('#lyricsScroll');
  lyricsAutoScrolling = true;
  scroll.scrollTo({ top: Math.max(0, el.offsetTop - scroll.clientHeight / 2 + el.offsetHeight / 2), behavior: 'smooth' });
  setTimeout(() => { lyricsAutoScrolling = false; }, 420);
}

$('#playerArt').addEventListener('click', toggleLyricsView);
$('#playerArt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLyricsView(); }
});
$('#btnLyricsBack').addEventListener('click', closeLyricsView);
$('#lyricsCoverWrap').addEventListener('click', closeLyricsView);
$('#lyricsOffsetMinus').addEventListener('click', () => changeLyricOffset(-0.2));
$('#lyricsOffsetPlus').addEventListener('click', () => changeLyricOffset(0.2));
$('#lyricsOffsetValue').addEventListener('click', resetLyricOffset);

$('#btnPlayMode').addEventListener('click', () => {
  const modes = ['order', 'all', 'one', 'shuffle'];
  const next = modes[(modes.indexOf(currentPlayMode()) + 1) % modes.length];
  setPlayMode(next);
});
$('#seek').addEventListener('input', (e) => {
  if (!audio.duration) return;
  audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
  const progress = Math.max(0, Math.min(1, Number(e.target.value) / 1000));
  e.target.style.setProperty('--progress', (progress * 100).toFixed(2) + '%');
  if (!seekHovering) e.target.style.setProperty('--hover', (progress * 100).toFixed(2) + '%');
});
const seekInput = $('#seek');
const seekProgress = $('#playerProgress');
const seekTip = $('#seekHoverTip');
function updateSeekHover(event) {
  const duration = audio.duration || 0;
  if (!duration) { seekTip.classList.remove('show'); return; }
  const rect = seekInput.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const ratio = rect.width ? x / rect.width : 0;
  seekHovering = true;
  seekInput.style.setProperty('--hover', (ratio * 100).toFixed(2) + '%');
  seekTip.textContent = formatTime(ratio * duration);
  seekTip.style.left = Math.max(24, Math.min(rect.width - 24, x)) + 'px';
  seekTip.classList.add('show');
}
seekProgress.addEventListener('pointermove', updateSeekHover);
document.addEventListener('pointermove', (event) => {
  const rect = seekProgress.getBoundingClientRect();
  const nearRail = event.clientY >= rect.top - 6 && event.clientY <= rect.bottom + 6 && event.clientX >= rect.left - 2 && event.clientX <= rect.right + 2;
  if (nearRail) updateSeekHover(event);
  else if (seekHovering && !event.buttons) {
    seekHovering = false;
    seekTip.classList.remove('show');
    seekProgress.classList.remove('is-scrubbing');
    const d = audio.duration || 0;
    if (d > 0) seekInput.style.setProperty('--hover', ((audio.currentTime / d) * 100).toFixed(2) + '%');
  }
});
seekProgress.addEventListener('pointerleave', () => {
  seekHovering = false;
  seekTip.classList.remove('show');
  seekProgress.classList.remove('is-scrubbing');
  const d = audio.duration || 0;
  if (d > 0) seekInput.style.setProperty('--hover', ((audio.currentTime / d) * 100).toFixed(2) + '%');
});
seekProgress.addEventListener('pointerdown', () => {
  seekProgress.classList.add('is-scrubbing');
  seekHovering = true;
});
window.addEventListener('pointerup', () => {
  seekProgress.classList.remove('is-scrubbing');
  seekHovering = false;
  const d = audio.duration || 0;
  if (d > 0) seekInput.style.setProperty('--hover', ((audio.currentTime / d) * 100).toFixed(2) + '%');
});
$('#volume').addEventListener('input', (e) => { audio.volume = Number(e.target.value) / 100; audio.muted = false; updateMute(); savePlayerPrefs(); });
function updateMute() {
  $('#muteIcon').setAttribute('href', audio.muted || audio.volume === 0 ? '#i-muted' : '#i-volume');
  $('#btnMute').setAttribute('aria-label', audio.muted || audio.volume === 0 ? '取消静音' : '静音');
}
$('#btnMute').addEventListener('click', () => { audio.muted = !audio.muted; updateMute(); savePlayerPrefs(); });

/* ---------- audio effects (Web Audio, same-origin local audio) ---------- */
const FX_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const FX_PRESETS = {
  flat: { name: '原声', eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bass: 0, treble: 0, width: 100 },
  vocal: { name: '清澈人声', eq: [-2, -1, 0, 1, 3, 4, 3, 1, 0, -1], bass: -1, treble: 2, width: 100 },
  bass: { name: '超重低音', eq: [6, 5, 4, 2, 0, -1, -1, 0, 0, 0], bass: 4, treble: -1, width: 100 },
  live: { name: '现场', eq: [1, 2, 1, 0, 1, 2, 3, 4, 3, 2], bass: 1, treble: 1, width: 130 },
  space: { name: '3D 环绕', eq: [0, 1, 0, 0, 1, 0, 1, 2, 2, 1], bass: 0, treble: 0, width: 150 },
};
const fxGraph = { ctx: null, source: null, dry: null, wet: null, pre: null, bands: [], bass: null, treble: null, midOutL: null, midOutR: null, sideOutL: null, sideOutR: null, limiter: null, analyser: null, failed: false };
let fxMeterRaf = 0;
let fxMeterData = null;

function saveFx() {
  try { localStorage.setItem('musicArchiveFx', JSON.stringify(state.fx)); } catch { }
}
function loadFx() {
  try {
    const raw = localStorage.getItem('musicArchiveFx');
    if (!raw) return;
    const v = JSON.parse(raw);
    if (typeof v.enabled === 'boolean') state.fx.enabled = v.enabled;
    if (typeof v.bypass === 'boolean') state.fx.bypass = v.bypass;
    if (typeof v.preset === 'string') state.fx.preset = v.preset;
    if (typeof v.intensity === 'number') state.fx.intensity = Math.min(1, Math.max(0, v.intensity));
    if (Array.isArray(v.eq) && v.eq.length === 10) state.fx.eq = v.eq.map((n) => Math.max(-10, Math.min(10, Number(n) || 0)));
    if (typeof v.bass === 'number') state.fx.bass = Math.max(-10, Math.min(10, v.bass));
    if (typeof v.treble === 'number') state.fx.treble = Math.max(-10, Math.min(10, v.treble));
    if (typeof v.width === 'number') state.fx.width = Math.max(0, Math.min(150, v.width));
  } catch { }
}
function ensureFxGraph() {
  if (fxGraph.ctx) return true;
  if (fxGraph.failed) return false;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('当前 WebView 不支持 Web Audio');
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(audio);
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const pre = ctx.createGain();
    dry.gain.value = 1;
    wet.gain.value = 0;
    source.connect(dry);
    dry.connect(ctx.destination);
    source.connect(pre);
    let last = pre;
    const bands = FX_BANDS.map((freq) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.05;
      f.gain.value = 0;
      last.connect(f);
      last = f;
      return f;
    });
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 110;
    const treble = ctx.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 10000;
    last.connect(bass);
    bass.connect(treble);

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    treble.connect(splitter);
    const midL = ctx.createGain(); midL.gain.value = .5;
    const midR = ctx.createGain(); midR.gain.value = .5;
    const sideL = ctx.createGain(); sideL.gain.value = .5;
    const sideR = ctx.createGain(); sideR.gain.value = -.5;
    splitter.connect(midL, 0);
    splitter.connect(midR, 1);
    splitter.connect(sideL, 0);
    splitter.connect(sideR, 1);
    const mid = ctx.createGain();
    const side = ctx.createGain();
    midL.connect(mid); midR.connect(mid);
    sideL.connect(side); sideR.connect(side);
    const midOutL = ctx.createGain();
    const midOutR = ctx.createGain();
    const sideOutL = ctx.createGain();
    const sideOutR = ctx.createGain();
    mid.connect(midOutL); mid.connect(midOutR);
    side.connect(sideOutL); side.connect(sideOutR);
    midOutL.connect(merger, 0, 0); sideOutL.connect(merger, 0, 0);
    midOutR.connect(merger, 0, 1); sideOutR.connect(merger, 0, 1);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = .003;
    limiter.release.value = .25;
    merger.connect(limiter);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    limiter.connect(wet);
    wet.connect(analyser);
    analyser.connect(ctx.destination);
    fxMeterData = new Uint8Array(analyser.fftSize);

    fxGraph.ctx = ctx;
    fxGraph.source = source;
    fxGraph.dry = dry;
    fxGraph.wet = wet;
    fxGraph.pre = pre;
    fxGraph.bands = bands;
    fxGraph.bass = bass;
    fxGraph.treble = treble;
    fxGraph.midOutL = midOutL;
    fxGraph.midOutR = midOutR;
    fxGraph.sideOutL = sideOutL;
    fxGraph.sideOutR = sideOutR;
    fxGraph.limiter = limiter;
    fxGraph.analyser = analyser;
    applyFx();
    return true;
  } catch (err) {
    fxGraph.failed = true;
    toast('音效不可用：' + err.message, 'err');
    return false;
  }
}
function applyFx() {
  if (!fxGraph.ctx) return;
  const ctx = fxGraph.ctx;
  const now = ctx.currentTime;
  const on = state.fx.enabled && !state.fx.bypass;
  const k = state.fx.intensity;
  const ramp = (param, value) => param.setTargetAtTime(value, now, .035);
  ramp(fxGraph.dry.gain, on ? 0 : 1);
  ramp(fxGraph.wet.gain, on ? 1 : 0);
  ramp(fxGraph.pre.gain, .88);
  fxGraph.bands.forEach((b, i) => ramp(b.gain, state.fx.eq[i] * k));
  ramp(fxGraph.bass.gain, state.fx.bass * k);
  ramp(fxGraph.treble.gain, state.fx.treble * k);
  const width = 1 + (state.fx.width / 100 - 1) * k;
  ramp(fxGraph.sideOutL.gain, width);
  ramp(fxGraph.sideOutR.gain, -width);
  if (state.fx.enabled && ctx.state === 'suspended') ctx.resume().catch(() => { });
}
function renderFx() {
  $('#fxEnabled').checked = !!state.fx.enabled;
  $('#fxBypass').classList.toggle('active', !!state.fx.bypass);
  $('.fx-power').classList.toggle('on', !!state.fx.enabled);
  $('#fxState').textContent = state.fx.bypass ? '当前：旁通中' : state.fx.enabled ? '当前：' + (FX_PRESETS[state.fx.preset]?.name || '自定义') : '当前：未启用';
  $('#fxSub').textContent = state.fx.enabled ? '本地播放实时处理，可随时旁通对比。' : '选择预设或开启开关后生效。';
  $('#btnFx').classList.toggle('active', !!state.fx.enabled);
  $('#btnFx').setAttribute('aria-pressed', state.fx.enabled ? 'true' : 'false');
  $('#fxIntensity').value = String(Math.round(state.fx.intensity * 100));
  $('#fxIntensityVal').textContent = Math.round(state.fx.intensity * 100) + '%';
  $('#fxWidth').value = String(Math.round(state.fx.width));
  $('#fxWidthVal').textContent = Math.round(state.fx.width) + '%';
  $('#fxBass').value = String(state.fx.bass);
  $('#fxTreble').value = String(state.fx.treble);
  $('#fxEq').querySelectorAll('[data-eq]').forEach((input) => {
    const value = state.fx.eq[Number(input.dataset.eq)] || 0;
    input.value = String(value);
    const out = input.parentElement.querySelector('output');
    if (out) out.textContent = value > 0 ? '+' + value : String(value);
  });
  $$('.fx-preset').forEach((b) => {
    const active = state.fx.preset === b.dataset.preset;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}
function activateFx() {
  state.fx.enabled = true;
  state.fx.bypass = false;
  ensureFxGraph();
}
function startFxMeter() {
  if (fxMeterRaf || !fxGraph.analyser) return;
  const tick = () => {
    if (!$('#fxDrawer').classList.contains('open') || !fxGraph.analyser) { fxMeterRaf = 0; return; }
    fxGraph.analyser.getByteTimeDomainData(fxMeterData);
    let sum = 0;
    for (let i = 0; i < fxMeterData.length; i++) { const v = (fxMeterData[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / fxMeterData.length);
    const level = Math.min(1, rms * 5.5);
    $('#fxMeterBar').style.width = Math.round(level * 100) + '%';
    fxMeterRaf = requestAnimationFrame(tick);
  };
  tick();
}
function stopFxMeter() {
  if (fxMeterRaf) cancelAnimationFrame(fxMeterRaf);
  fxMeterRaf = 0;
  $('#fxMeterBar').style.width = '0';
}
function selectFxPreset(id) {
  const p = FX_PRESETS[id];
  if (!p) return;
  const wasEnabled = state.fx.enabled;
  state.fx.preset = id;
  state.fx.eq = p.eq.slice();
  state.fx.bass = p.bass;
  state.fx.treble = p.treble;
  state.fx.width = p.width;
  activateFx();
  saveFx();
  applyFx();
  renderFx();
  if (!wasEnabled) toast('音效已开启：' + p.name, 'ok');
}
function buildFxUi() {
  $('#fxPresets').innerHTML = Object.entries(FX_PRESETS).map(([id, p]) =>
    '<button class="fx-preset" data-preset="' + id + '" aria-pressed="false"><strong>' + p.name + '</strong><span>' + (id === 'space' ? '空间感' : id === 'bass' ? '低频' : id === 'vocal' ? '人声' : id === 'live' ? '声场' : '无染色') + '</span></button>').join('');
  $('#fxEq').innerHTML = FX_BANDS.map((f, i) =>
    '<label class="eq-band"><span>' + (f >= 1000 ? (f / 1000) + 'k' : f) + '</span><input type="range" min="-10" max="10" step="1" value="0" data-eq="' + i + '" aria-label="' + f + ' Hz"><output>0</output></label>').join('');
  $('#fxPresets').querySelectorAll('.fx-preset').forEach((b) => b.addEventListener('click', () => selectFxPreset(b.dataset.preset)));
  $('#fxEq').addEventListener('input', (e) => {
    const input = e.target.closest('[data-eq]');
    if (!input) return;
    const value = Number(input.value);
    state.fx.eq[Number(input.dataset.eq)] = value;
    state.fx.preset = 'custom';
    activateFx();
    const out = input.parentElement.querySelector('output');
    if (out) out.textContent = value > 0 ? '+' + value : String(value);
    saveFx(); applyFx(); renderFx();
  });
  $('#fxEnabled').addEventListener('change', (e) => {
    state.fx.enabled = e.target.checked;
    if (state.fx.enabled) ensureFxGraph();
    saveFx(); applyFx(); renderFx();
  });
  $('#fxIntensity').addEventListener('input', (e) => { state.fx.intensity = Number(e.target.value) / 100; saveFx(); applyFx(); renderFx(); });
  $('#fxWidth').addEventListener('input', (e) => { state.fx.width = Number(e.target.value); state.fx.preset = 'custom'; activateFx(); saveFx(); applyFx(); renderFx(); });
  $('#fxBass').addEventListener('input', (e) => { state.fx.bass = Number(e.target.value); state.fx.preset = 'custom'; activateFx(); saveFx(); applyFx(); renderFx(); });
  $('#fxTreble').addEventListener('input', (e) => { state.fx.treble = Number(e.target.value); state.fx.preset = 'custom'; activateFx(); saveFx(); applyFx(); renderFx(); });
  $('#fxBypass').addEventListener('click', () => { state.fx.bypass = !state.fx.bypass; saveFx(); applyFx(); renderFx(); });
  $('#fxReset').addEventListener('click', () => { state.fx = { enabled: false, bypass: false, preset: 'flat', intensity: 1, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bass: 0, treble: 0, width: 100 }; saveFx(); applyFx(); renderFx(); });
}
function openFx() {
  loadFx();
  if (!ensureFxGraph()) return;
  if (fxGraph.ctx && fxGraph.ctx.state === 'suspended') fxGraph.ctx.resume().catch(() => { });
  renderFx();
  $('#fxScrim').classList.remove('hidden');
  $('#fxDrawer').classList.add('open');
  $('#fxDrawer').setAttribute('aria-hidden', 'false');
  $('#btnFx').setAttribute('aria-expanded', 'true');
  document.body.classList.add('fx-open');
  startFxMeter();
  setTimeout(() => $('#btnFxClose').focus(), 40);
}
function closeFx() {
  stopFxMeter();
  $('#fxDrawer').classList.remove('open');
  $('#fxDrawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => $('#fxScrim').classList.add('hidden'), 220);
  $('#btnFx').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('fx-open');
  $('#btnFx').focus();
}
buildFxUi();
loadFx();
renderFx();
$('#btnFx').addEventListener('click', () => {
  if ($('#fxDrawer').classList.contains('open')) closeFx();
  else openFx();
});
$('#btnFxClose').addEventListener('click', closeFx);
$('#fxScrim').addEventListener('click', closeFx);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#fxDrawer').classList.contains('open')) { e.preventDefault(); closeFx(); }
  if (e.key === 'Tab' && $('#fxDrawer').classList.contains('open')) {
    const focusables = $$('#fxDrawer button, #fxDrawer input, #fxDrawer summary').filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
audio.addEventListener('play', () => {
  if (state.fx.enabled) ensureFxGraph();
  if (fxGraph.ctx && fxGraph.ctx.state === 'suspended') fxGraph.ctx.resume().catch(() => { });
});

/* ---------- search ---------- */
const SEARCH_HISTORY_KEY = 'musicArchiveSearchHistory';
function readSearchHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : [];
  } catch { return []; }
}
function recordSearch(query) {
  const text = String(query || '').trim();
  if (!text) return;
  const list = readSearchHistory().filter((x) => x !== text);
  list.unshift(text);
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, 8))); } catch { }
  renderSearchHistory();
}
function renderSearchHistory() {
  const box = $('#searchHistory');
  const list = $('#searchHistoryList');
  if (!box || !list) return;
  const history = readSearchHistory();
  box.classList.toggle('hidden', history.length === 0);
  list.innerHTML = history.map((q) => '<button type="button" class="search-history-item" data-search-history="' + esc(q) + '">' + esc(q) + '</button>').join('');
  list.querySelectorAll('[data-search-history]').forEach((el) => {
    el.addEventListener('click', () => {
      $('#searchInput').value = el.dataset.searchHistory;
      $('#searchInputClear').classList.remove('hidden');
      doSearch();
    });
  });
}
$('#searchHistoryClear').addEventListener('click', () => {
  try { localStorage.removeItem(SEARCH_HISTORY_KEY); } catch { }
  renderSearchHistory();
});
renderSearchHistory();

async function doSearch() {
  const q = $('#searchInput').value.trim();
  if (!q) { $('#searchInput').focus(); return; }
  recordSearch(q);
  state.searchLoading = true;
  state.search = [];
  state.selected.clear();
  $('#btnSearch').disabled = true;
  $('#searchSkeleton').innerHTML = skeletonRows(5);
  $('#searchSkeleton').classList.remove('hidden');
  $('#searchList').innerHTML = '';
  $('#searchHint').textContent = '正在聚合搜索…';
  $('#searchCount').textContent = '搜索中…';
  try {
    const data = await call('search', { query: q });
    state.search = data.songs || [];
    renderSearch();
    $('#searchHint').textContent = state.search.length
      ? '共 ' + state.search.length + ' 条结果。勾选后批量下载，或点单行下载。'
      : '没有结果。试试更短的关键词，或先在设置里登录平台账号。';
  } catch (err) {
    $('#searchSkeleton').classList.add('hidden');
    $('#searchHint').textContent = '搜索失败：' + err.message;
    $('#searchList').innerHTML = emptyState('search', '搜索失败', err.message);
    toast('搜索失败：' + err.message, 'err');
  } finally {
    state.searchLoading = false;
    $('#btnSearch').disabled = false;
  }
}
function renderSearch() {
  $('#searchSkeleton').classList.add('hidden');
  const list = $('#searchList');
  $('#page-search').classList.toggle('has-results', state.search.length > 0);
  $('#searchCount').textContent = state.search.length ? '找到 ' + state.search.length + ' 首' : '还没有结果';
  if (!state.search.length) {
    if (!state.searchLoading) list.innerHTML = emptyState('search', '还没有结果', '输入歌名、歌手，或粘贴分享链接。');
    updateBatchControls();
    return;
  }
  list.innerHTML = state.search.map((s, i) => {
    const selected = state.selected.has(i);
    return '<div class="row search-row" data-i="' + i + '">' +
      '<button type="button" class="check" data-check="' + i + '" role="checkbox" aria-checked="' + (selected ? 'true' : 'false') + '" aria-label="选择 ' + esc(s.name) + '">' + icon('check') + '</button>' +
      artMarkup(s.name, s.artist, s.cover) +
      '<div class="cell"><div class="cell-title" title="' + esc(s.name) + '">' + esc(s.name) + '</div><div class="cell-sub" title="' + esc(s.artist) + '">' + esc(s.artist) + '</div></div>' +
      '<div class="cell cell-muted cell-album" title="' + esc(s.album || '—') + '">' + esc(s.album || '—') + '</div>' +
      '<div class="search-meta"><span class="badge">' + esc(sourceLabel(s.source)) + '</span><span class="cell-muted">' + formatTime(s.duration) + '</span></div>' +
      '<div><button type="button" class="btn small ghost" data-dl="' + i + '">' + icon('download') + '下载</button></div>' +
      '</div>';
  }).join('');
  list.querySelectorAll('[data-check]').forEach((el) => el.addEventListener('click', () => {
    const i = Number(el.dataset.check);
    if (state.selected.has(i)) state.selected.delete(i); else state.selected.add(i);
    renderSearch();
  }));
  list.querySelectorAll('[data-dl]').forEach((el) => el.addEventListener('click', () => downloadSongs([state.search[Number(el.dataset.dl)]])));
  updateBatchControls();
}
function updateBatchControls() {
  const n = state.selected.size;
  $('#btnSelectAll').textContent = n && n === state.search.length ? '取消全选' : '全选';
  $('#btnDownloadSelected').disabled = n === 0;
  $('#btnDownloadSelected').textContent = n ? '下载选中（' + n + '）' : '下载选中';
}
async function downloadSongs(songs) {
  if (!songs.length || state.busy) return;
  state.busy = true;
  try {
    const res = await call('download', { songs });
    if (res && res.ok) {
      toast('已加入下载队列：' + res.queued + ' 首', 'ok', { label: '查看任务', onClick: () => showPage('downloads') });
      state.selected.clear();
      renderSearch();
      refreshQueueBadge();
    } else toast('加入队列失败：' + (res && res.error ? res.error : '未知错误'), 'err');
  } catch (err) { toast('加入队列失败：' + err.message, 'err'); }
  finally { state.busy = false; }
}
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
$('#btnSearch').addEventListener('click', (e) => { e.preventDefault(); doSearch(); });
$('#btnSelectAll').addEventListener('click', () => {
  if (state.selected.size === state.search.length) state.selected.clear();
  else state.search.forEach((_, i) => state.selected.add(i));
  renderSearch();
});
$('#btnDownloadSelected').addEventListener('click', () => {
  const songs = Array.from(state.selected).sort((a, b) => a - b).map((i) => state.search[i]).filter(Boolean);
  downloadSongs(songs);
});
$('#btnOpenReports').addEventListener('click', () => call('openFolder', { kind: 'reports' }).catch(() => {}));

/* ---------- downloads ---------- */
function setDownloadTab(tab) {
  state.downloadTab = tab;
  $$('.segmented [data-dltab]').forEach((b) => {
    const on = b.dataset.dltab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderDownloads();
}
$$('.segmented [data-dltab]').forEach((b) => b.addEventListener('click', () => setDownloadTab(b.dataset.dltab)));
async function loadDownloads(showSkeleton = false) {
  if (state.downloadsLoading) return;
  state.downloadsLoading = true;
  if (showSkeleton) {
    $('#downloadsSkeleton').innerHTML = skeletonRows(4);
    $('#downloadsSkeleton').classList.remove('hidden');
    $('#downloadsBody').innerHTML = '';
  }
  try {
    const data = await call('getDownloads');
    if (data && data.error) throw new Error(data.error);
    state.downloads = data;
    state.downloadsError = null;
    renderDownloads();
    updateQueueBadge();
  } catch (err) {
    state.downloadsError = err.message;
    renderDownloads();
  } finally {
    state.downloadsLoading = false;
    $('#downloadsSkeleton').classList.add('hidden');
  }
}
function updateQueueBadge() {
  const q = state.downloads && state.downloads.queue;
  const c = (q && q.counts) || {};
  const active = (c.waiting || 0) + (c.downloading || 0);
  const badge = $('#navQueue');
  badge.textContent = active > 99 ? '99+' : String(active);
  badge.classList.toggle('hidden', active === 0);
}
function progressInfo(q) {
  const c = (q && q.counts) || {};
  const total = (q && q.total) || 0;
  const finished = (c.success || 0) + (c.failed || 0) + (c.skipped || 0) + (c.canceled || 0);
  const active = (c.waiting || 0) + (c.downloading || 0);
  return { c, total, finished, active, percent: total ? Math.min(100, Math.round((finished / total) * 100)) : 0 };
}
function renderDownloads() {
  const data = state.downloads;
  if (state.downloadsError && (!data || !data.queue)) {
    $('#downloadsSub').textContent = '无法读取下载服务';
    $('#downloadsBody').innerHTML = emptyState('info', '下载服务不可用', state.downloadsError, '<button class="btn ghost small" data-retry-downloads>重试</button>');
    const retry = $('#downloadsBody [data-retry-downloads]');
    if (retry) retry.addEventListener('click', () => loadDownloads(true));
    return;
  }
  if (!data || !data.queue) {
    $('#downloadsBody').innerHTML = '<div class="empty"><span>加载任务中…</span></div>';
    return;
  }
  const q = data.queue;
  const p = progressInfo(q);
  $('#dlWaiting').textContent = String(p.c.waiting || 0);
  $('#dlDownloading').textContent = String(p.c.downloading || 0);
  $('#dlSuccess').textContent = String(p.c.success || 0);
  $('#dlFailed').textContent = String(p.c.failed || 0);
  $('#dlProgressText').textContent = p.finished + ' / ' + p.total;
  $('#dlProgressBar').style.width = p.percent + '%';
  $('#downloadsSub').textContent = p.active ? (p.c.downloading || 0) + ' 个下载中 · ' + (p.c.waiting || 0) + ' 个等待' : '队列空闲';
  if (state.downloadTab === 'records') {
    const records = (data.records && data.records.records) || [];
    if (!records.length) {
      $('#downloadsBody').innerHTML = emptyState('queue', '还没有下载记录', '完成一次下载后，这里会显示结果。');
      return;
    }
    $('#downloadsBody').innerHTML = records.map((r) => '<div class="record-line"><span class="name" title="' + esc(r.Name) + '">' + esc(r.Name || '未知歌曲') + ' <span class="cell-muted">' + esc(r.Artist || '') + '</span></span><span class="meta"><span class="status-pill ' + statusClass(r.Status) + '">' + statusLabel(r.Status) + '</span></span></div>').join('');
    return;
  }
  const tasks = (q.tasks || []).slice().sort((a, b) => {
    const order = { downloading: 0, waiting: 1, failed: 2, success: 3, skipped: 4, canceled: 5 };
    return (order[a.Status] ?? 9) - (order[b.Status] ?? 9);
  });
  if (!tasks.length) {
    $('#downloadsBody').innerHTML = emptyState('download', '没有等待中的任务', '在搜索页选择歌曲后，会出现在这里。', '<button class="btn primary small" data-go-search>去搜索</button>');
    const go = $('#downloadsBody [data-go-search]');
    if (go) go.addEventListener('click', () => showPage('search'));
    return;
  }
  $('#downloadsBody').innerHTML = tasks.map((t) => {
    const action = t.Status === 'waiting' ? '<button class="btn ghost" data-dlaction="cancel" data-id="' + esc(t.ID) + '">取消</button>'
      : t.Status === 'failed' ? '<button class="btn ghost" data-dlaction="retry" data-id="' + esc(t.ID) + '">重试</button>' : '';
    return '<div class="download-item"><div class="download-main"><div class="download-title" title="' + esc(t.Name) + '">' + esc(t.Name || '未知歌曲') + '</div><div class="download-sub' + (t.Status === 'failed' ? ' error' : '') + '" title="' + esc(t.Error || t.Path || '') + '">' + esc(t.Artist || '未知歌手') + ' · ' + esc(sourceLabel(t.Source)) + (t.Error ? ' · ' + esc(t.Error) : '') + '</div></div><span class="status-pill ' + statusClass(t.Status) + '">' + statusLabel(t.Status) + '</span><div class="download-actions">' + action + '</div></div>';
  }).join('');
  $('#downloadsBody').querySelectorAll('[data-dlaction]').forEach((b) => b.addEventListener('click', () => doDownloadAction(b.dataset.id, b.dataset.dlaction)));
}
async function doDownloadAction(id, action) {
  try {
    const res = await call('downloadAction', { id, action });
    if (res && res.ok) { toast(action === 'cancel' ? '已取消任务' : '已重新排队', 'ok'); await loadDownloads(); }
    else toast('操作失败：' + (res && res.error ? res.error : (res && res.body ? res.body : '未知错误')), 'err');
  } catch (err) { toast('操作失败：' + err.message, 'err'); }
}
async function refreshQueueBadge() {
  try {
    const data = await call('getDownloads');
    if (data && !data.error) { state.downloads = data; updateQueueBadge(); if (state.page === 'downloads') renderDownloads(); }
  } catch { }
}
function startDownloadPolling() { stopDownloadPolling(); downloadTimer = setInterval(() => loadDownloads(false), 2500); }
function stopDownloadPolling() { if (downloadTimer) { clearInterval(downloadTimer); downloadTimer = null; } }
$('#btnSodaUgc').addEventListener('click', async () => {
  if (state.busy) { toast('已有任务在运行'); return; }
  const ok = await openModal({
    title: '补下汽水原声',
    text: '直接下载汽水「喜欢」里用户创作的原声/直播切片，写入音乐库后自动整理入库。已经下载过的会跳过。',
    confirmLabel: '开始补下',
  });
  if (!ok) return;
  state.busy = true;
  try {
    const res = await call('sodaUgc');
    if (res && res.ok) {
      toast('原声已下载，正在整理入库…', 'ok');
      const m = await call('maintain');
      if (m && m.ok) toast('原声已入库', 'ok');
      else toast('原声已下载，但整理入库失败，请到设置里手动整理', 'warn');
      await loadLibrary(true);
      await loadDownloads();
    } else toast('补下原声失败：' + ((res && res.error) || '未知错误'), 'err');
  } catch (err) { toast('补下原声失败：' + err.message, 'err'); }
  finally { state.busy = false; }
});
$('#btnClearFailed').addEventListener('click', async () => {
  if (state.busy) { toast('已有任务在运行'); return; }
  const ok = await openModal({
    title: '清理失败任务',
    text: '只清理下载队列里的失败项，下载记录仍保留，不影响已下载文件。',
    confirmLabel: '清理',
  });
  if (!ok) return;
  try {
    const res = await call('clearFailed');
    if (res && res.ok) { toast('已清理失败任务 ' + res.removed + ' 条', 'ok'); await loadDownloads(); }
    else toast('清理失败：' + ((res && res.error) || '未知错误'), 'err');
  } catch (err) { toast('清理失败：' + err.message, 'err'); }
});
$('#btnRefreshDownloads').addEventListener('click', () => loadDownloads(true));
$('#btnRetryFailed').addEventListener('click', async () => {
  if (state.busy) { toast('已有任务在运行'); return; }
  const ok = await openModal({
    title: '汽水失败换源',
    text: '读取汽水失败任务，按「歌名 + 歌手」到其它平台找同歌手版本并重新入队；默认不接受翻唱，找不到的会跳过。',
    confirmLabel: '开始换源',
  });
  if (!ok) return;
  state.busy = true;
  try {
    const res = await call('sodaRetry');
    if (res && res.ok) { toast('换源任务已入队，下载后记得整理入库', 'ok'); await loadDownloads(); }
    else toast('换源失败：' + ((res && res.error) || '未知错误'), 'err');
  } catch (err) { toast('换源失败：' + err.message, 'err'); }
  finally { state.busy = false; }
});
$('#btnClearDownloads').addEventListener('click', async () => {
  if (!(await openModal({ title: '清空等待任务', text: '等待中的任务会停止排队；正在下载的一首会完成写入。已下载文件与下载记录保留。', confirmLabel: '清空等待', danger: true }))) return;
  try {
    const res = await call('downloadAction', { action: 'clear' });
    if (res && res.ok) { toast('等待任务已清空', 'ok'); await loadDownloads(); }
    else toast('清空失败：' + (res && res.error ? res.error : '未知错误'), 'err');
  } catch (err) { toast('清空失败：' + err.message, 'err'); }
});

/* ---------- account / native QR login ---------- */
function resetAccountView() {
  $('#accountCard').classList.remove('login-mode');
  $('#qrPanel').classList.add('hidden');
  $('#accountTitle').textContent = '平台账号';
  $('#accountSub').textContent = '在客户端内扫码登录，不打开网页。';
}
function openAccounts(source) {
  if (state.account.closeTimer) { clearTimeout(state.account.closeTimer); state.account.closeTimer = null; }
  state.account.previous = document.activeElement;
  resetAccountView();
  $('#accountModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#accountClose').focus();
  loadLikes().then(() => {
    renderAccountList();
    if (source && source !== 'soda') startQr(source);
  });
}
function closeAccounts() {
  stopQr();
  if (state.account.closeTimer) { clearTimeout(state.account.closeTimer); state.account.closeTimer = null; }
  resetAccountView();
  $('#accountModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  if (state.account.previous && typeof state.account.previous.focus === 'function') state.account.previous.focus();
  state.account.previous = null;
}
function renderAccountList() {
  const data = state.likes;
  if (!data || data.error) {
    $('#accountList').innerHTML = emptyState('info', '账号状态不可用', (data && data.error) || '下载服务未就绪');
    return;
  }
  const cookies = data.cookies || {};
  $('#accountList').innerHTML = (data.sources || []).map((s) => {
    const connected = !!s.connected;
    const isSoda = s.id === 'soda';
    const detail = isSoda
      ? '读取本机汽水客户端登录态'
      : connected ? (s.likedTotal && !s.backfilled ? '已登录 · 历史待补齐' : '已保存本机 Cookie') : '尚未登录';
    const button = isSoda ? '' : '<button class="btn ' + (connected ? 'ghost' : 'primary') + '" data-account-source="' + esc(s.id) + '">' + (connected ? '重新扫码' : '扫码登录') + '</button>';
    return '<div class="account-source"><div class="account-source-mark">' + icon(isSoda ? 'disc' : s.id === 'netease' ? 'search' : 'queue') + '</div>' +
      '<div class="account-source-copy"><strong>' + esc(s.name) + '</strong><p>' + esc(detail) + '</p></div>' +
      '<span class="status-pill ' + (connected ? 'status-success' : 'status-offline') + '">' + (connected ? '已连接' : '未连接') + '</span>' +
      button + '</div>';
  }).join('');
  $('#accountList').querySelectorAll('[data-account-source]').forEach((b) => b.addEventListener('click', () => startQr(b.dataset.accountSource)));
}
function setQrStatus(text, status = 'waiting') {
  $('#qrState').textContent = text;
  $('#qrState').className = 'status-pill ' + statusClass(status === 'success' ? 'success' : status === 'error' ? 'failed' : 'waiting');
}
function stopQr() {
  if (state.account.timer) { clearInterval(state.account.timer); state.account.timer = null; }
  state.account.key = null;
}
function closeQrPanel() {
  stopQr();
  if (state.account.closeTimer) { clearTimeout(state.account.closeTimer); state.account.closeTimer = null; }
  resetAccountView();
  renderAccountList();
  $('#accountClose').focus();
}
async function startQr(source) {
  if (source !== 'netease' && source !== 'qq') return;
  if (state.account.closeTimer) { clearTimeout(state.account.closeTimer); state.account.closeTimer = null; }
  stopQr();
  state.account.source = source;
  $('#accountCard').classList.add('login-mode');
  $('#qrPanel').classList.remove('hidden');
  const sourceName = source === 'qq' ? 'QQ 音乐' : '网易云音乐';
  $('#accountTitle').textContent = sourceName + '登录';
  $('#accountSub').textContent = '扫码成功后会短暂提示并自动关闭窗口。';
  $('#qrTitle').textContent = sourceName + '扫码登录';
  $('#qrHint').textContent = '打开 ' + sourceName + ' App，用「扫一扫」扫描二维码。';
  $('#qrImage').removeAttribute('src');
  $('#qrLoading').classList.remove('hidden');
  setQrStatus('生成中', 'waiting');
  try {
    const res = await call('qrStart', { source });
    if (!res || !res.ok) throw new Error((res && res.error) || '二维码创建失败');
    state.account.key = res.key;
    $('#qrImage').src = res.image;
    $('#qrLoading').classList.add('hidden');
    setQrStatus('等待扫码', 'waiting');
    state.account.timer = setInterval(pollQr, 2200);
  } catch (err) {
    $('#qrLoading').classList.add('hidden');
    setQrStatus('创建失败', 'error');
    $('#qrHint').textContent = err.message;
  }
}
async function pollQr() {
  if (!state.account.key || !state.account.source) return;
  const source = state.account.source;
  const key = state.account.key;
  try {
    const res = await call('qrPoll', { source, key });
    if (!res || !res.ok) throw new Error((res && res.error) || '检查登录状态失败');
    if (res.status === 'success') {
      stopQr();
      setQrStatus('登录成功', 'success');
      $('#qrHint').textContent = '已保存到本机，窗口即将自动关闭。';
      toast('登录成功：' + (source === 'qq' ? 'QQ 音乐' : '网易云音乐') + ' 已连接', 'ok');
      if (state.account.closeTimer) clearTimeout(state.account.closeTimer);
      state.account.closeTimer = setTimeout(() => {
        if (!$('#accountModal').classList.contains('hidden')) closeAccounts();
      }, 1200);
      loadLikes().then(() => renderAccountList()).catch(() => { });
      return;
    }
    if (res.status === 'scanned') setQrStatus('请在手机确认', 'waiting');
    else if (res.status === 'expired') { stopQr(); setQrStatus('已过期', 'error'); $('#qrHint').textContent = '二维码已过期，点「刷新二维码」。'; }
    else setQrStatus('等待扫码', 'waiting');
  } catch (err) {
    stopQr();
    setQrStatus('检查失败', 'error');
    $('#qrHint').textContent = err.message;
  }
}
$('#accountClose').addEventListener('click', closeAccounts);
$('#accountModal').addEventListener('click', (e) => { if (e.target.id === 'accountModal') closeAccounts(); });
$('#qrBack').addEventListener('click', closeQrPanel);
$('#qrRefresh').addEventListener('click', () => { if (state.account.source) startQr(state.account.source); });
$('#qrCancel').addEventListener('click', closeQrPanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#accountModal').classList.contains('hidden')) { e.preventDefault(); closeAccounts(); }
});

/* ---------- likes sync ---------- */
const LIKE_SOURCE_META = { soda: '汽水音乐', netease: '网易云音乐', qq: 'QQ 音乐' };
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
async function loadLikes() {
  try {
    const data = await call('getLikes');
    state.likes = data;
    renderLikes();
  } catch (err) {
    state.likes = { error: err.message };
    renderLikes();
  }
}
function renderLikes() {
  const data = state.likes;
  if (!data) {
    $('#likesSources').innerHTML = '<div class="empty" style="min-height:120px"><span>加载同步状态…</span></div>';
    return;
  }
  if (data.error) {
    $('#likesSources').innerHTML = emptyState('info', '无法读取同步状态', data.error);
    return;
  }
  const cfg = data.config || {};
  $('#likesEnabled').checked = !!cfg.enabled;
  $('#likesInterval').value = String(cfg.intervalHours || 24);
  $('#likesBackfill').checked = !!cfg.backfill;
  $('#likesAutoImport').checked = cfg.autoImport !== false;
  $('#likesReport').checked = cfg.generateReport === true;
  $('#btnLikesReport').classList.toggle('hidden', cfg.generateReport !== true);
  $('#likesAutoRemoveUnliked').checked = cfg.autoRemoveUnliked !== false;
  $('#likesAutoDeleteDup').checked = cfg.autoDeleteDuplicates !== false;
  $('#likesAutoMaintain').checked = cfg.autoMaintain !== false;
  $('#likesMaintainNext').textContent = cfg.autoMaintain
    ? (cfg.nextMaintainAt ? '下次 ' + fmtDate(cfg.nextMaintainAt) : '已开启')
    : '已关闭';
  $('#likesLast').textContent = cfg.lastRunAt ? fmtDate(cfg.lastRunAt) : '尚未同步';
  $('#likesNext').textContent = cfg.enabled ? (cfg.nextRunAt ? fmtDate(cfg.nextRunAt) : '未安排') : '已关闭';
  $('#likesScheduleText').textContent = cfg.enabled ? '已开启 · 每 ' + (cfg.intervalHours || 24) + ' 小时检查一次' : '自动同步已关闭，仍可手动同步';
  const pill = $('#likesRunPill');
  if (state.likesRunning) { pill.textContent = '同步中'; pill.className = 'status-pill status-downloading'; }
  else if (cfg.pendingImport) { pill.textContent = '等待入库'; pill.className = 'status-pill status-waiting'; }
  else { pill.textContent = '空闲'; pill.className = 'status-pill status-skipped'; }
  renderLikeSources(data.sources || [], data.cookies || {});
  renderLikeEvents(data.events || []);
  const results = (data.lastRun && data.lastRun.results) || [];
  const newCount = results.reduce((n, r) => n + (r.newCount || 0), 0);
  const badge = $('#navLikes');
  badge.textContent = String(newCount);
  badge.classList.toggle('hidden', !newCount);
}
function renderLikeSources(sources, cookies) {
  $('#likesSources').innerHTML = sources.map((s) => {
    const connected = !!s.connected;
    const detail = connected
      ? (s.likedTotal ? '喜欢 ' + s.likedTotal + ' 首 · ' + (s.lastSync ? '上次 ' + fmtDate(s.lastSync) : '尚未同步') + (!s.backfilled ? ' · 历史待补齐' : '') : '已登录 · 待首次同步')
      : '未配置登录态';
    return '<div class="source-row">' +
      '<div class="source-mark">' + icon(s.id === 'soda' ? 'disc' : s.id === 'netease' ? 'search' : 'queue') + '</div>' +
      '<div class="source-copy"><strong>' + esc(s.name || LIKE_SOURCE_META[s.id] || s.id) + '</strong><p title="' + esc(detail) + '">' + esc(detail) + '</p></div>' +
      '<span class="source-state ' + (connected ? 'on' : '') + '">' + (connected ? '已连接' : '未登录') + '</span>' +
      '<button class="btn ghost" data-like-manage="' + esc(s.id) + '">' + (connected ? '管理' : '登录') + '</button>' +
      '</div>';
  }).join('');
  $('#likesSources').querySelectorAll('[data-like-manage]').forEach((b) => b.addEventListener('click', () => openAccounts(b.dataset.likeManage)));
}
function renderLikeEvents(events) {
  const box = $('#likesEvents');
  if (!Array.isArray(events) || !events.length) {
    box.innerHTML = emptyState('heart', '还没有同步动态', '开启自动同步或点「立即同步」，这里会按每次运行汇总新增、取消与失败。');
    return;
  }
  const runs = new Map();
  for (const e of events) {
    const at = e.at || '';
    const key = at ? String(at).slice(0, 16) : 'unknown';
    if (!runs.has(key)) runs.set(key, { at, items: [] });
    runs.get(key).items.push(e);
  }
  const ordered = Array.from(runs.values())
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 8);
  const statusText = { baseline: '首次基线', ok: '同步完成', skipped: '跳过', error: '失败' };
  box.innerHTML = ordered.map((run, index) => {
    const items = run.items;
    const okN = items.filter((e) => e.status === 'ok' || e.status === 'baseline').length;
    const skipN = items.filter((e) => e.status === 'skipped').length;
    const errN = items.filter((e) => e.status === 'error').length;
    const overall = errN ? 'err' : (skipN === items.length ? 'warn' : 'ok');
    const summary = [items.length + ' 个来源', okN ? okN + ' 成功' : '', skipN ? skipN + ' 跳过' : '', errN ? errN + ' 失败' : ''].filter(Boolean).join(' · ');
    const chips = items.map((e) => {
      const name = LIKE_SOURCE_META[e.source] || e.source;
      const st = e.status === 'skipped' ? 'warn' : e.status === 'error' ? 'err' : 'ok';
      let sub;
      if (e.status === 'skipped') sub = e.connected ? '当时已登录 · 无歌单' : '当时未登录';
      else if (e.status === 'error') sub = '失败';
      else {
        sub = '喜欢 ' + (e.likedTotal || 0);
        if (e.newCount) sub += ' · 新增 ' + e.newCount;
        if (e.queued) sub += ' · 入队 ' + e.queued;
        if (e.removedCount) sub += ' · 取消 ' + e.removedCount;
      }
      return '<span class="run-source ' + st + '" title="' + esc('历史运行 · ' + (statusText[e.status] || e.status) + ' · ' + (e.message || '')) + '"><i></i><b>' + esc(name) + '</b><small>' + esc(sub) + '</small></span>';
    }).join('');
    const added = items.flatMap((e) => Array.isArray(e.added) ? e.added : []);
    const removed = items.flatMap((e) => Array.isArray(e.removed) ? e.removed : []);
    const detailLines = [];
    if (added.length) detailLines.push('<span class="run-detail-label">新增</span>' + added.slice(0, 30).map((s) => '<span>' + esc(s.title || s) + ' — ' + esc(s.artist || '') + '</span>').join(''));
    if (removed.length) detailLines.push('<span class="run-detail-label">取消</span>' + removed.slice(0, 30).map((s) => '<span>' + esc(s) + '</span>').join(''));
    const details = detailLines.length
      ? '<details class="run-details"><summary>查看新增 / 取消明细（' + (added.length + removed.length) + '）</summary><div class="event-list">' + detailLines.join('') + '</div></details>'
      : '';
    return '<div class="run-row" style="--run-i:' + index + '"><div class="run-rail"><i class="run-dot ' + overall + '"></i></div><div class="run-card">' +
      '<div class="run-head"><b>' + esc(fmtDate(run.at)) + '</b><span>' + esc(summary) + '</span></div>' +
      '<div class="run-sources">' + chips + '</div>' + details + '</div></div>';
  }).join('');
}
async function saveLikes(patch) {
  try {
    const res = await call('saveLikes', patch);
    if (res && res.ok) {
      if (state.likes) state.likes.config = res.config;
      renderLikes();
      toast('自动同步设置已保存', 'ok');
    } else toast('保存失败：' + (res && res.error ? res.error : '未知错误'), 'err');
  } catch (err) { toast('保存失败：' + err.message, 'err'); }
}
async function syncLikesNow() {
  if (state.likesRunning || state.busy) { toast('已有任务在运行'); return; }
  const cfg = (state.likes && state.likes.config) || {};
  const ok = await openModal({
    title: '立即同步喜欢',
    text: cfg.backfill ? '会读取各平台喜欢的歌曲，并把尚未入库的历史喜欢也加入下载。首次可能较多，继续？' : '会读取各平台新增的红心并加入下载队列；首次只建立基线，不下载历史。继续？',
    confirmLabel: '开始同步',
  });
  if (!ok) return;
  state.likesRunning = true;
  state.progressEl = $('#likesStatus');
  $('#btnLikesSync').disabled = true;
  $('#likesStatus').textContent = '读取平台喜欢…';
  renderLikes();
  try {
    const res = await call('syncLikes');
    if (res && res.ok) {
      $('#likesStatus').textContent = res.queued ? '已加入下载队列 ' + res.queued + ' 首' : '同步完成，无新增';
      toast(res.queued ? '喜欢同步：已加入下载队列 ' + res.queued + ' 首' : '喜欢同步完成，无新增', 'ok', res.queued ? { label: '查看任务', onClick: () => showPage('downloads') } : null);
    } else {
      const msg = (res && res.error) ? res.error : '未知错误';
      $('#likesStatus').textContent = '失败：' + msg;
      toast('喜欢同步失败：' + msg, 'err');
    }
    await loadLikes();
    refreshQueueBadge();
  } catch (err) {
    $('#likesStatus').textContent = '失败：' + err.message;
    toast('喜欢同步失败：' + err.message, 'err');
  } finally {
    state.likesRunning = false;
    state.progressEl = null;
    $('#btnLikesSync').disabled = false;
    renderLikes();
  }
}
function handleLikesEvent(data) {
  if (data.phase === 'start') {
    state.likesRunning = true;
    $('#likesRunPill').textContent = '同步中';
    $('#likesRunPill').className = 'status-pill status-downloading';
    $('#likesStatus').textContent = '正在同步喜欢…';
    $('#btnLikesSync').disabled = true;
    return;
  }
  if (data.phase === 'importing') {
    $('#likesStatus').textContent = '下载完成，正在整理入库…';
    $('#likesRunPill').textContent = '整理中';
    $('#likesRunPill').className = 'status-pill status-waiting';
    return;
  }
  if (data.phase === 'maintainStart') {
    $('#likesStatus').textContent = '正在定时整理音乐库…';
    $('#likesRunPill').textContent = '整理中';
    $('#likesRunPill').className = 'status-pill status-waiting';
    return;
  }
  if (data.phase === 'maintained') {
    toast('音乐库整理完成', 'ok');
    loadLibrary();
    loadLikes();
    return;
  }
  if (data.phase === 'maintainError') {
    toast('音乐库整理失败：' + (data.error || '未知错误'), 'err');
    loadLikes();
    return;
  }
  if (data.phase === 'removed') {
    if (data.removed) toast('取消喜欢：已移入回收站 ' + data.removed + ' 首', 'ok');
    loadLibrary();
    loadLikes();
    return;
  }
  if (data.phase === 'imported') {
    toast('喜欢同步：新文件已整理入库', 'ok');
    loadLibrary();
    loadLikes();
    return;
  }
  if (data.phase === 'error' || data.phase === 'importError') {
    toast('喜欢同步失败：' + (data.error || '未知错误'), 'err');
    state.likesRunning = false;
    $('#btnLikesSync').disabled = false;
    loadLikes();
    return;
  }
  if (data.phase === 'done') {
    state.likesRunning = false;
    $('#btnLikesSync').disabled = false;
    $('#likesStatus').textContent = data.queued ? '已加入下载队列 ' + data.queued + ' 首' : '同步完成，无新增';
    if (data.removed && data.removed.removed) toast('取消喜欢：已移入回收站 ' + data.removed.removed + ' 首', 'ok');
    if (data.queued) toast('喜欢同步：已加入下载队列 ' + data.queued + ' 首', 'ok', { label: '查看任务', onClick: () => showPage('downloads') });
    loadLikes();
    refreshQueueBadge();
  }
}
$('#btnLikesSync').addEventListener('click', syncLikesNow);
$('#btnLikesRefresh').addEventListener('click', loadLikes);
$('#btnLikesReport').addEventListener('click', () => call('openLikesReport').catch(() => {}));
$('#likesEnabled').addEventListener('change', (e) => saveLikes({ enabled: e.target.checked }));
$('#likesInterval').addEventListener('change', (e) => saveLikes({ intervalHours: Number(e.target.value) }));
$('#likesBackfill').addEventListener('change', (e) => saveLikes({ backfill: e.target.checked }));
$('#likesAutoImport').addEventListener('change', (e) => saveLikes({ autoImport: e.target.checked }));
$('#likesReport').addEventListener('change', (e) => saveLikes({ generateReport: e.target.checked }));
$('#likesAutoRemoveUnliked').addEventListener('change', (e) => saveLikes({ autoRemoveUnliked: e.target.checked }));
$('#likesAutoDeleteDup').addEventListener('change', (e) => saveLikes({ autoDeleteDuplicates: e.target.checked }));
$('#likesAutoMaintain').addEventListener('change', (e) => saveLikes({ autoMaintain: e.target.checked }));

/* ---------- record ---------- */
async function loadRecordings() {
  try {
    const data = await call('recordings');
    const files = data.files || [];
    $('#recordList').innerHTML = files.length
      ? files.map((f) => '<div class="record-line"><span class="name" title="' + esc(f.name) + '">' + esc(f.name) + '</span><span class="meta">' + formatSize(f.size) + '</span></div>').join('')
      : emptyState('record', '还没有录音', '点「开始录音」录一段系统声音。');
  } catch { }
}
async function pollRecord() {
  if (state.recordPolling) return;
  state.recordPolling = true;
  try {
    const s = await call('recordStatus');
    const was = state.record;
    state.record = !!s.recording;
    state.recordSeconds = s.seconds || 0;
    if (was && !state.record) { await loadRecordings(); const recDir = $('#pathRec').textContent; toast('录音已保存到 ' + (recDir && recDir !== '–' ? recDir : '录音目录'), 'ok'); }
  } catch { }
  finally { state.recordPolling = false; }
}
function renderRecord() {
  $('#recordTime').textContent = formatTime(state.recordSeconds);
  $('#recordState').textContent = state.record ? '正在录制' : '空闲';
  $('.recorder').classList.toggle('recording', state.record);
  const btn = $('#btnRecord');
  btn.textContent = state.record ? '停止录音' : '开始录音';
  btn.classList.toggle('stop', state.record);
}
$('#btnRecord').addEventListener('click', async () => {
  const btn = $('#btnRecord');
  btn.disabled = true;
  try {
    if (state.record) {
      const res = await call('recordStop');
      state.record = false; state.recordSeconds = 0;
      toast('已保存：' + (res.file || 'FLAC'), 'ok');
      await loadRecordings();
    } else {
      await call('recordStart');
      state.record = true; state.recordSeconds = 0;
    }
  } catch (err) { toast('录音操作失败：' + err.message, 'err'); }
  finally { btn.disabled = false; renderRecord(); }
});
$('#btnOpenRec').addEventListener('click', () => call('openFolder', { kind: 'recordings' }).catch(() => {}));

/* ---------- settings ---------- */
async function loadAppInfo() {
  try {
    const info = await call('getAppInfo');
    $('#pathLibrary').textContent = info.libraryRoot || '–';
    $('#pathMusic').textContent = info.musicDir || '–';
    $('#pathRec').textContent = info.recordingDir || '–';
    $('#pathReports').textContent = info.reportDir || '–';
    $('#recordTipPath').textContent = info.recordingDir || '–';
    const sources = Array.isArray(info.sourceDirs) ? info.sourceDirs : [];
    $('#pathSources').textContent = sources.length ? sources.length + ' 个目录' : '未配置';
    const sourceList = $('#sourceDirList');
    sourceList.innerHTML = sources.map((p) => '<div class="source-dir-item"><code title="' + esc(p) + '">' + esc(p) + '</code><button type="button" data-remove-source="' + esc(p) + '" aria-label="移除音源目录"><svg class="icon"><use href="#i-x"/></svg></button></div>').join('');
    sourceList.querySelectorAll('[data-remove-source]').forEach((button) => {
      button.addEventListener('click', async () => {
        const res = await call('removeSourceDir', { path: button.dataset.removeSource }).catch(() => null);
        if (res && res.ok) { toast('已移除音源目录', 'ok'); loadAppInfo(); }
        else toast('移除失败', 'err');
      });
    });
    $('#qqNote').textContent = info.qqNote || '–';
  } catch { }
}
$('#btnChangeLibrary').addEventListener('click', async () => {
  const current = $('#pathLibrary').textContent;
  const picked = await call('chooseFolder', { initial: current === '–' ? '' : current }).catch(() => null);
  if (!picked || !picked.ok || !picked.path) return;
  const ok = await openModal({
    title: '更改音乐库位置',
    text: '新位置：' + picked.path + '\n\n只切换档案和索引位置，不会自动移动已有音乐文件。建议选择空目录或已经整理好的目录。',
    confirmLabel: '切换',
  });
  if (!ok) return;
  const res = await call('setLibraryRoot', { path: picked.path }).catch(() => null);
  if (res && res.ok) {
    toast('音乐库位置已更新', 'ok');
    await loadLibrary(true);
    await loadAppInfo();
  } else toast('切换失败：' + ((res && res.error) || '未知错误'), 'err');
});
$('#btnAddSource').addEventListener('click', async () => {
  const picked = await call('chooseFolder', { initial: '' }).catch(() => null);
  if (!picked || !picked.ok || !picked.path) return;
  const res = await call('addSourceDir', { path: picked.path }).catch(() => null);
  if (res && res.ok) { toast('已添加音源目录', 'ok'); loadAppInfo(); }
  else toast('添加失败：' + ((res && res.error) || '未知错误'), 'err');
});

async function loadAiControl() {
  const data = await call('getAiControlStatus').catch(() => null);
  if (!data) return;
  state.aiControl = data;
  const on = !!(data.enabled && data.running);
  $('#aiControlBadge').textContent = on ? '已开启' : '关闭';
  $('#aiControlBadge').classList.toggle('accent', on);
  $('#aiControlState').textContent = on ? ('127.0.0.1:' + data.port) : (data.error || '未开启');
  $('#btnAiControlToggle').textContent = data.enabled ? '关闭' : '开启';
}
async function toggleAiControl() {
  const current = state.aiControl;
  const next = !(current && current.enabled);
  const res = await call('setAiControlEnabled', { enabled: next }).catch(() => null);
  if (res && res.ok) {
    toast(next ? 'AI 控制已开启' : 'AI 控制已关闭', 'ok');
    loadAiControl();
  } else toast((res && res.error) || 'AI 控制切换失败', 'err');
}
$('#btnAiControlToggle').addEventListener('click', toggleAiControl);
$('#btnCopyMcpConfig').addEventListener('click', async () => {
  const res = await call('copyAiMcpConfig').catch(() => null);
  if (res && res.ok) toast('MCP 配置已复制', 'ok');
  else toast('复制失败：' + ((res && res.error) || '未知错误'), 'err');
});
$('#btnOpenAiControlDocs').addEventListener('click', () => call('openAiControlDocs').catch(() => {}));

async function loadExtensions() {
  try {
    const data = await call('getExtensions');
    state.extensions = data.extensions || [];
    state.extensionSafeMode = !!data.safeMode;
    renderExtensions();
  } catch (err) {
    $('#extensionList').innerHTML = emptyState('extensions', '无法读取扩展', err.message);
  }
}
function renderExtensions() {
  const list = $('#extensionList');
  const safe = state.extensionSafeMode;
  $('#safeModeBadge').textContent = safe ? '开启' : '关闭';
  $('#safeModeBadge').classList.toggle('accent', safe);
  $('#btnSafeMode').textContent = safe ? '关闭安全模式' : '开启安全模式';
  if (!state.extensions.length) {
    list.innerHTML = '<div class="extension-empty"><b>还没有安装扩展</b><span>默认内置平台不受影响。安装一个协议扩展，或先装示例验证链路。</span><div><button class="btn ghost small" data-install-sample>安装示例</button></div></div>';
    list.querySelector('[data-install-sample]')?.addEventListener('click', installSampleExtension);
    return;
  }
  list.innerHTML = state.extensions.map((ext) => {
    const active = ext.enabled && !safe;
    const badge = safe ? '安全模式' : active ? '已启用' : '已禁用';
    return '<div class="extension-item" data-ext-id="' + esc(ext.id) + '">' +
      '<div class="extension-main"><div class="extension-title"><strong>' + esc(ext.name || ext.id) + '</strong><span class="badge' + (active ? ' accent' : '') + '">' + badge + '</span><span class="badge">' + esc(ext.kind || 'source') + '</span></div>' +
      '<small>' + esc(ext.id) + ' · v' + esc(ext.activeVersion || ext.version || '—') + (ext.canRollback ? ' · 可回退到 v' + esc(ext.lastGood) : '') + (ext.permissions && ext.permissions.length ? ' · 权限：' + esc(ext.permissions.join(', ')) : '') + '</small>' +
      '<p>' + esc(ext.description || '本地 JSON-RPC 扩展') + '</p></div>' +
      '<div class="extension-actions">' +
      '<button class="btn ghost small" data-ext-action="' + (active ? 'disable' : 'enable') + '">' + (active ? '禁用' : '启用') + '</button>' +
      (ext.canRollback ? '<button class="btn ghost small" data-ext-action="rollback">回退</button>' : '') +
      '<button class="btn ghost small" data-ext-action="remove">移除</button>' +
      '</div></div>';
  }).join('');
  list.querySelectorAll('[data-ext-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = button.closest('[data-ext-id]');
      const ext = state.extensions.find((x) => x.id === item.dataset.extId);
      const action = button.dataset.extAction;
      if (action === 'remove') {
        const ok = await openModal({ title: '移除扩展', text: '移除 ' + (ext?.name || ext?.id || '该扩展') + '？不会删除音乐文件。', confirmLabel: '移除' });
        if (!ok) return;
      }
      const res = await call('extensionAction', { id: item.dataset.extId, action }).catch(() => null);
      if (res && res.ok) { toast('扩展已' + (action === 'enable' ? '启用' : action === 'disable' ? '禁用' : action === 'rollback' ? '回退' : '更新'), 'ok'); loadExtensions(); }
      else toast((res && res.error) || '扩展操作失败', 'err');
    });
  });
}
async function installExtensionFromFolder() {
  const picked = await call('chooseFolder', { initial: '' }).catch(() => null);
  if (!picked || !picked.ok || !picked.path) return;
  const res = await call('installExtension', { path: picked.path }).catch(() => null);
  if (res && res.ok) { toast('扩展已安装并通过健康检查', 'ok'); loadExtensions(); }
  else toast('安装失败：' + ((res && res.error) || '健康检查未通过'), 'err');
}
async function installSampleExtension() {
  const res = await call('installSampleExtension').catch(() => null);
  if (res && res.ok) { toast('示例扩展已安装', 'ok'); loadExtensions(); }
  else toast('示例安装失败：' + ((res && res.error) || '未知错误'), 'err');
}
async function loadAgents() {
  const list = $('#agentList');
  list.innerHTML = '<div class="agent-loading">正在检测本机开发工具…</div>';
  const data = await call('getAgents').catch(() => null);
  state.agents = (data && data.agents) || [];
  if (!state.agents.length) { list.innerHTML = emptyState('extensions', '没有检测到开发工具', '安装 Codex、Claude Code 或 DSH 后点重新检测。'); return; }
  list.innerHTML = state.agents.map((agent) => '<div class="agent-item' + (agent.found ? '' : ' missing') + '">' +
    '<div class="agent-main"><strong>' + esc(agent.name) + '</strong><small>' + esc(agent.found ? (agent.path || agent.command) : '未检测到 ' + agent.command) + '</small>' +
    (agent.version ? '<p>' + esc(agent.version) + '</p>' : '') + '</div>' +
    (agent.found ? '<button class="btn ghost small" data-agent-launch="' + esc(agent.id) + '">打开工作区</button>' : '<span class="badge">未安装</span>') +
    '</div>').join('');
  list.querySelectorAll('[data-agent-launch]').forEach((button) => {
    button.addEventListener('click', async () => {
      const res = await call('launchAgent', { id: button.dataset.agentLaunch }).catch(() => null);
      if (res && res.ok) toast('已打开工作区：' + res.workspace, 'ok');
      else toast('启动失败：' + ((res && res.error) || '未知错误'), 'err');
    });
  });
}
$('#btnInstallExtension').addEventListener('click', installExtensionFromFolder);
$('#btnInstallSample').addEventListener('click', installSampleExtension);
$('#btnDetectAgents').addEventListener('click', loadAgents);
$('#btnOpenExtensions').addEventListener('click', () => call('openFolder', { kind: 'extensions' }).catch(() => {}));
$('#btnSafeMode').addEventListener('click', async () => {
  const next = !state.extensionSafeMode;
  if (next) {
    const ok = await openModal({ title: '开启安全模式', text: '会禁用所有外部扩展，应用核心和内置平台继续工作。', confirmLabel: '开启' });
    if (!ok) return;
  }
  const res = await call('setExtensionSafeMode', { safeMode: next }).catch(() => null);
  if (res && res.ok) { toast(next ? '安全模式已开启' : '安全模式已关闭', 'ok'); loadExtensions(); }
  else toast('操作失败', 'err');
});
const EXTENSION_AGENT_PROMPT = [
  '请使用 Skill：sdk/SKILL.md（软件内置 extension-sdk 复制到工作区）。',
  '先阅读协议：sdk/EXTENSIONS.md，以及示例：sdk/sample-source/。',
  '你的任务是为「留声」开发一个新的 source connector。',
  '在 03_DATA/50_music/extensions-dev/<platform>/ 内生成：',
  '- extension.json（id/name/version/runtime/entry/kind/capabilities/permissions）',
  '- index.mjs（describe / health / search / resolve）',
  '- fixtures 或 mock（不要装真实密钥）',
  '必须用：node sdk/test-connector.mjs . 跑通。',
  '不要修改客户端源码，不要写入 active 扩展目录，不要把 Cookie/token 写进文件或日志。',
  '最后输出：开发目录、测试结果、所需权限、认证方式。',
].join('\n');
$('#btnCopyExtensionPrompt').addEventListener('click', async () => {
  const res = await call('copyText', { text: EXTENSION_AGENT_PROMPT }).catch(() => null);
  if (res && res.ok) toast('Agent 指令已复制到剪贴板', 'ok');
  else toast('复制失败，请手动打开 Skill 文件', 'err');
});
$('#btnOpenDevWorkspace').addEventListener('click', () => call('openFolder', { kind: 'extensions-dev' }).catch(() => {}));
$('#btnOpenExtensionDocs').addEventListener('click', async () => {
  const res = await call('openExtensionDocs').catch(() => null);
  if (!res || !res.ok) toast('协议文件未找到：' + ((res && res.error) || ''), 'err');
});
$('#btnOpenCapabilities').addEventListener('click', async () => {
  const res = await call('openExtensionCapabilities').catch(() => null);
  if (!res || !res.ok) toast('能力说明未找到：' + ((res && res.error) || ''), 'err');
});
$('#btnLogin').addEventListener('click', () => openAccounts());
$('#btnClearRecent').addEventListener('click', async () => {
  if (!state.recent.length) { toast('还没有播放记录'); return; }
  const ok = await openModal({ title: '清空播放记录', text: '只清空本机最近播放列表，不会删除音乐文件。', confirmLabel: '清空' });
  if (!ok) return;
  state.recent = [];
  saveRecent();
  renderRecent();
  toast('播放记录已清空', 'ok');
});
$('#btnGotoSoda').addEventListener('click', () => { showPage('likes'); });

$('#btnOpenFolder').addEventListener('click', () => call('openFolder', { kind: 'library' }).catch(() => {}));
$('#btnOpenReports').addEventListener('click', () => call('openFolder', { kind: 'reports' }).catch(() => {}));
$('#btnMaintain').addEventListener('click', () => runLong('maintain', '整理音乐库', '扫描来源并导入、去重；只新增，不移动来源。可能耗时较久。', '整理'));
$('#btnDecrypt').addEventListener('click', () => runLong('decrypt', '解密原档', '批量解密网易云 NCM，按同名+同大小去重；QQ 缓存暂不支持。', '解密'));
async function runLong(cmd, title, text, label) {
  if (state.busy) { toast('已有任务在运行'); return; }
  if (!(await openModal({ title, text, confirmLabel: label }))) return;
  state.busy = true;
  state.progressEl = $('#maintainStatus');
  const button = cmd === 'maintain' ? $('#btnMaintain') : $('#btnDecrypt');
  button.disabled = true;
  try {
    const res = await call(cmd);
    if (res && res.ok) {
      toast(cmd === 'maintain' ? '整理完成' : '解密完成', 'ok');
      if (res.summary) state.progressEl.textContent = res.summary.split('\n')[0];
      await loadLibrary();
      await loadRecordings();
    } else toast('任务失败：' + (res && res.error ? res.error : '未知错误'), 'err');
  } catch (err) { toast('任务失败：' + err.message, 'err'); }
  finally { state.busy = false; state.progressEl = null; button.disabled = false; }
}
document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
  const text = ($('#' + btn.dataset.copy) || {}).textContent || '';
  try { await navigator.clipboard.writeText(text); toast('已复制路径', 'ok'); }
  catch { toast('复制失败，请手动选择路径', 'err'); }
}));

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (shortcutCapture) return;
  if (lyricsOpen && e.key === 'Escape') { e.preventDefault(); closeLyricsView(); return; }
  if (queueOpen && e.key === 'Escape') { e.preventDefault(); closeQueueDrawer(); return; }
  if (!$('#trackMenu').classList.contains('hidden') && e.key === 'Escape') { e.preventDefault(); closeTrackMenu(); return; }
  if (!$('#sleepMenu').classList.contains('hidden') && e.key === 'Escape') { e.preventDefault(); closeSleepMenu(); return; }
  if (e.target.matches('input, textarea, select, [contenteditable="true"]')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (document.body.classList.contains('modal-open') || !$('#accountModal').classList.contains('hidden')) return;
  const combo = comboFromEvent(e);
  const action = Object.entries(shortcutBindings).find(([, value]) => value === combo);
  if (action) {
    e.preventDefault();
    runShortcut(action[0]);
  }
});


/* ---------- init ---------- */
(async function init() {
  initTheme();
  initUiScale();
  loadPlayerPrefs();
  state.recent = readRecent();
  $$('.info-btn').forEach((b) => { b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'infoPopover'); });
  $('#libSkeleton').innerHTML = skeletonRows(6);
  $('#searchSkeleton').classList.add('hidden');
  $('#downloadsSkeleton').classList.add('hidden');
  try {
    const ready = await call('ready');
    $('#backendDot').classList.toggle('on', !!ready.backend);
    $('#backendDot').classList.toggle('off', !ready.backend);
    $('#backendText').textContent = ready.backend ? '下载服务已连接' : '下载服务未启动';
  } catch { $('#backendText').textContent = '下载服务未启动'; }
  await Promise.all([loadLibrary(), loadAppInfo(), loadRecordings()]);
  restoreLastPlayback();
  loadLikes();
  refreshQueueBadge();
  setInterval(async () => { await pollRecord(); renderRecord(); }, 1000);
  renderRecord();
})();





















