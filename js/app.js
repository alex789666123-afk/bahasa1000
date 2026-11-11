(function () {
'use strict';

/* =====================================================================
   数据：解析 data/words-*.js 里的词库
   每行格式：印尼语|中文|例句|例句中文|记忆点      以 # 开头的行是单元标题
   ===================================================================== */
var UNITS = [], WORDS = [], BYN = {};

function norm(s) {
  return String(s).toLowerCase().replace(/[.,!?;:]/g, '').replace(/[-\s]+/g, ' ').trim();
}

(window.WORD_DATA || '').split('\n').forEach(function (line) {
  line = line.trim();
  if (!line) return;
  if (line.charAt(0) === '#') {
    UNITS.push({ idx: UNITS.length, title: line.slice(1).trim(), words: [] });
    return;
  }
  var p = line.split('|');
  if (p.length < 2 || !UNITS.length) return;
  var w = {
    i: WORDS.length, id: p[0].trim(), zh: p[1].trim(),
    ex: (p[2] || '').trim(), exzh: (p[3] || '').trim(), hint: (p[4] || '').trim(),
    unit: UNITS.length - 1
  };
  if (BYN[norm(w.id)]) return;            // 跳过重复词
  BYN[norm(w.id)] = w;
  WORDS.push(w);
  UNITS[w.unit].words.push(w.i);
});

/* =====================================================================
   存档（localStorage）
   ===================================================================== */
var KEY = 'indo1000.v1';
var BATCH = 5;          // 新词每组 5 个：先看，再三轮主动回忆
var MATURE = 21;        // 间隔 ≥ 21 天视为“已掌握”

function defaults() {
  return {
    cards: {},            // id -> {iv 间隔天数, ease 难度系数, due 到期日, reps, lapses}
    known: {},            // id -> 1：已经会的词，被“斩”掉，不再出现
    notes: {},            // id -> 自己写的联想
    settings: { newPerDay: 20, autoPlay: true, rate: 0.85, voiceURI: '', readEx: true, useRec: true },
    daily: { day: 0, newDone: 0, revDone: 0 },
    streak: { last: 0, count: 0 },
    log: {}               // day -> {n 新学, r 复习, c 答对, t 总答题}
  };
}
function load() {
  var d = defaults();
  try {
    var s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.cards) {
      for (var k in d) if (s[k] === undefined) s[k] = d[k];
      for (var j in d.settings) if (s.settings[j] === undefined) s.settings[j] = d.settings[j];
      return s;
    }
  } catch (e) {}
  return d;
}
var S = load();
var storageOk = true;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { if (storageOk) { storageOk = false; toast('浏览器不允许保存进度，请换用普通（非无痕）窗口'); } }
}

/* 运行环境：是不是 iPhone／iPad，是不是已经“添加到主屏幕”以 App 形态运行 */
var IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
             (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
var STANDALONE = navigator.standalone === true ||
                 !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
function voiceHelp() {
  return IS_IOS
    ? '请打开 iPhone 的 <b>设置 → 辅助功能 → 朗读内容 → 声音 → 印度尼西亚文</b>，下载一个语音后重新打开本应用。'
    : '建议用 <b>Chrome</b> 或 <b>Edge</b> 浏览器打开本页（它们自带印尼语朗读）。';
}

/* 以凌晨 4 点为一天的分界，熬夜学习也算当天 */
function today() {
  var d = new Date();
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000 - 4 * 3600000) / 86400000);
}
function daily() {
  var t = today();
  if (S.daily.day !== t) S.daily = { day: t, newDone: 0, revDone: 0 };
  return S.daily;
}
function touchStreak() {
  var t = today();
  if (S.streak.last === t) return;
  S.streak.count = (S.streak.last === t - 1) ? S.streak.count + 1 : 1;
  S.streak.last = t;
}
function streakNow() {
  return S.streak.last >= today() - 1 ? S.streak.count : 0;
}

/* =====================================================================
   间隔重复算法（简化 SM-2）
   答对：间隔按难度系数拉长（1 → 3 → ×2.5 …）
   拼写小错：间隔只略增，系数下调
   答错：间隔归 1 天，系数下调，当场重考直到答对
   ===================================================================== */
function grade(c, g) {
  if (g === 'again') {
    c.lapses++;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.iv = 1;
  } else if (g === 'hard') {
    c.ease = Math.max(1.3, c.ease - 0.15);
    c.iv = Math.max(c.iv + 1, Math.round(c.iv * 1.2));
  } else {
    c.iv = c.iv < 1 ? 1 : c.iv < 3 ? 3 : Math.round(c.iv * c.ease * (0.95 + Math.random() * 0.1));
  }
  c.reps++;
  c.due = today() + c.iv;
}

/* 复习题型随熟练度升级：识别 → 听辨 → 拼写产出（越难提取，记得越牢） */
function reviewKind(c) {
  if (c.iv <= 1) return 'zh2id';
  if (c.iv <= 6) return hasVoice() ? 'listen' : 'id2zh';
  return 'type';
}

function stats() {
  var t = today(), learned = 0, mature = 0, due = 0, known = 0;
  WORDS.forEach(function (w) {
    if (S.known[w.id]) { known++; return; }
    var c = S.cards[w.id];
    if (!c) return;
    learned++;
    if (c.iv >= MATURE) mature++;
    if (c.due <= t) due++;
  });
  return { learned: learned, mature: mature, due: due, known: known, fresh: WORDS.length - learned - known };
}

/* =====================================================================
   语音（浏览器自带的印尼语朗读）
   ===================================================================== */
var voice = null, voices = [], voicesLoaded = false;

/* 给设备上的语音打分：印尼语优先；高音质、神经网络语音优先 */
function voiceScore(v) {
  var n = (v.name || '') + ' ' + (v.voiceURI || ''), s;
  if (/^id([-_]|$)/i.test(v.lang || '') || /indones/i.test(v.name || '')) s = 100;
  else if (/^ms([-_]|$)/i.test(v.lang || '')) s = 10;     // 马来语发音相近，实在没有印尼语时兜底
  else return -1;
  if (/premium|高音质/i.test(n)) s += 40;
  else if (/enhanced|优化|增强/i.test(n)) s += 30;
  if (/natural|neural/i.test(n)) s += 35;
  if (/google/i.test(n)) s += 15;
  if (/compact/i.test(n)) s -= 5;
  return s;
}
function voiceLabel(v) {
  var n = (v.name || '') + ' ' + (v.voiceURI || ''), q = '标准音质';
  if (/premium|高音质/i.test(n)) q = '高音质';
  else if (/enhanced|优化|增强/i.test(n)) q = '优化音质';
  else if (/natural|neural/i.test(n)) q = '神经网络语音，最自然';
  else if (/google/i.test(n)) q = '在线语音';
  if (/优化|增强|高音质/.test(v.name || '')) return v.name;     // 名字里已经写了音质，不重复标注
  return v.name + '（' + (/^ms/i.test(v.lang || '') ? '马来语，' : '') + q + '）';
}
function rankVoices(list) {
  return list.filter(function (v) { return voiceScore(v) >= 0; })
             .sort(function (a, b) { return voiceScore(b) - voiceScore(a); });
}
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  var vs = speechSynthesis.getVoices();
  if (!vs.length) return;
  var first = !voicesLoaded, prev = voice, prevN = voices.length;
  voicesLoaded = true;
  voices = rankVoices(vs);
  // 用户手动选过发音人就用它，否则自动用音质最好的
  var chosen = S.settings.voiceURI && voices.filter(function (v) { return v.voiceURI === S.settings.voiceURI; })[0];
  voice = chosen || voices[0] || null;
  if ((first || voice !== prev || voices.length !== prevN) && (view === 'home' || view === 'settings')) render();
}
/* ---------- 录制语音（data/audio.js 列出哪些词和例句有录音） ---------- */
var PACK = window.AUDIO_PACK || null;
var REC = { w: {}, s: {} }, EX2SLUG = {};
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
if (PACK) {
  (PACK.w || []).forEach(function (k) { REC.w[k] = 1; });
  (PACK.s || []).forEach(function (k) { REC.s[k] = 1; });
}
WORDS.forEach(function (w) { w.slug = slug(w.id); if (w.ex) EX2SLUG[w.ex] = w.slug; });

