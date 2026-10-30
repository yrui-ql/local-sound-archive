/* Lightweight local i18n with a plugin registration entry.
 * Chinese is the source language; English is built in.
 * Additional locales can register at runtime:
 *   window.MusicArchiveI18n.register('ja-JP', { '音乐库': 'ライブラリ' }, { name: '日本語' })
 * This is intentionally local-only: no network, no cloud translation.
 */
(() => {
  const EN = {
    '留声': 'LSA',
    '本地音乐档案': 'Local music archive',\n    'LSA · 本地音乐档案': 'LSA · Local Sound Archive',
    '工作台': 'Workspace',
    '应用': 'App',
    '音乐库': 'Library',
    '最近播放': 'Recently played',
    '搜索下载': 'Search & download',
    '下载任务': 'Downloads',
    '喜欢同步': 'Liked sync',
    '录音': 'Recording',
    '设置': 'Settings',\n    '外观、账号与存储': 'Appearance, accounts and storage',
    '本地文件索引 · 不移动源文件': 'Local index · source files stay put',
    '索引就绪': 'Index ready',
    '导出 M3U': 'Export M3U',
    '打开目录': 'Open folder',
    '歌曲': 'Title',
    '专辑': 'Album',
    '格式': 'Format',
    '大小': 'Size',
    '全部': 'All',
    '其他': 'Other',
    '排序': 'Sort',
    '最近添加': 'Recently added',
    '搜索歌名、歌手、专辑...': 'Search title, artist, album…',
    '最近搜索': 'Recent searches',
    '清空': 'Clear',
    '搜索': 'Search',
    '搜索下载': 'Search & download',
    '聚合搜索': 'Search all sources',
    '未在播放': 'Nothing playing',
    '从音乐库选一首歌': 'Pick a track from your library',
    '播放队列': 'Queue',
    '队列': 'Queue',
    '还没有播放队列': 'Queue is empty',
    '清空队列': 'Clear queue',
    '外观': 'Appearance',
    '主题与界面配色': 'Theme and palette',
    '文字大小': 'Text size',
    '随窗口自动调整，不放大整个界面': 'Follows the window; does not zoom the whole UI',
    '标准': 'Standard',
    '较大': 'Larger',
    '特大': 'Extra large',
    '主题、文字大小和界面位置只保存在本机，不影响音乐文件。': 'Theme, text size and paths stay on this device and never touch your audio files.',
    '黑胶': 'Vinyl',
    '纸页': 'Paper',
    '青瓷': 'Celadon',
    '夜蓝': 'Night blue',
    '樱桃': 'Cherry',
    '跟随系统': 'System',
    '暖黑与铜色': 'Warm black and brass',
    '米白与墨色': 'Warm paper and ink',
    '深青与灰绿': 'Deep green and sage',
    '深蓝与雾蓝': 'Deep blue and mist',
    '酒红与珊瑚': 'Wine red and coral',
    '随 Windows 切换': 'Follow Windows',
    '账号与来源': 'Accounts & sources',
    '本机登录态': 'Local sign-in state',
    '平台账号': 'Platform accounts',
    '网易云 / QQ / 汽水': 'NetEase / QQ / Soda',
    '管理': 'Manage',
    '汽水喜欢': 'Soda likes',
    '从本机汽水客户端读取登录态': 'Read sign-in from the local Soda client',
    '去同步': 'Sync',
    '音乐库维护': 'Library maintenance',
    '只新增，不移动来源': 'Import only; never move sources',
    '整理音乐库': 'Organize library',
    '导入、去重与索引刷新': 'Import, dedupe and refresh index',
    '开始': 'Start',
    '解密原档': 'Decrypt originals',
    'NCM → FLAC / MP3': 'NCM → FLAC / MP3',
    '报告目录': 'Reports',
    '整理与同步记录': 'Maintenance and sync reports',
    '打开': 'Open',
    '存储': 'Storage',
    '目录与来源': 'Folders and sources',
    '音乐库位置': 'Library location',
    '音源': 'Sources',
    '更改': 'Change',
    '添加': 'Add',
    '音乐': 'Music',
    '保存到': 'Saving to',
    '最近录音': 'Recent recordings',
    '系统声音': 'System audio',
    '开始录音': 'Start recording',
    '停止录音': 'Stop recording',
    '空闲': 'Idle',
    '正在录制': 'Recording',
    '录音目录': 'Recording folder',
    '关于': 'About',
    '本机版本': 'Local version',
    '已知限制': 'Known limits',
    '外观与体验': 'Appearance',
    '下载任务': 'Downloads',
    '进行中': 'Active',
    '已完成': 'Completed',
    '失败': 'Failed',
    '全部任务': 'All tasks',
    '刷新': 'Refresh',
    '清除已完成': 'Clear completed',
    '取消': 'Cancel',
    '确定': 'OK',
    '保存': 'Save',
    '删除': 'Delete',
    '关闭': 'Close',
    '播放': 'Play',
    '暂停': 'Pause',
    '下一首': 'Next',
    '上一首': 'Previous',
    '下一首播放': 'Play next',
    '加入队列': 'Add to queue',
    '从队列移除': 'Remove from queue',
    '复制歌曲信息': 'Copy track info',
    '睡眠定时': 'Sleep timer',
    '分钟后暂停播放': 'minutes until pause',
    '睡眠定时结束，播放已暂停': 'Sleep timer finished; playback paused',
    '主题只保存在本机，不影响音乐文件。': 'Theme is stored locally and does not affect your audio files.',
    '没有匹配的歌曲': 'No matching tracks',
    '音乐库还是空的': 'Your library is empty',
    '换个关键词，或切换格式筛选。': 'Try another keyword or format filter.',
    '先到「搜索下载」拿几首歌，或在设置里整理音乐库。': 'Search & download a few tracks, or organize your library in Settings.',
    '去搜索': 'Search',
    '加载中…': 'Loading…',
    '显示': 'Showing',
    '首': 'tracks',
    '已显示全部': 'All tracks shown',
    '向下滚动自动加载': 'scroll to load more',
    '上一页': 'Previous page',
    '下一页': 'Next page',
    '正在聚合搜索…': 'Searching all sources…',
    '搜索中…': 'Searching…',
    '找到': 'Found',
    '还没有结果': 'No results yet',
    '最近播放': 'Recently played',
    '清空播放记录': 'Clear play history',
    '还没有播放记录': 'No play history yet',
    '播放记录已清空': 'Play history cleared',
    '导入': 'Import',
    '刷新索引': 'Refresh index',
    '索引': 'Index',
    '共': 'Total',
    '首歌曲': 'tracks',
    '张专辑': 'albums',
    '位艺人': 'artists',
    '存储位置': 'Storage location',
    '音源目录': 'Source folders',
    '本机目录': 'Local folders',
    '打开文件夹': 'Open folder',
    '选择目录': 'Choose folder',
    '已保存': 'Saved',
    '保存失败': 'Save failed',
    '操作失败': 'Operation failed',
    '完成': 'Done',
    '重试': 'Retry',
    '退出': 'Quit',
    '账户': 'Account',
    '登录': 'Sign in',
    '退出登录': 'Sign out',
    '扫码登录': 'Scan to sign in',
    '未登录': 'Not signed in',
    '已登录': 'Signed in',
    '英文': 'English',
    '语言': 'Language',
    '中文': '中文',
    '主题': 'Theme',
    '中文 / English；其他语言由扩展注册': 'Chinese / English; more languages can be registered by extensions',
    '账号、维护与存储。默认只显示会影响下一步的信息。': 'Accounts, maintenance and storage. Only what matters next is shown.',
    '下载服务已连接': 'Download service connected',
    '下载服务未连接': 'Download service offline',
    '连接中…': 'Connecting…',
    '留声 v3.0 · 本地优先': 'LSA v3.0 · local first',
    '主题与界面配色': 'Theme and palette',
    '随窗口自动调整，不放大整个界面': 'Follows the window without zooming the whole UI',
    '主题、文字大小和界面位置只保存在本机，不影响音乐文件。': 'Theme, text size and paths stay on this device and never touch your audio files.',
    '文字大小': 'Text size',
    '界面比例': 'Interface scale',
    '拖动后文字、行高和控件一起缩放': 'Drag to scale text, row height and controls together',
    '重置': 'Reset',
    '标准': 'Standard',
    '较大': 'Larger',
    '特大': 'Extra large',
  };

  const PATTERNS = [
    [/^显示 (\d+) \/ (\d+) 首 · 向下滚动自动加载$/, 'Showing $1 of $2 · scroll to load more'],
    [/^已显示全部 (\d+) 首$/, 'All $1 tracks shown'],
    [/^找到 (\d+) 首$/, 'Found $1 tracks'],
    [/^共 (\d+) 条结果。勾选后批量下载，或点单行下载。$/, '$1 results. Select for batch download, or download a single row.'],
    [/^下载任务 \((\d+)\)$/, 'Downloads ($1)'],
    [/^睡眠定时 · (\d+) 分钟$/, 'Sleep timer · $1 min'],
    [/^(\d+) 分钟后暂停播放$/, 'Pause in $1 minutes'],
    [/^已导出 (\d+) 首：(.+)$/, 'Exported $1 tracks: $2'],
    [/^正在播放 (.+)$/, 'Playing $1'],
  ];

  const ATTRS = ['title', 'aria-label', 'placeholder', 'data-tip'];
  const locales = new Map([
    ['zh-CN', { name: '中文', messages: null }],
    ['en-US', { name: 'English', messages: EN }],
  ]);
  const textSource = new WeakMap();
  const textLast = new WeakMap();
  const attrSource = new WeakMap();
  let current = 'zh-CN';
  let observer = null;
  let scheduled = false;

  function translateString(raw) {
    if (current === 'zh-CN' || !raw) return raw;
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    const pack = locales.get(current)?.messages || {};
    let hit = pack[trimmed];
    if (!hit) {
      for (const [re, replacement] of PATTERNS) {
        if (re.test(trimmed)) { hit = trimmed.replace(re, replacement); break; }
      }
    }
    if (!hit) return raw;
    return raw.replace(trimmed, hit);
  }

  function textNode(node, apply) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return;
    if (apply) {
      let source = textSource.get(node);
      if (source === undefined || (raw !== textLast.get(node) && raw !== source)) {
        source = raw;
        textSource.set(node, source);
      }
      const next = translateString(source);
      if (next !== raw) { textLast.set(node, next); node.nodeValue = next; }
    } else {
      const source = textSource.get(node);
      const last = textLast.get(node);
      if (source !== undefined && raw === last) node.nodeValue = source;
      textSource.delete(node);
      textLast.delete(node);
    }
  }

  function attributes(el, apply) {
    if (!el.getAttribute) return;
    let saved = attrSource.get(el);
    if (apply) {
      if (!saved) { saved = {}; attrSource.set(el, saved); }
      for (const name of ATTRS) {
        const value = el.getAttribute(name);
        if (!value) continue;
        if (!(name in saved)) saved[name] = value;
        const next = translateString(saved[name]);
        if (next !== value) el.setAttribute(name, next);
      }
    } else if (saved) {
      for (const [name, value] of Object.entries(saved)) el.setAttribute(name, value);
    }
  }

  function walk(root, apply) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) { textNode(root, apply); return; }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    attributes(root, apply);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) { textNode(node, apply); node = walker.nextNode(); }
    root.querySelectorAll('*').forEach((el) => attributes(el, apply));
  }

  function translateMutation(mutations) {
    if (current === 'zh-CN') return;
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') textNode(mutation.target, true);
      else mutation.addedNodes.forEach((node) => walk(node, true));
    }
  }

  function refresh() {
    if (!observer) {
      observer = new MutationObserver((mutations) => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; translateMutation(mutations); });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function setLanguage(locale, persist = true) {
    current = locales.has(locale) ? locale : 'zh-CN';
    document.documentElement.lang = current;
    if (persist) { try { localStorage.setItem('musicArchiveLanguage', current); } catch { } }
    if (current === 'zh-CN') {
      walk(document.body, false);
    } else {
      walk(document.body, true);
    }
    refresh();
    document.querySelectorAll('#languageOptions [data-language]').forEach((button) => {
      const active = button.dataset.language === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    try { window.dispatchEvent(new CustomEvent('musicarchive:locale', { detail: { locale: current } })); } catch { }
  }

  function register(locale, messages, meta = {}) {
    if (!locale || !messages || typeof messages !== 'object') return false;
    locales.set(locale, { name: meta.name || locale, messages });
    return true;
  }

  const api = {
    get locale() { return current; },
    locales: () => [...locales.entries()].map(([id, value]) => ({ id, name: value.name })),
    register,
    setLanguage,
    t: (key) => (locales.get(current)?.messages || {})[key] || key,
  };
  window.MusicArchiveI18n = api;

  function init() {
    let stored = 'zh-CN';
    try { stored = localStorage.getItem('musicArchiveLanguage') || 'zh-CN'; } catch { }
    setLanguage(stored, false);
    document.querySelectorAll('#languageOptions [data-language]').forEach((button) => {
      button.addEventListener('click', () => setLanguage(button.dataset.language));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();