function usingRec() { return !!PACK && S.settings.useRec !== false; }
function packCount() { return PACK ? (PACK.w || []).length + (PACK.s || []).length : 0; }
/* 这段文字有没有录音：先按例句找，再按单词找 */
function recUrl(text) {
  if (!usingRec() || !text) return null;
  var sl = EX2SLUG[text];
  if (sl && REC.s[sl]) return 'audio/s/' + sl + '.mp3';
  var w = BYN[norm(text)];
  if (w && REC.w[w.slug]) return 'audio/w/' + w.slug + '.mp3';
  return null;
}
function hasVoice() { return !!voice || usingRec(); }

/* 全程只用一个播放器：iPhone 要求先由用户点一下“解锁”，之后才允许自动播放 */
var SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
var player = null, playQ = [], playToken = 0, blobs = {}, blobKeys = [];
function getPlayer() {
  if (!player) {
    player = new Audio();
    player.preload = 'auto';
    var onDone = function () { if (String(player.src).indexOf('data:') !== 0) playNext(); };
    player.addEventListener('ended', onDone);
    player.addEventListener('error', onDone);
  }
  return player;
}
function unlockAudio() {
  document.removeEventListener('touchend', unlockAudio, true);
  document.removeEventListener('click', unlockAudio, true);
  if (!PACK) return;
  try {
    var p = getPlayer();
    if (p.src) return;
    p.src = SILENT;
    var pr = p.play();
    if (pr && pr.catch) pr.catch(function () {});
  } catch (e) {}
}
document.addEventListener('touchend', unlockAudio, true);
document.addEventListener('click', unlockAudio, true);

/* 把音频取成内存里的地址再播放：这样离线缓存和 iPhone 的播放器都不会出问题 */
function loadBlob(url) {
  if (blobs[url]) return Promise.resolve(blobs[url]);
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('audio ' + r.status);
    return r.blob();
  }).then(function (b) {
    if (blobs[url]) return blobs[url];
    blobs[url] = URL.createObjectURL(b);
    blobKeys.push(url);
    if (blobKeys.length > 400) { var old = blobKeys.shift(); URL.revokeObjectURL(blobs[old]); delete blobs[old]; }
    return blobs[url];
  });
}
function audioRate() { return Math.min(1.5, Math.max(0.5, S.settings.rate / 0.85)); }
/* 设置页显示的语速：录音以原速为 1.00 倍 */
function shownRate() { return (usingRec() ? audioRate() : S.settings.rate).toFixed(2); }

function ttsSpeak(text, done) {
  if (!('speechSynthesis' in window)) { if (done) done(); return; }
  try {
    var u = new SpeechSynthesisUtterance(text.replace(/[—_]/g, ' '));
    u.lang = voice ? voice.lang : 'id-ID';
    if (voice) u.voice = voice;
    u.rate = S.settings.rate;
    if (done) { u.onend = done; u.onerror = done; }
    speechSynthesis.speak(u);
  } catch (e) { if (done) done(); }
}
function stopSpeaking() {
  playQ = [];
  playToken++;
  try { if (player) player.pause(); } catch (e) {}
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) {}
}
function playNext() {
  var item = playQ.shift();
  if (!item) return;
  var token = playToken;
  var fallback = function () { if (token === playToken) ttsSpeak(item.text, function () { if (token === playToken) playNext(); }); };
  if (!item.url) { fallback(); return; }
  loadBlob(item.url).then(function (src) {
    if (token !== playToken) return;
    var p = getPlayer();
    p.src = src;
    p.defaultPlaybackRate = p.playbackRate = audioRate();
    var pr = p.play();
    if (pr && pr.catch) pr.catch(fallback);
  }, fallback);
}
/* 朗读 text；如果给了 then，读完接着读 then（用于“单词 + 例句”连读）。
   有录音就播录音，没有就退回设备自带的语音。 */
function speak(text, then) {
  if (!text) return;
  stopSpeaking();
  playQ = [text, then].filter(Boolean).map(function (t) { return { text: t, url: recUrl(t) }; });
  playNext();
}
/* 开始学习时，把这一轮要用的发音先悄悄取好，播放时就没有延迟 */
function prefetchSession() {
  if (!usingRec() || !ses) return;
  var seen = {}, urls = [], i = 0;
  ses.q.forEach(function (t) {
    [t.w.id, t.w.ex].forEach(function (x) {
      var u = recUrl(x);
      if (u && !seen[u]) { seen[u] = 1; urls.push(u); }
    });
  });
  urls = urls.slice(0, 120);
  (function next() { if (i < urls.length) loadBlob(urls[i++]).then(next, next); })();
}
/* 一次性把全部发音存到设备里，之后断网也能听 */
var dlBusy = false;
function downloadAll() {
  if (dlBusy || !PACK) return;
  dlBusy = true;
  var urls = (PACK.w || []).map(function (k) { return 'audio/w/' + k + '.mp3'; })
    .concat((PACK.s || []).map(function (k) { return 'audio/s/' + k + '.mp3'; }));
  var i = 0, done = 0, fail = 0, total = urls.length;
  function info(t) { var el = document.getElementById('dlinfo'); if (el) el.textContent = t; }
  function one() {
    if (i >= total) return;
    fetch(urls[i++]).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); })
      .catch(function () { fail++; })
      .then(function () {
        done++;
        if (done % 20 === 0 || done === total) info('下载中 ' + done + ' / ' + total);
        if (done < total) { one(); return; }
        dlBusy = false;
        S.settings.audioDone = fail === 0;
        save();
        info(fail ? '有 ' + fail + ' 段没下载成功，请联网后再点一次' : '已全部下载，断网也能听');
        toast(fail ? '部分发音没下载成功' : '全部发音已下载');
      });
  }
  info('下载中 0 / ' + total);
  for (var k = 0; k < 4; k++) one();
}
function recRows() {
  if (!PACK) return '';
  return '<div class="set"><div>发音来源<small>录制语音更自然，在任何设备上听起来都一样</small></div><select data-set="useRec">' +
    '<option value="1"' + (usingRec() ? ' selected' : '') + '>录制语音（推荐）</option>' +
    '<option value="0"' + (usingRec() ? '' : ' selected') + '>设备自带语音</option></select></div>' +
    '<div class="set"><div>下载全部发音<small id="dlinfo">' +
    (S.settings.audioDone ? '已全部下载，断网也能听' : '共 ' + packCount() + ' 段。不下载也能用：听过的会自动保存') + '</small></div>' +
    '<button class="btn" type="button" data-act="dlAudio">' + (S.settings.audioDone ? '重新下载' : '下载') + '</button></div>';
}

if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
  // 有些浏览器（尤其 iPhone）不触发上面的事件，过一会儿再主动取几次
  [600, 1500, 3500].forEach(function (ms) { setTimeout(loadVoices, ms); });
}

/* =====================================================================
   小工具
   ===================================================================== */
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function shuffle(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1)), x = a[i]; a[i] = a[j]; a[j] = x;
  }
  return a;
}
function lev(a, b) {
  var m = a.length, n = b.length, prev = [], cur = [], i, j;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur = [i];
    for (j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function meanings(w) {
  return w.zh.replace(/（[^）]*）/g, '').split(/[；、，,;／\/]/).map(function (x) { return x.trim(); }).filter(Boolean);
}
function shareMeaning(a, b) {
  var mb = meanings(b);
  return meanings(a).some(function (x) { return mb.indexOf(x) >= 0; });
}
/* 在例句中定位词条本身（整词匹配） */
function findInEx(w) {
  if (!w.ex) return null;
  var re = new RegExp('(^|[^A-Za-z])(' + w.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![A-Za-z])', 'i');
  var m = re.exec(w.ex);
  if (!m) return null;
  var at = m.index + m[1].length;
  return { before: w.ex.slice(0, at), word: w.ex.slice(at, at + w.id.length), after: w.ex.slice(at + w.id.length) };
}
function exHtml(w) {
  var f = findInEx(w);
  return f ? esc(f.before) + '<b>' + esc(f.word) + '</b>' + esc(f.after) : esc(w.ex);
}
function clozeHtml(w) {
  var f = findInEx(w);
  return f ? esc(f.before) + '<span class="blank">?</span>' + esc(f.after) : null;
}
var SPK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
function spk(text, cls) {
  return '<button type="button" class="spk ' + (cls || '') + '" data-act="say" data-t="' + esc(text) + '" title="朗读" aria-label="朗读">' + SPK + '</button>';
}
var toastTimer = null;
function toast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
}
function status(w) {
  if (S.known[w.id]) return 'k';
  var c = S.cards[w.id];
  return !c ? '' : c.iv >= MATURE ? 'm' : 'l';
}

/* 完整单词卡：词、音、义、例句、记忆点、自己的联想 */
function wordCard(w, withNote) {
  return '<div class="wc">' +
    '<div class="idw">' + esc(w.id) + spk(w.id) + '</div>' +
    '<div class="zh">' + esc(w.zh) + '</div>' +
    (w.ex ? '<div class="ex" data-act="say" data-t="' + esc(w.ex) + '" title="点击朗读例句">' + exHtml(w) +
            '<small>' + esc(w.exzh) + '</small></div>' : '') +
    (w.hint ? '<div class="hint">' + esc(w.hint) + '</div>' : '') +
    (withNote ? '<textarea class="note" rows="2" data-note="' + esc(w.id) + '" placeholder="写下你自己的联想（谐音、画面、小故事）——自己编的记得最牢">' +
                esc(S.notes[w.id] || '') + '</textarea>' : '') +
    '</div>';
}

/* =====================================================================
   学习会话
   ===================================================================== */
var ses = null, advTimer = null;
var KIND = { intro: '认识新词', id2zh: '看词选义', zh2id: '看义选词', listen: '听音选义', type: '回忆并拼写' };

function startSession(mode) {
  var t = today(), q = [];
  if (mode === 'cram') {
    var weak = WORDS.filter(function (w) { return S.cards[w.id]; }).sort(function (a, b) {
      var ca = S.cards[a.id], cb = S.cards[b.id];
      return (cb.lapses - ca.lapses) || (ca.ease - cb.ease) || (ca.iv - cb.iv);
    }).slice(0, 20);
    shuffle(weak).forEach(function (w) { q.push({ w: w, kind: 'type', phase: 'cram' }); });
  } else {
    // 1) 先复习到期的旧词
    var due = WORDS.filter(function (w) { var c = S.cards[w.id]; return c && c.due <= t; })
      .sort(function (a, b) { return S.cards[a.id].due - S.cards[b.id].due; }).slice(0, 100);
    shuffle(due).forEach(function (w) { q.push({ w: w, kind: reviewKind(S.cards[w.id]), phase: 'review' }); });
    // 2) 再学新词：每 5 个一组，看完立刻进行三轮由易到难的回忆
    var quota = mode === 'extra' ? 10 : Math.max(0, S.settings.newPerDay - daily().newDone);
    var fresh = WORDS.filter(function (w) { return !S.cards[w.id] && !S.known[w.id]; }).slice(0, quota);
    for (var i = 0; i < fresh.length; i += BATCH) {
      var b = fresh.slice(i, i + BATCH);
      b.forEach(function (w) { q.push({ w: w, kind: 'intro', phase: 'learn' }); });
      shuffle(b.slice()).forEach(function (w) { q.push({ w: w, kind: 'id2zh', phase: 'learn', step: 1 }); });
      shuffle(b.slice()).forEach(function (w) { q.push({ w: w, kind: 'zh2id', phase: 'learn', step: 2 }); });
      shuffle(b.slice()).forEach(function (w) { q.push({ w: w, kind: 'type', phase: 'learn', step: 3 }); });
    }
  }
  if (!q.length) { toast(mode === 'cram' ? '还没有学过的词，先开始今日学习吧' : '没有可学的内容了'); return; }
  ses = { q: q, pos: 0, asked: 0, right: 0, newCount: 0, revCount: 0, killed: 0, missed: {}, answered: false, finished: false, mode: mode };
  prefetchSession();
  go('study');
}

function curTask() { return ses.q[ses.pos]; }

function makeOpts(t) {
  if (t.opts) return t.opts;
  var w = t.w;
  var pool = UNITS[w.unit].words.map(function (i) { return WORDS[i]; })
    .filter(function (x) { return x !== w && x.zh !== w.zh; });
  t.opts = shuffle(shuffle(pool).slice(0, 3).concat([w]));
  return t.opts;
}

/* “斩”：这个词已经会了，标记后永远不再出现（可在词表里恢复） */
function killCurrent() {
  if (!ses || ses.finished) return;
  clearTimeout(advTimer);
  var t = curTask(), w = t.w;
  var start = ses.answered ? ses.pos + 1 : ses.pos;   // 已答完的当前题保留，其余全部移除
  S.known[w.id] = 1;
  delete S.cards[w.id];
  ses.killed++;

  // 如果是在“认识新词”这一步斩掉的，直接补一个新词顶上，保证今天的新词量不缩水
  var rep = null;
  if (t.kind === 'intro') {
    var inQ = {};
    ses.q.forEach(function (x) { inQ[x.w.id] = 1; });
    rep = WORDS.filter(function (x) { return !S.cards[x.id] && !S.known[x.id] && !inQ[x.id]; })[0] || null;
  }
  if (rep) {
    for (var j = start; j < ses.q.length; j++) {
      if (ses.q[j].w === w) { ses.q[j].w = rep; ses.q[j].opts = null; }
    }
  } else {
    ses.q = ses.q.slice(0, start).concat(ses.q.slice(start).filter(function (x) { return x.w !== w; }));
  }
  save();
  toast('已斩：' + w.id + '（可在词表里恢复）');
  if (ses.answered) ses.pos++;
  ses.answered = false;
  if (ses.pos >= ses.q.length) ses.finished = true;
  render();
}

function onAnswer(ok, extra) {
  if (!ses || ses.answered) return;
  extra = extra || {};
  ses.answered = true;
  var t = curTask(), w = t.w, td = today();
  ses.asked++;
  if (ok) ses.right++;
  touchStreak();
  var lg = S.log[td] || (S.log[td] = { n: 0, r: 0, c: 0, t: 0 });
  lg.t++;
  if (ok) lg.c++;

  if (t.phase === 'review' && !t.retry) {
    grade(S.cards[w.id], ok ? (extra.hard ? 'hard' : 'good') : 'again');
    daily().revDone++; lg.r++; ses.revCount++;
  }
  if (t.phase === 'learn' && ok && t.step === 3 && !S.cards[w.id]) {
    // 三轮都通过 → 进入长期记忆队列，明天第一次复习
    S.cards[w.id] = { iv: 1, ease: ses.missed[w.id] ? 2.3 : 2.5, due: td + 1, reps: 0, lapses: 0 };
    daily().newDone++; lg.n++; ses.newCount++;
  }
  if (!ok) {
    ses.missed[w.id] = (ses.missed[w.id] || 0) + 1;
    // 答错的题隔几题再考一次，直到答对
    var again = { w: w, kind: t.kind, phase: t.phase, step: t.step, retry: true };
    // 但不越过下一组新词的开头，保证这一组彻底过关再学新的
    var at = Math.min(ses.q.length, ses.pos + 4);
    for (var j = ses.pos + 1; j < at; j++) {
      if (ses.q[j].kind === 'intro') { at = j; break; }
    }
    ses.q.splice(at, 0, again);
  }
  save();
  showFeedback(ok, extra);
}

function showFeedback(ok, extra) {
  var t = curTask(), w = t.w, fb = document.getElementById('fb');
  if (!fb) return;
  // 标出选项对错
  var btns = document.querySelectorAll('.opt');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    b.disabled = true;
    if (t.opts[i] === w) b.classList.add('right');
    else if (extra.chosen === i) b.classList.add('wrong');
  }
  var inp = document.getElementById('ans');
  if (inp) inp.readOnly = true;
  var gu = document.querySelector('[data-act="giveup"]');
  if (gu) gu.style.display = 'none';
  var blank = document.querySelector('.blank');
  if (blank) blank.textContent = w.id;
  if (S.settings.autoPlay) speak(w.id);

  if (ok && !extra.hard) {
    fb.innerHTML = '<div class="fb ok">✓ 正确<small><b>' + esc(w.id) + '</b> — ' + esc(w.zh) + '</small></div>';
    advTimer = setTimeout(next, t.kind === 'type' ? 1500 : 1100);
  } else if (ok) {
    fb.innerHTML = '<div class="fb tip">基本正确，注意拼写<small>正确写法 <b>' + esc(w.id) + '</b>，你写的是 ' + esc(extra.typed || '') + '</small></div>' +
      '<button class="btn primary big" data-act="next">继续<kbd>Enter</kbd></button>';
  } else {
    fb.innerHTML = '<div class="fb no">✗ ' + (extra.typed ? '你写的是 ' + esc(extra.typed) : '没关系，再看一遍，稍后会重考') + '</div>' +
      wordCard(w, true) +
      '<button class="btn primary big" data-act="next">继续<kbd>Enter</kbd></button>';
    fb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function next() {
  clearTimeout(advTimer);
  if (!ses) return;
  ses.pos++;
  ses.answered = false;
  if (ses.pos >= ses.q.length) ses.finished = true;
  render();
}

function checkTyped(val) {
  if (!ses || ses.answered) return;
  var t = curTask(), w = t.w, a = norm(val), b = norm(w.id);
  if (!a) return;
  if (a === b) return onAnswer(true);
  var other = BYN[a];
  if (other && other !== w && shareMeaning(other, w)) {
    var fb = document.getElementById('fb');
    fb.innerHTML = '<div class="fb tip">“' + esc(other.id) + '”也有这个意思，但这里要的是另一个词<small>提示：' +
      esc(w.id.charAt(0)) + ' 开头，共 ' + w.id.length + ' 个字符</small></div>';
    var inp = document.getElementById('ans');
    inp.value = ''; inp.focus();
    return;
  }
  if (b.length >= 5 && lev(a, b) === 1) return onAnswer(true, { hard: true, typed: val.trim() });
  onAnswer(false, { typed: val.trim() });
}

/* =====================================================================
   视图
   ===================================================================== */
var app = document.getElementById('app');
var view = 'home';
var browse = { q: '', showZh: false };

function go(v) { view = v; render(); window.scrollTo(0, 0); }

function render() {
  var navs = document.querySelectorAll('[data-nav]');
  for (var i = 0; i < navs.length; i++) navs[i].classList.toggle('on', navs[i].getAttribute('data-nav') === view);
  document.body.classList.toggle('in-study', view === 'study');
  var fn = { home: viewHome, study: viewStudy, browse: viewBrowse, guide: viewGuide, settings: viewSettings }[view];
  app.innerHTML = fn();
  if (view === 'study' && ses && !ses.finished) {
    var t = curTask();
    if (S.settings.autoPlay && t.kind === 'intro') speak(t.w.id, S.settings.readEx ? t.w.ex : '');
    else if (S.settings.autoPlay && (t.kind === 'id2zh' || t.kind === 'listen')) speak(t.w.id);
    var inp = document.getElementById('ans');
    if (inp) inp.focus();
  }
  if (view === 'browse') fillBrowse();
}

/* ---------- 今日 ---------- */
function viewHome() {
  if (!WORDS.length) return '<div class="card">词库没有加载成功，请确认 data 文件夹完整。</div>';
  var st = stats(), d = daily(), t = today(), N = WORDS.length;
  var newLeft = Math.min(st.fresh, Math.max(0, S.settings.newPerDay - d.newDone));
  var mins = Math.max(1, Math.round((st.due * 7 + newLeft * 40) / 60));
  var h = '';

  h += '<div class="hero"><div><h1>' + (st.learned ? 'Selamat belajar!' : 'Selamat datang!') + '</h1>' +
       '<p class="muted">' + (st.learned ? '学习愉快！每天一小段，比周末突击有效得多。' : '欢迎！从最常用的词开始，每天约 10 分钟。') + '</p></div>' +
       '<div class="streak"><b>' + streakNow() + '</b><span class="muted">连续天数</span></div></div>';

  if (voicesLoaded && !hasVoice()) {
    h += '<div class="banner">没有检测到印尼语语音，发音功能暂不可用。' + voiceHelp() + '</div>';
  }
  if (IS_IOS && !STANDALONE && !S.settings.hideInstall) {
    h += '<div class="banner"><b>装成 App 再开始学：</b>点 Safari 底部的分享按钮 <b>→“添加到主屏幕”</b>，以后从主屏幕图标打开，全屏、断网都能学。' +
         '注意：Safari 里的进度和主屏幕 App 里的进度<b>互不相通</b>，请装好后在 App 里学。' +
         '<button class="link" type="button" data-act="hideInstall">知道了，不再提示</button></div>';
  }

  h += '<div class="card"><h2>今日任务</h2><div class="today">' +
       '<div class="stat rev"><b>' + st.due + '</b><span>待复习（快忘之前拉一把）</span></div>' +
       '<div class="stat new"><b>' + newLeft + '</b><span>新词（今天已学 ' + d.newDone + '）</span></div></div>';
  if (st.due + newLeft > 0) {
    h += '<button class="btn primary big" data-act="start">' + (d.newDone + d.revDone > 0 ? '继续今日学习' : '开始今日学习') + '</button>' +
         '<p class="muted" style="text-align:center;margin-top:8px">约 ' + mins + ' 分钟 · 中途退出也会保存进度</p>';
  } else if (st.fresh === 0) {
    h += '<p><b>1000 词全部学完了！</b>以后只需按时回来复习，把它们送进长期记忆。</p>' +
         '<div class="row"><button class="btn" data-act="cram">薄弱词加练</button></div>';
  } else {
    h += '<p><b>今日任务已完成。</b>明天回来复习，记忆才会真正巩固——间隔比时长重要。</p>' +
         '<div class="row"><button class="btn" data-act="extra">还有精力，再学 10 个</button>' +
         (st.learned ? '<button class="btn" data-act="cram">薄弱词加练</button>' : '') + '</div>';
  }
  h += '</div>';

  var learning = st.learned - st.mature;
  h += '<div class="card"><h2>总进度 <span class="muted" style="font-weight:400">' + (st.learned + st.known) + ' / ' + N + '</span></h2>' +
       '<div class="pbar"><i class="k" style="width:' + (st.known / N * 100) + '%"></i><i class="m" style="width:' + (st.mature / N * 100) + '%"></i><i class="l" style="width:' + (learning / N * 100) + '%"></i></div>' +
       '<div class="legend">' + (st.known ? '<span><i style="background:var(--ink)"></i>已斩 ' + st.known + '</span>' : '') +
       '<span><i style="background:var(--ok)"></i>已掌握 ' + st.mature + '</span>' +
       '<span><i style="background:var(--gold)"></i>巩固中 ' + learning + '</span>' +
       '<span><i style="background:var(--line)"></i>未学 ' + st.fresh + '</span></div>';
  if (st.fresh > 0) {
    h += '<p class="muted" style="margin-top:10px">按每天 ' + S.settings.newPerDay + ' 个新词，大约 ' + Math.ceil(st.fresh / S.settings.newPerDay) + ' 天学完全部。</p>';
  }
  h += '</div>';

  // 未来 7 天复习量
  var fc = [0, 0, 0, 0, 0, 0, 0], mx = 1;
  WORDS.forEach(function (w) {
    var c = S.cards[w.id];
    if (!c) return;
    var k = c.due - t;               // 今天到期的已算在“待复习”里
    if (k >= 1 && k <= 7) fc[k - 1]++;
  });
  fc.forEach(function (x) { if (x > mx) mx = x; });
  if (st.learned) {
    var names = ['明天', '后天', '3天后', '4天后', '5天后', '6天后', '7天后'];
    h += '<div class="card"><h2>未来 7 天的复习量</h2><div class="fc">' + fc.map(function (x, i) {
      return '<div><b>' + x + '</b><i style="height:' + Math.round(x / mx * 70) + '%"></i>' + names[i] + '</div>';
    }).join('') + '</div></div>';
  }

  h += '<div class="card"><details class="method"' + (st.learned ? '' : ' open') + '><summary>这套方法为什么记得牢、学得快</summary><ol>' +
       '<li><b>间隔重复</b>：每个词在你“快要忘记”时再出现，间隔 1 → 3 → 8 → 20 天…逐步拉长，用最少的次数记最久。</li>' +
       '<li><b>主动回忆</b>：不是反复看，而是逼自己想出来。新词要过三关：看词选义 → 看义选词 → 自己拼写。</li>' +
       '<li><b>小组学习</b>：每次只学 5 个新词，学完马上测，不堆积。</li>' +
       '<li><b>会的就斩</b>：已经认识的词点“斩”，它不再出现，时间全花在不会的词上。</li>' +
       '<li><b>语境 + 声音</b>：每个词都有例句和发音，拼写题用例句填空，记的是“会用”而不是孤立的词。</li>' +
       '<li><b>中文母语优势</b>：印尼语里有不少闽南语借词（teh 茶、mie 面、tahu 豆腐）和英语借词，记忆点会帮你点出来。</li>' +
       '<li><b>自己编联想</b>：每个词都可以写下你自己的谐音或画面，自己编的比别人给的牢得多。</li>' +
       '</ol></details></div>';
  return h;
}

/* ---------- 学习 ---------- */
function optsHtml(t, field) {
  return '<div class="opts">' + makeOpts(t).map(function (o, i) {
    return '<button class="opt ' + (field === 'id' ? 'id' : '') + '" data-act="pick" data-i="' + i + '"><span class="k">' + (i + 1) + '</span><span>' +
      esc(field === 'id' ? o.id : o.zh) + '</span></button>';
  }).join('') + '</div>';
}

function viewStudy() {
  if (!ses) { view = 'home'; return viewHome(); }
  if (ses.finished) return viewSummary();
  var t = curTask(), w = t.w;
  var pct = Math.round(ses.pos / ses.q.length * 100);
  var phase = t.phase === 'review' ? '复习' : t.phase === 'cram' ? '加练' : '新词';
  var h = '<div class="sbar"><button class="x" data-act="quit" title="结束本次学习" aria-label="结束本次学习">✕</button>' +
          '<div class="prog"><i style="width:' + pct + '%"></i></div><span class="cnt">' + (ses.pos + 1) + ' / ' + ses.q.length + '</span></div>';
  h += '<div class="card"><div class="thead"><span class="tag ' + t.phase + '">' + phase + ' · ' + KIND[t.kind] + (t.retry ? ' · 重考' : '') + '</span>' +
       '<button class="kill" type="button" data-act="skill" title="这个词我已经会了，以后不再出现">斩 · 已经会了<kbd>X</kbd></button></div>';

  if (t.kind === 'intro') {
    h += wordCard(w, true) + '<button class="btn primary big" data-act="next">记住了，下一个<kbd>Enter</kbd></button>';
  } else if (t.kind === 'id2zh') {
    h += '<div class="q"><div class="idw">' + esc(w.id) + spk(w.id) + '</div></div>' + optsHtml(t, 'zh');
  } else if (t.kind === 'listen') {
    h += '<div class="q">' + spk(w.id, 'xl') + '<div class="muted">听发音，选出意思（空格键重听）</div></div>' + optsHtml(t, 'zh');
  } else if (t.kind === 'zh2id') {
    h += '<div class="q"><div class="zhq">' + esc(w.zh) + '</div></div>' + optsHtml(t, 'id');
  } else {
    var c = clozeHtml(w);
    h += '<div class="q"><div class="zhq">' + esc(w.zh) + '</div>' +
         (c ? '<div class="cz">' + c + '</div><div class="muted">' + esc(w.exzh) + '</div>' : '') + '</div>' +
         '<form class="typef" data-form="type"><input id="ans" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="输入印尼语" aria-label="输入印尼语">' +
         '<button class="btn primary" type="submit">确定</button></form>' +
         '<button class="link" data-act="giveup" type="button">想不起来，看答案</button>';
  }
  h += '<div id="fb"></div></div>';
  return h;
}

function viewSummary() {
  var acc = ses.asked ? Math.round(ses.right / ses.asked * 100) : 100;
  var miss = Object.keys(ses.missed).map(function (id) { return BYN[norm(id)]; }).filter(Boolean);
  var st = stats();
  var h = '<div class="card sum"><p class="muted">本次学习完成</p><div class="big-n">' + acc + '%</div><p class="muted">正确率</p>' +
    '<div class="sum-grid"><div class="stat new"><b>' + ses.newCount + '</b><span>新学</span></div>' +
    '<div class="stat rev"><b>' + ses.revCount + '</b><span>复习</span></div>' +
    '<div class="stat"><b>' + streakNow() + '</b><span>连续天数</span></div></div>' +
    (ses.killed ? '<p class="muted">本次斩掉 ' + ses.killed + ' 个已经会的词，它们不会再出现。</p>' : '') +
    '<p>' + (ses.mode === 'cram' ? '加练不影响复习计划，只是多一次提取。' :
      '累计已学 <b>' + st.learned + '</b> 个词。明天会有 <b>' + tomorrowDue() + '</b> 个词等你复习——<b>明天回来这一步最关键</b>。') + '</p>' +
    '<button class="btn primary big" data-act="home">回到首页</button></div>';
  if (miss.length) {
    h += '<div class="card miss"><h2>这次卡住的词（' + miss.length + '）</h2><p class="muted">点开看看，试着给它们各写一个自己的联想。</p>' +
         miss.map(function (w) { return rowHtml(w, false, true); }).join('') + '</div>';
  }
  return h;
}
function tomorrowDue() {
  var t = today() + 1, n = 0;
  WORDS.forEach(function (w) { var c = S.cards[w.id]; if (c && c.due <= t) n++; });
  return n;
}

/* ---------- 1000 词总表 ---------- */
function rowHtml(w, open, showZh) {
  var c = S.cards[w.id], known = !!S.known[w.id], meta = '尚未学习', z = showZh ? '1' : '0';
  if (known) {
    meta = '已斩，不会再出现';
  } else if (c) {
    var k = c.due - today();
    meta = (c.iv >= MATURE ? '已掌握' : '巩固中') + ' · 间隔 ' + c.iv + ' 天 · ' + (k <= 0 ? '今天复习' : k + ' 天后复习') + (c.lapses ? ' · 忘过 ' + c.lapses + ' 次' : '');
  }
  return '<div class="wrow' + (known ? ' known' : '') + (open ? ' open' : '') + '" id="w' + w.i + '">' +
    '<div class="head" data-act="toggle" data-i="' + w.i + '" data-z="' + z + '">' +
    '<span class="no">' + (w.i + 1) + '</span><span class="dot ' + status(w) + '"></span>' +
    '<span class="w">' + esc(w.id) + '</span><span class="z">' + (showZh && !open ? esc(w.zh) : '') + '</span>' + spk(w.id) + '</div>' +
    (open ? '<div class="more"><div class="mzh">' + esc(w.zh) + '</div>' +
      (w.ex ? '<div class="ex" data-act="say" data-t="' + esc(w.ex) + '" title="点击朗读例句">' + exHtml(w) + '<small>' + esc(w.exzh) + '</small></div>' : '') +
      (w.hint ? '<div class="hint">' + esc(w.hint) + '</div>' : '') +
      '<div class="mfoot"><span class="meta">' + meta + '</span>' +
      '<button class="btn sm' + (known ? '' : ' killb') + '" type="button" data-act="kill" data-i="' + w.i + '" data-z="' + z + '">' +
      (known ? '恢复学习' : '斩 · 已经会了') + '</button></div>' +
      '<textarea class="note" rows="2" data-note="' + esc(w.id) + '" placeholder="我的联想…">' + esc(S.notes[w.id] || '') + '</textarea></div>' : '') +
    '</div>';
}
function listCount() {
  var st = stats();
  return '已斩 ' + st.known + ' · 已学 ' + st.learned + ' · 未学 ' + st.fresh;
}
function viewBrowse() {
  return '<h1>1000 词总表</h1>' +
    '<p class="muted">从第 1 个到第 ' + WORDS.length + ' 个，按学习顺序排列。<b>点一下单词</b>，显示中文意思和例句；已经会的可以直接“斩”掉。</p>' +
    '<input class="search" id="bq" type="search" placeholder="搜索印尼语或中文…" value="' + esc(browse.q) + '" aria-label="搜索">' +
    '<div class="ltools"><select id="jump" aria-label="跳到单元"><option value="">跳到单元…</option>' +
    UNITS.map(function (u) {
      return '<option value="' + u.idx + '">' + (u.words[0] + 1) + '–' + (u.words[u.words.length - 1] + 1) + '　' + esc(u.title) + '</option>';
    }).join('') + '</select>' +
    '<label class="chk"><input type="checkbox" id="showzh"' + (browse.showZh ? ' checked' : '') + '>直接显示全部中文</label>' +
    '<span class="muted" id="lcount">' + listCount() + '</span></div>' +
    '<div id="blist"></div>';
}
function fillBrowse() {
  var el = document.getElementById('blist');
  if (!el) return;
  var q = browse.q.trim().toLowerCase(), z = browse.showZh, h = '';
  if (q) {
    var hits = WORDS.filter(function (w) { return w.id.toLowerCase().indexOf(q) >= 0 || w.zh.indexOf(q) >= 0; });
    h = '<div class="card">' + (hits.length ? hits.slice(0, 200).map(function (w) { return rowHtml(w, false, z); }).join('') :
        '<p class="muted">没有找到“' + esc(browse.q) + '”</p>') + '</div>';
  } else {
    h = UNITS.map(function (u) {
      return '<div class="card ucard" id="u' + u.idx + '"><h2>' + esc(u.title) +
        ' <span class="muted" style="font-weight:400">第 ' + (u.words[0] + 1) + '–' + (u.words[u.words.length - 1] + 1) + ' 词</span></h2>' +
        u.words.map(function (i) { return rowHtml(WORDS[i], false, z); }).join('') + '</div>';
    }).join('');
  }
  el.innerHTML = h;
}

/* ---------- 发音与语法 ---------- */
function say(t) { return '<span class="say" data-act="say" data-t="' + esc(t) + '">' + esc(t) + '</span>'; }
function viewGuide() {
  var rows = [
    ['a i u o', '和拼音 a、i、u、o 基本一样，读得短而清楚', 'nasi · buku · toko'],
    ['e', '两种读法：多数读轻的“呃”[ə]；少数读“诶”[e]。拼写不区分，靠听', 'besar（呃）· meja（诶）'],
    ['c', '永远读“七”的声母 [tʃ]，接近拼音 q / ch。<b>不是</b> k 也不是 s', 'cari · kecil · cinta'],
    ['j', '接近拼音 j / zh，但声带要振动', 'jalan · meja'],
    ['p t k', '不送气，听起来像拼音的 b、d、g', 'pagi · tidur · kaki'],
    ['b d g', '真正的浊音，声带先振动。g 永远是硬音', 'baru · dua · gigi'],
    ['r', '大舌颤音（弹舌）。弹不出来先用单击的“勒”代替', 'rumah · baru · kamar'],
    ['ng', '后鼻音 [ŋ]，可以出现在词首。ngg = ng + g', 'ngopi · dengan · tinggal'],
    ['ny', '像“尼呀”快速连读 [ɲ]', 'nyamuk · banyak'],
    ['sy · kh', 'sy = 拼音 x / sh；kh = 喉部的 h', 'syarat · khusus'],
    ['h', '清晰送气，词尾的 h 也要轻轻呼出', 'rumah · mudah'],
    ['词尾 k', '不爆破，只是喉咙一紧就停住（喉塞音）', 'tidak · bapak · kakak'],
    ['ai · au', '双元音，口语里常读成 e / o', 'pantai · pulau'],
    ['重音', '很轻，通常落在倒数第二个音节；<b>没有声调</b>', 'ma-KAN · se-LA-mat']
  ];
  return '<div class="guide">' +
    '<div class="card"><h2>发音：怎么写就怎么读</h2><p class="muted">印尼语用拉丁字母，拼读完全规则，没有声调。点例词可以听发音。</p>' +
    '<table><tr><th>字母</th><th>给中文母语者的说明</th><th>例词</th></tr>' +
    rows.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2].split(' · ').map(function (x) {
        var word = x.replace(/（.*）/, '');
        return /^[a-z]+$/.test(word) ? '<span class="say" data-act="say" data-t="' + word + '">' + esc(x) + '</span>' : esc(x);
      }).join(' · ') + '</td></tr>';
    }).join('') + '</table></div>' +

    '<div class="card"><h2>语法：对中国人非常友好</h2><ul>' +
    '<li><b>没有时态变化</b>，和中文一样靠时间词：' + say('sudah') + ' 已经、' + say('sedang') + ' 正在、' + say('akan') + ' 将要、' + say('belum') + ' 还没。</li>' +
    '<li><b>没有性、数、格</b>，动词不随人称变化。' + say('dia') + ' 既是“他”也是“她”。</li>' +
    '<li><b>语序基本是 主-谓-宾</b>，和中文一致：' + say('Saya makan nasi') + ' = 我 吃 饭。</li>' +
    '<li><b>修饰语放在后面</b>（和中文相反，最需要适应）：' + say('rumah besar') + ' = 房子 大 → 大房子；' + say('buku saya') + ' = 书 我 → 我的书。</li>' +
    '<li><b>否定</b>：' + say('tidak') + ' 否定动词和形容词，' + say('bukan') + ' 否定名词，' + say('jangan') + ' = 别、不要。</li>' +
    '<li><b>复数靠重叠</b>：' + say('buku-buku') + ' = 书（很多本）。有数量词时不用重叠。</li>' +
    '<li><b>疑问句</b>：语调上扬即可，或句首加 ' + say('apakah') + '。</li></ul>' +

    '<h3>词缀：认识几个就能猜词</h3><ul>' +
    '<li><b>me-</b>（meng-/mem-/men-/meny-）：主动动词。' + say('beli') + ' → ' + say('membeli') + ' 买；口语常省略前缀。</li>' +
    '<li><b>ber-</b>：“有、处于…状态”。' + say('jalan') + ' 路 → ' + say('berjalan') + ' 走路。</li>' +
    '<li><b>di-</b>：被动。' + say('dibeli') + ' = 被买。</li>' +
    '<li><b>ter-</b>：最…／不小心。' + say('terbesar') + ' = 最大。</li>' +
    '<li><b>-an</b>：变名词。' + say('makan') + ' 吃 → ' + say('makanan') + ' 食物；' + say('minum') + ' → ' + say('minuman') + ' 饮料。</li>' +
    '<li><b>pe-</b>：做某事的人。' + say('kerja') + ' → ' + say('pekerja') + ' 工人。</li>' +
    '<li><b>ke-…-an / pe-…-an</b>：抽象名词。' + say('sehat') + ' → ' + say('kesehatan') + ' 健康。</li>' +
    '<li><b>-nya</b>：他的／那个。' + say('harganya') + ' = 它的价格。</li></ul></div></div>';
}

/* ---------- 设置 ---------- */
function viewSettings() {
  var st = stats(), tot = 0, cor = 0;
  for (var k in S.log) { tot += S.log[k].t; cor += S.log[k].c; }
  var opt = [5, 10, 15, 20, 30, 40].map(function (n) {
    return '<option value="' + n + '"' + (S.settings.newPerDay === n ? ' selected' : '') + '>' + n + ' 个 / 天（约 ' + Math.ceil(WORDS.length / n) + ' 天学完）</option>';
  }).join('');
  return '<div class="card"><h2>学习设置</h2>' +
    '<div class="set"><div>每天新词数量<small>新词越多，之后每天的复习量也越大。拿不准就选 20。</small></div><select data-set="newPerDay">' + opt + '</select></div>' +
    '<div class="set"><div>自动朗读<small>出现单词时自动播放发音</small></div><input type="checkbox" data-set="autoPlay"' + (S.settings.autoPlay ? ' checked' : '') + ' style="width:20px;height:20px"></div>' +
    '<div class="set"><div>朗读语速<small>当前 ' + shownRate() + ' 倍</small></div><input type="range" min="0.5" max="1.2" step="0.05" value="' + S.settings.rate + '" data-set="rate"></div>' +
    recRows() + (usingRec() ? '' : voices.length ?
      '<div class="set"><div>发音人<small>已按音质从高到低排列；换一个再点“试听”比较</small></div><select data-set="voiceURI">' +
      voices.map(function (v) {
        return '<option value="' + esc(v.voiceURI) + '"' + (voice === v ? ' selected' : '') + '>' + esc(voiceLabel(v)) + '</option>';
      }).join('') + '</select></div>'
      : '<div class="set"><div>发音人<small>未检测到印尼语语音。' + voiceHelp() + '</small></div></div>') +
    '<div class="set"><div>学新词时连读例句<small>读完单词接着读例句，整句的语调比单个词自然</small></div>' +
    '<input type="checkbox" data-set="readEx"' + (S.settings.readEx ? ' checked' : '') + ' style="width:20px;height:20px"></div>' +
    '<div class="set"><div>试听当前发音<small>' + (usingRec() ? '录制语音' : voice ? esc(voice.name) : '暂无可用语音') + '</small></div>' +
    '<button class="btn" type="button" data-act="testVoice">试听</button></div></div>' +

    (usingRec() ? '' : '<div class="card"><h2>想要更自然的发音</h2>' +
    '<p class="muted">发音用的是设备自带的语音，音质由设备决定。下面的办法可以换成更好的：</p><ul class="steps">' +
    '<li><b>iPhone：</b>设置 → 辅助功能 → 朗读内容 → 声音 → 印度尼西亚文 → 点语音名字 → 下载“优化音质”版本。' +
    '下载后把本应用从后台彻底划掉再打开，回到这里在“发音人”里选它。' +
    '<span class="muted">部分 iOS 版本不向网页开放高音质语音；如果下载后列表里仍然没有，说明你的系统不支持。</span></li>' +
    '<li><b>电脑：</b>用 <b>Edge</b> 浏览器打开，它自带 Microsoft Gadis／Ardi 神经网络语音，是系统语音里最自然的。</li></ul></div>') +

    '<div class="card"><h2>学习数据</h2><p class="muted">已学 ' + st.learned + ' 词 · 已掌握 ' + st.mature + ' 词 · 已斩 ' + st.known + ' 词 · 累计答题 ' + tot + ' 次' +
    (tot ? ' · 总正确率 ' + Math.round(cor / tot * 100) + '%' : '') + '</p>' +
    '<p class="muted">进度保存在这台电脑的这个浏览器里。换电脑、换浏览器或清除浏览数据前，请先导出备份。</p>' +
    '<div class="row"><button class="btn" data-act="export">导出进度备份</button><button class="btn" data-act="import">导入备份</button>' +
    '<button class="btn danger" data-act="reset">清空全部进度</button></div>' +
    '<input type="file" id="imp" accept="application/json,.json" hidden></div>' +

    '<div class="card"><h2>装到 iPhone 上当 App 用</h2>' +
    (STANDALONE ? '<p><b>已经以 App 形态运行。</b>内容已存到手机里，断网也能学。</p>' :
      '<ol class="steps"><li>在 iPhone 上用 <b>Safari</b> 打开本页的网址（必须是 Safari）。</li>' +
      '<li>点底部中间的<b>分享按钮</b>（方框加向上箭头）。</li>' +
      '<li>往下滑，选<b>“添加到主屏幕”</b>，再点“添加”。</li>' +
      '<li>以后从主屏幕的图标打开：全屏、没有地址栏、断网也能学。</li></ol>') +
    '<p class="muted">进度只存在这台设备的这个 App 里，不会自动同步到别的设备。换手机前请先“导出进度备份”。</p></div>';
}

/* =====================================================================
   事件
   ===================================================================== */
var ACT = {
  start: function () { startSession('normal'); },
  extra: function () { startSession('extra'); },
  cram: function () { startSession('cram'); },
  home: function () { ses = null; go('home'); },
  next: function () { next(); },
  quit: function () {
    clearTimeout(advTimer);
    if (ses && ses.asked > 0) { ses.finished = true; render(); } else { ses = null; go('home'); }
  },
  say: function (el) { speak(el.getAttribute('data-t')); },
  pick: function (el) {
    if (!ses || ses.answered) return;
    var i = +el.getAttribute('data-i'), t = curTask();
    onAnswer(t.opts[i] === t.w, { chosen: i });
  },
  giveup: function () { onAnswer(false); },
  skill: function () { killCurrent(); },
  testVoice: function () { speak('terima kasih', 'Terima kasih banyak.'); },
  dlAudio: function () { downloadAll(); },
  hideInstall: function () { S.settings.hideInstall = true; save(); render(); },
  // 词表：点一下就地展开／收起，显示中文和例句
  toggle: function (el) {
    var i = +el.getAttribute('data-i'), row = el.parentNode, w = WORDS[i], open = !row.querySelector('.more');
    row.outerHTML = rowHtml(w, open, el.getAttribute('data-z') === '1');
    if (open && S.settings.autoPlay) speak(w.id);
  },
  // 词表：斩掉／恢复
  kill: function (el) {
    var i = +el.getAttribute('data-i'), w = WORDS[i];
    if (S.known[w.id]) { delete S.known[w.id]; toast('已恢复：' + w.id + '，会重新进入学习'); }
    else { S.known[w.id] = 1; delete S.cards[w.id]; toast('已斩：' + w.id + '，不会再出现'); }
    save();
    var row = document.getElementById('w' + i);
    if (row) row.outerHTML = rowHtml(w, true, el.getAttribute('data-z') === '1');
    var cnt = document.getElementById('lcount');
    if (cnt) cnt.textContent = listCount();
  },
  export: function () {
    var a = document.createElement('a'), d = new Date();
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S)], { type: 'application/json' }));
    a.download = 'indo1000-进度-' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    toast('已导出备份文件');
  },
  import: function () { document.getElementById('imp').click(); },
  reset: function () {
    if (!confirm('确定清空全部学习进度和笔记吗？此操作无法撤销。建议先导出备份。')) return;
    S = defaults(); save(); ses = null; render(); toast('已清空');
  }
};

document.addEventListener('click', function (e) {
  var nav = e.target.closest && e.target.closest('[data-nav]');
  if (nav) {
    clearTimeout(advTimer);
    if (view === 'study') ses = null;
    go(nav.getAttribute('data-nav'));
    return;
  }
  var el = e.target.closest && e.target.closest('[data-act]');
  if (!el) return;
  var fn = ACT[el.getAttribute('data-act')];
  if (fn) { if (el.classList.contains('spk')) e.stopPropagation(); fn(el); }
});

document.addEventListener('submit', function (e) {
  if (e.target.getAttribute('data-form') === 'type') {
    e.preventDefault();
    if (ses && ses.answered) return;
    checkTyped(document.getElementById('ans').value);
  }
});

document.addEventListener('input', function (e) {
  var el = e.target;
  if (el.hasAttribute('data-note')) {
    var id = el.getAttribute('data-note');
    if (el.value.trim()) S.notes[id] = el.value; else delete S.notes[id];
    save();
  } else if (el.id === 'bq') {
    browse.q = el.value; fillBrowse();
  } else if (el.getAttribute('data-set') === 'rate') {
    S.settings.rate = +el.value; save();
    el.parentNode.querySelector('small').textContent = '当前 ' + shownRate() + ' 倍';
  }
});

document.addEventListener('change', function (e) {
  var el = e.target, k = el.getAttribute && el.getAttribute('data-set');
  if (k === 'newPerDay') { S.settings.newPerDay = +el.value; save(); toast('已保存'); }
  else if (k === 'autoPlay') { S.settings.autoPlay = el.checked; save(); }
  else if (k === 'readEx') { S.settings.readEx = el.checked; save(); }
  else if (k === 'useRec') { S.settings.useRec = el.value === '1'; save(); stopSpeaking(); render(); }
  else if (k === 'voiceURI') {
    S.settings.voiceURI = el.value; save(); loadVoices(); render();
    speak('Selamat pagi, apa kabar?');
  }
  else if (el.id === 'showzh') { browse.showZh = el.checked; fillBrowse(); }
  else if (el.id === 'jump' && el.value !== '') {
    var target = document.getElementById('u' + el.value);
    if (target) target.scrollIntoView({ block: 'start' });
    el.value = '';
  }
  else if (el.id === 'imp' && el.files && el.files[0]) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var s = JSON.parse(fr.result);
        if (!s || typeof s.cards !== 'object') throw 0;
        if (!confirm('导入会覆盖当前进度，确定吗？')) return;
        localStorage.setItem(KEY, JSON.stringify(s));
        S = load(); ses = null; render(); toast('导入成功');
      } catch (err) { toast('文件格式不对，导入失败'); }
    };
    fr.readAsText(el.files[0]);
  }
});

document.addEventListener('keydown', function (e) {
  if (view !== 'study' || !ses || ses.finished || e.ctrlKey || e.metaKey || e.altKey) return;
  var tag = e.target.tagName || '', t = curTask();
  if (e.key === 'Enter') {
    if (tag === 'TEXTAREA') return;
    if (ses.answered || t.kind === 'intro') { e.preventDefault(); next(); }
    return;
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!ses.answered && t.opts && /^[1-4]$/.test(e.key)) {
    var i = +e.key - 1;
    if (t.opts[i]) onAnswer(t.opts[i] === t.w, { chosen: i });
  } else if (e.key === ' ') {
    e.preventDefault();
    if (ses.answered || t.kind === 'intro' || t.kind === 'id2zh' || t.kind === 'listen') speak(t.w.id);
  } else if (e.key === 'x' || e.key === 'X') {
    killCurrent();
  }
});

/* 手机 App 形态：注册离线缓存，并请求系统不要清掉学习进度。
   本机开发地址（localhost）不启用缓存，方便改完立刻看到效果。 */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}
try {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
} catch (e) {}

/* 供自测与调试使用 */
window.__indo = { WORDS: WORDS, UNITS: UNITS, rankVoices: rankVoices, voiceLabel: voiceLabel, recUrl: recUrl, pack: function () { return PACK; }, state: function () { return S; }, session: function () { return ses; } };

render();
})();
