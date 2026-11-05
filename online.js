/* ============================================================
   纸牌屋 · 联机版客户端
   纯 JS、无模块、无外部依赖，file:// 与 http(s) 均可运行。
   服务器（room_server.py）权威：洗牌发牌、判定、结算。
   视觉零件（卡牌/补间/音效/粒子）移植自单机版 game.js。
   ============================================================ */
(function () {
'use strict';

/* ==================== 错误角标（最优先，保证截图能拍到报错） ==================== */
var ERRS = [];
function pushErr(msg) {
  ERRS.push('' + msg);
  var b = document.getElementById('err-badge');
  if (b) {
    b.style.display = 'block';
    b.textContent = '⚠ 脚本错误 ×' + ERRS.length + '\n' + ERRS[ERRS.length - 1].slice(0, 300);
  }
}
window.addEventListener('error', function (e) {
  pushErr((e.message || 'unknown') + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : ''));
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason;
  pushErr('promise: ' + ((r && r.message) || r || 'unknown'));
});

/* ==================== 基础工具 ==================== */
function $(id) { return document.getElementById(id); }
function el(tag, cls) { var d = document.createElement(tag); if (cls) d.className = cls; return d; }
function anchorRect(e) {
  var r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left };
}
var store = {
  get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { } },
  del: function (k) { try { window.localStorage.removeItem(k); } catch (e) { } }
};
function parseQuery() {
  var out = {};
  try {
    var s = window.location.search;
    if (s && s.length > 1) {
      s.substring(1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0]) out[decodeURIComponent(p[0])] = p[1] != null ? decodeURIComponent(p[1]) : '';
      });
    }
  } catch (e) { }
  return out;
}
var Q = parseQuery();

/* ==================== 随机（仅用于特效/布局抖动，牌面由服务器发） ==================== */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var rngFx = mulberry32((Date.now() % 2147483647) | 0);
function pick(arr) { return arr[Math.floor(rngFx() * arr.length)]; }

/* ==================== 时钟 / 调度 / 补间（移植 game.js） ==================== */
var Clock = {
  t: 0, last: 0, running: false, rafId: 0,
  start: function () {
    if (this.running) return;
    this.running = true;
    this.last = (typeof performance !== 'undefined') ? performance.now() : 0;
    var self = this;
    var fr = function (ts) {
      if (!self.running) return;
      var dt = Math.min(100, ts - self.last);
      self.last = ts;
      try { tickAll(dt); } catch (e) {
        pushErr('tick: ' + ((e && e.message) || e) + ' | ' + ((e && e.stack) || '').split('\n').slice(0, 3).join(' <- '));
      }
      self.rafId = requestAnimationFrame(fr);
    };
    this.rafId = requestAnimationFrame(fr);
  }
};
var Scheduler = {
  q: [],
  add: function (at, fn) {
    var q = this.q, i = q.length;
    while (i > 0 && q[i - 1].at > at) { q[i] = q[i - 1]; i--; }
    q[i] = { at: at, fn: fn };
  },
  run: function () {
    while (this.q.length && this.q[0].at <= Clock.t) { this.q.shift().fn(); }
  }
};
function wait(ms) { return new Promise(function (res) { Scheduler.add(Clock.t + ms, res); }); }
function easeOut(k) { return 1 - Math.pow(1 - k, 3); }
function easeInOut(k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; }
function easeOutBack(k) { var c1 = 1.35, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); }
var Tweens = {
  list: [],
  run: function () {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var tw = this.list[i];
      if (Clock.t < tw.t0) continue;
      try {
        var k = (Clock.t - tw.t0) / tw.dur;
        if (k >= 1) k = 1;
        var e = tw.ease(k);
        for (var key in tw.to) tw.obj[key] = tw.from[key] + (tw.to[key] - tw.from[key]) * e;
        if (tw.onU) tw.onU(tw.obj);
        if (k >= 1) { this.list.splice(i, 1); if (tw.onD) tw.onD(); tw.res(); }
      } catch (err) {
        /* 出错补间立即丢弃，防止反复抛错卡死主循环 */
        this.list.splice(i, 1);
        pushErr('tween: ' + ((err && err.message) || err));
        try { tw.res(); } catch (e2) { }
      }
    }
  },
  killOverlap: function (obj, to) {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var tw = this.list[i];
      if (tw.obj !== obj) continue;
      for (var key in to) if (tw.to.hasOwnProperty(key)) { this.list.splice(i, 1); break; }
    }
  },
  killObj: function (obj) {
    for (var i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].obj !== obj) continue;
      /* 必须 resolve，否则依赖 .then 的编排链会永久悬空 */
      var tw = this.list.splice(i, 1)[0];
      try { tw.res(); } catch (e) { }
    }
  }
};
function animate(obj, to, opt) {
  opt = opt || {};
  Tweens.killOverlap(obj, to);
  return new Promise(function (res) {
    var from = {};
    for (var k in to) from[k] = obj[k];
    Tweens.list.push({
      t0: Clock.t + (opt.delay || 0),
      dur: Math.max(1, opt.dur || 300),
      ease: opt.ease || easeOut,
      from: from, to: to, obj: obj,
      onU: opt.onU || null, onD: opt.onD || null, res: res
    });
  });
}
function tickAll(dt) {
  Clock.t += dt;
  Scheduler.run();
  Tweens.run();
  FX.tick(dt);
}

/* ==================== 音效（100% WebAudio 程序化，移植 game.js） ==================== */
var SFX = {
  ctx: null, master: null, muted: false, noiseBuf: null,
  init: function () {
    if (this.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      var len = this.ctx.sampleRate;
      var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = rngFx() * 2 - 1;
      this.noiseBuf = buf;
    } catch (e) { this.ctx = null; }
  },
  resume: function () { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  ok: function () { return this.ctx && !this.muted; },
  env: function (g, t0, a, peak, dur) {
    var p = g.gain;
    p.setValueAtTime(0.0001, t0);
    p.linearRampToValueAtTime(peak, t0 + a);
    p.exponentialRampToValueAtTime(0.0001, t0 + dur);
  },
  tone: function (f0, f1, dur, type, vol, when) {
    if (!this.ok()) return;
    try {
      var t0 = this.ctx.currentTime + (when || 0);
      var o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(Math.max(1, f0), t0);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
      var g = this.ctx.createGain();
      this.env(g, t0, 0.008, vol, dur);
      o.connect(g); g.connect(this.master);
      o.start(t0); o.stop(t0 + dur + 0.05);
    } catch (e) { }
  },
  noise: function (dur, fType, f0, f1, vol, when) {
    if (!this.ok() || !this.noiseBuf) return;
    try {
      var t0 = this.ctx.currentTime + (when || 0);
      var s = this.ctx.createBufferSource();
      s.buffer = this.noiseBuf; s.loop = true;
      var f = this.ctx.createBiquadFilter();
      f.type = fType;
      f.frequency.setValueAtTime(Math.max(10, f0), t0);
      if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t0 + dur);
      var g = this.ctx.createGain();
      this.env(g, t0, 0.006, vol, dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      s.start(t0); s.stop(t0 + dur + 0.05);
    } catch (e) { }
  },
  whoosh: function () { this.noise(0.16, 'bandpass', 500, 2400, 0.45); },
  flip: function () { this.noise(0.06, 'highpass', 2600, 3200, 0.32); this.tone(750, 260, 0.06, 'square', 0.1); },
  chip: function () { var f = 2400 + rngFx() * 800; this.tone(f, f, 0.07, 'sine', 0.35); this.tone(f * 1.5, f * 1.5, 0.06, 'sine', 0.2, 0.02); },
  thud: function () { this.tone(150, 42, 0.3, 'sine', 0.75); this.noise(0.22, 'lowpass', 380, 110, 0.35); },
  chord: function () {
    var fs = [523.25, 659.25, 783.99, 1046.5];
    for (var i = 0; i < fs.length; i++) this.tone(fs[i], fs[i], 0.85, 'triangle', 0.2, i * 0.07);
    this.tone(261.6, 261.6, 0.9, 'sine', 0.18, 0);
  },
  heart: function () {
    this.tone(68, 58, 0.14, 'sine', 0.85, 0);
    this.tone(66, 52, 0.14, 'sine', 0.75, 0.2);
    this.tone(180, 920, 0.55, 'sawtooth', 0.14, 0.34);
    this.noise(0.5, 'lowpass', 300, 1500, 0.1, 0.34);
  },
  select: function () { this.tone(520, 760, 0.05, 'triangle', 0.22); },
  bubble: function () { this.tone(300, 540, 0.09, 'sine', 0.28); }
};

/* ==================== 粒子画布（移植 game.js） ==================== */
var GOLDS = ['#ffd76a', '#f5b942', '#fff3c4', '#e8a02a', '#ffffff'];
var REDS = ['#e0455a', '#a51f30', '#ff9a7a', '#7a1220'];
var SPARKS = ['#fff3c4', '#ffd76a', '#ffffff'];
var EMBERS = ['#ff9a7a', '#ff6a3d', '#ffc46e', '#e0455a'];
var STARS = ['#ffffff', '#fff3c4', '#ffd76a'];
var CONFETTI = ['#ffd76a', '#f0c75e', '#e0455a', '#7ab8ff', '#7fe0a8', '#ffffff'];
var FX = {
  cv: null, ctx: null, parts: [], dpr: 1, w: 0, h: 0,
  init: function () {
    this.cv = $('fx');
    if (!this.cv) return;
    this.ctx = this.cv.getContext('2d');
    this.resize();
  },
  resize: function () {
    if (!this.cv) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.cv.width = Math.round(this.w * this.dpr);
    this.cv.height = Math.round(this.h * this.dpr);
    this.cv.style.width = this.w + 'px';
    this.cv.style.height = this.h + 'px';
    if (this.ctx) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  },
  burst: function (x, y, opt) {
    opt = opt || {};
    var n = opt.n || 26, cols = opt.colors || GOLDS;
    var shape = opt.shape || 'mix';
    for (var i = 0; i < n; i++) {
      var a = rngFx() * Math.PI * 2;
      var sp = (opt.speed || 260) * (0.35 + rngFx() * 0.85);
      this.parts.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (opt.up || 120),
        g: opt.grav != null ? opt.grav : 560,
        life: 0, max: (opt.life || 0.9) * (0.6 + rngFx() * 0.7),
        size: (opt.size || 4) * (0.6 + rngFx() * 0.9),
        c: cols[(rngFx() * cols.length) | 0],
        shape: shape === 'mix' ? (rngFx() < 0.5 ? 'rect' : 'circle') : shape,
        fl: opt.flutter ? rngFx() * 6.28 : 0,
        rot: rngFx() * 6.28, vr: (rngFx() - 0.5) * 10
      });
    }
  },
  tick: function (dt) {
    if (!this.ctx) return;
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.parts.length) return;
    var dts = dt / 1000, alive = [];
    for (var i = 0; i < this.parts.length; i++) {
      var p = this.parts[i];
      p.life += dts;
      if (p.life >= p.max) continue;
      p.vy += p.g * dts;
      p.x += p.vx * dts; p.y += p.vy * dts;
      if (p.fl) p.x += Math.sin(p.life * 7 + p.fl) * 22 * dts;
      p.rot += p.vr * dts;
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
      ctx.fillStyle = p.c;
      if (p.shape === 'star') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size * 0.08, p.size, p.size * 0.16);
        ctx.rotate(Math.PI / 2);
        ctx.fillRect(-p.size / 2, -p.size * 0.08, p.size, p.size * 0.16);
        ctx.restore();
      } else if (p.shape === 'rect') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size / 2, 0, 6.2832);
        ctx.fill();
      }
      alive.push(p);
    }
    this.parts = alive;
    ctx.globalAlpha = 1;
  }
};

/* ==================== 牌（渲染移植 game.js；判定归服务器） ==================== */
var SUITCH = ['♦', '♣', '♥', '♠'];
var RNAMES = ['', '比大', '比小', '十点半', '炸金花'];
function rankChar(r) { return r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : r === 14 ? 'A' : '' + r; }
function cardName(c) { return rankChar(c.rank) + SUITCH[c.suit]; }
var PIPS = {
  2: [[.5, .12], [.5, .88]],
  3: [[.5, .12], [.5, .5], [.5, .88]],
  4: [[.28, .12], [.72, .12], [.28, .88], [.72, .88]],
  5: [[.28, .12], [.72, .12], [.5, .5], [.28, .88], [.72, .88]],
  6: [[.28, .12], [.72, .12], [.28, .5], [.72, .5], [.28, .88], [.72, .88]],
  7: [[.28, .12], [.72, .12], [.5, .31], [.28, .5], [.72, .5], [.28, .88], [.72, .88]],
  8: [[.28, .12], [.72, .12], [.5, .31], [.28, .5], [.72, .5], [.5, .69], [.28, .88], [.72, .88]],
  9: [[.28, .11], [.72, .11], [.28, .37], [.72, .37], [.5, .5], [.28, .63], [.72, .63], [.28, .89], [.72, .89]],
  10: [[.28, .11], [.72, .11], [.5, .28], [.28, .4], [.72, .4], [.28, .6], [.72, .6], [.5, .72], [.28, .89], [.72, .89]]
};
function cmpCardHigh(a, b) { return (a.rank - b.rank) || (a.suit - b.suit); }
function val3(c) { return c.rank === 14 ? 1 : (c.rank >= 11 ? 0.5 : c.rank); }
function fmtTot(t) { return (t % 1 === 0) ? '' + t : t.toFixed(1); }
/* 刻意打输（?auto&lose=1 用，保证拿到翻倍抉择） */
function playToLose(hand, round) {
  if (round === 4) return hand.slice(0, 3);
  var i, j;
  if (round === 1) {
    var mn = hand[0];
    for (i = 1; i < hand.length; i++) if (cmpCardHigh(hand[i], mn) < 0) mn = hand[i];
    return [mn];
  }
  if (round === 2) {
    var mx2 = hand[0];
    for (i = 1; i < hand.length; i++) if (cmpCardHigh(hand[i], mx2) > 0) mx2 = hand[i];
    return [mx2];
  }
  var best = null, bd = -1;
  for (i = 0; i < hand.length; i++) for (j = i + 1; j < hand.length; j++) {
    var a = hand[i], b = hand[j];
    var d = Math.abs(10.5 - (val3(a) + val3(b)));
    if (d > bd) { bd = d; best = [a, b]; }
  }
  return best;
}

var DUMMY_ID = 1;
function mkCardEl(c) {
  var d = el('div', 'card ' + ((c.suit === 0 || c.suit === 2) ? 'suit-r' : 'suit-b'));
  var rc = rankChar(c.rank), sc = SUITCH[c.suit];
  var mid;
  if (c.rank === 14) {
    mid = '<div class="acefield"><div class="ace-ring"></div><span class="ace-big">' + sc + '</span>' +
      '<span class="fl fl-n">' + sc + '</span><span class="fl fl-s">' + sc + '</span>' +
      '<span class="fl fl-e">' + sc + '</span><span class="fl fl-w">' + sc + '</span></div>';
  } else if (c.rank >= 11) {
    mid = '<div class="faceart fa-' + rc + '"><div class="fa-frame"></div>' +
      '<span class="fa-rank">' + rc + '</span><span class="fa-suit">' + sc + '</span></div>';
  } else {
    var pts = PIPS[c.rank], html = '';
    for (var i = 0; i < pts.length; i++) {
      html += '<span class="pip' + (pts[i][1] > 0.5 ? ' inv' : '') + '" style="left:' + (pts[i][0] * 100) + '%;top:' + (pts[i][1] * 100) + '%">' + sc + '</span>';
    }
    mid = '<div class="pipfield' + (c.rank >= 9 ? ' dense' : '') + '">' + html + '</div>';
  }
  d.innerHTML =
    '<div class="face front">' +
    '<div class="corner tl"><span class="cr">' + rc + '</span><span class="cs">' + sc + '</span></div>' +
    mid +
    '<div class="corner br"><span class="cr">' + rc + '</span><span class="cs">' + sc + '</span></div>' +
    '</div>' +
    '<div class="face back"><div class="back-seal">酒</div></div>';
  c.el = d;
  c.p = { x: -200, y: -200, rz: 0, ry: 0, s: 1, o: 1 };
  c.off = { s: 0, h: 0 };
  c.sel = false;
  c.state = 'deck';
  c.tilt = 0;
  $('cardlayer').appendChild(d);
  d.addEventListener('click', function () { onCardTap(c); });
  d.addEventListener('pointerenter', function () {
    if (isSelectableNow(c)) animate(c.off, { h: -12 }, { dur: 200, ease: easeOutBack, onU: function () { applyCard(c); } });
  });
  d.addEventListener('pointerleave', function () {
    animate(c.off, { h: 0 }, { dur: 180, ease: easeOut, onU: function () { applyCard(c); } });
  });
  return c;
}
function applyCard(c) {
  if (!c.el || !c.p) return;
  var p = c.p;
  var x = p.x - L.cw / 2, y = p.y + c.off.s + c.off.h - L.ch / 2;
  c.el.style.transform =
    'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)' +
    ' rotate(' + p.rz.toFixed(2) + 'deg)' +
    ' rotateY(' + p.ry.toFixed(1) + 'deg)' +
    ' scale(' + p.s.toFixed(3) + ')';
  c.el.style.opacity = p.o;
}
function tweenCard(c, to, opt) {
  opt = opt || {};
  var oldU = opt.onU;
  opt.onU = function () { applyCard(c); if (oldU) oldU(); };
  return animate(c.p, to, opt);
}
function destroyCard(c) {
  /* 注意：不要 killObj 这里的补间——孤儿补间会因 applyCard 的空指针防护
     自然空转完成并 resolve；强行 kill 会让 .then 链悬空，后续布局静默丢失 */
  if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el);
  c.el = null;
}
function isSelectableNow(c) {
  return S.phase === 'select' && S.round !== 4 && !S.playedOk && c.state === 'hand' && S.myHand.indexOf(c) >= 0;
}

/* ==================== 布局 ==================== */
var L = { cw: 64, ch: 91, playedS: 0.66, miniS: 0.34, zTop: 10 };
var SLOT_POS = {
  1: [[50, 10]],
  2: [[27, 12], [73, 12]],
  3: [[17, 15], [50, 8], [83, 15]],
  4: [[13, 19], [37, 8], [63, 8], [87, 19]],
  5: [[11, 23], [29, 9], [50, 5], [71, 9], [89, 23]]
};
var PLAYER_COLORS = ['#f0c75e', '#ff7a8a', '#7ab8ff', '#7fe0a8', '#d49aff', '#ffb36e'];
function setCardSize() {
  var vw = window.innerWidth, vh = window.innerHeight;
  var cw = Math.round(Math.min(Math.max(Math.min(vw * 0.155, vh * 0.16), 54), 96));
  var ch = Math.round(cw * 1.42);
  document.documentElement.style.setProperty('--cw', cw + 'px');
  document.documentElement.style.setProperty('--ch', ch + 'px');
  L.cw = cw; L.ch = ch;
}
function fanPos(i, n) {
  var r = $('hand').getBoundingClientRect();
  var cx = r.left + r.width / 2;
  var dx = n > 1 ? Math.min(L.cw * 0.62, (r.width - L.cw * 1.2) / (n - 1)) : 0;
  var spread = Math.min(4.2 * (n - 1), 26);
  var ang = n > 1 ? -spread / 2 + spread * i / (n - 1) : 0;
  return { x: cx + (i - (n - 1) / 2) * dx, y: r.top + r.height * 0.52 + Math.abs(ang) * 1.1, rz: ang };
}
function stackPos(p, i) {
  var a = anchorRect(p.stackEl);
  return { x: a.x + ((i % 3) - 1) * 2, y: a.y - i * 0.9 };
}
function slotCenter(p) {
  return p.isMe ? anchorRect($('human-slot')) : anchorRect(p.slotEl);
}
function slotPos(p, k, total) {
  var c = slotCenter(p);
  var off = total === 1 ? [0] : total === 2 ? [-0.36, 0.36] : [-0.52, 0, 0.52];
  var rz = total === 3 ? [-8, 0, 8][k] : total === 2 ? [-4, 4][k] : 0;
  return { x: c.x + off[k] * L.cw, y: c.y, rz: rz };
}
function setSlotFrames(rd) {
  if (!rd) return;
  var n = rd === 3 ? 2 : rd === 4 ? 3 : 1;
  var span = n === 1 ? 0 : n === 2 ? 0.72 : 1.04;
  var w = Math.round(L.cw * (span + L.playedS) + 24);
  var i, els = [];
  S.players.forEach(function (p) { if (p.slotEl) els.push(p.slotEl); });
  var hs = $('human-slot');
  if (hs) els.push(hs);
  for (i = 0; i < els.length; i++) {
    if (els[i].style && els[i].style.setProperty) els[i].style.setProperty('--slotw', w + 'px');
  }
}
function layoutHand(anim) {
  var hs = S.myHand, i;
  for (i = 0; i < hs.length; i++) {
    var c = hs[i];
    var fp = fanPos(i, hs.length);
    var to = { x: fp.x, y: fp.y, rz: fp.rz + c.tilt };
    if (anim) tweenCard(c, to, { dur: 260, ease: easeOut });
    else { c.p.x = to.x; c.p.y = to.y; c.p.rz = to.rz; applyCard(c); }
  }
}
function relayoutAllInstant() {
  if (S.view !== 'table' || !S.players.length) return;
  setSlotFrames(S.round);
  layoutHand(false);
  S.players.forEach(function (p) {
    if (p.isMe) {
      S.mySlotCards.forEach(function (c, k) {
        var t = slotPos(p, k, S.mySlotCards.length);
        c.p.x = t.x; c.p.y = t.y; c.p.rz = t.rz; applyCard(c);
      });
    } else {
      p.stackCards.forEach(function (c, i) {
        var t = stackPos(p, i);
        c.p.x = t.x; c.p.y = t.y; applyCard(c);
      });
      p.slotBacks.forEach(function (c, k) {
        var t = slotPos(p, k, Math.max(S.need, p.slotBacks.length));
        c.p.x = t.x; c.p.y = t.y; c.p.rz = t.rz; applyCard(c);
      });
      p.playedEls.forEach(function (c, k) {
        var t = slotPos(p, k, p.playedEls.length);
        c.p.x = t.x; c.p.y = t.y; c.p.rz = t.rz; applyCard(c);
      });
    }
    positionTag(p);
  });
}

/* ==================== 应用状态 ==================== */
var S = {
  view: 'lobby',            // lobby | room | table
  ws: null, wsOpen: false, intentionalClose: false,
  session: null,            // {room, token, pid, name}
  pendingName: '',
  myPid: null, isHost: false, roomMsg: null,
  players: [], me: null,
  myHand: [], mySlotCards: [], selected: [],
  round: 0, base: 1, need: 1,
  phase: 'idle',            // idle|dealing|select|waiting|reveal|result|double|final
  playedOk: false, waiting: [],
  dealtDone: false, dblAnswered: false, dblTickAt: 0,
  autoPlayedAt: -1, reconnects: 0
};
var HINTS = [
  '',
  '第 1 轮 · <b>比大</b>：选 1 张，最大者赢，最小者罚酒',
  '第 2 轮 · <b>比小</b>：选 1 张，最小者赢，最大者罚酒',
  '第 3 轮 · <b>十点半</b>：选 2 张凑 10.5（A=1，J/Q/K=半张）',
  '第 4 轮 · <b>炸金花</b>：最后 3 张已锁定，直接亮牌！'
];
function byPid(pid) {
  for (var i = 0; i < S.players.length; i++) if (S.players[i].pid === pid) return S.players[i];
  return null;
}
function pname(p) { return p ? (p.isMe ? '你' : p.name) : '?'; }

/* ==================== 调试 HUD ==================== */
var DBG = !!(Q.debug || Q.auto);
function dbg(extra) {
  if (!DBG) return;
  var d = $('dbg');
  if (!d) return;
  d.style.display = 'block';
  d.textContent = 'view=' + S.view + ' phase=' + S.phase + ' rd=' + S.round + ' base=' + S.base +
    ' ws=' + (S.wsOpen ? 'on' : 'off') + ' t=' + Math.round(Clock.t / 1000) + 's' + (extra ? ' | ' + extra : '');
}

/* ==================== 吐司 ==================== */
function toast(msg, type, ms) {
  var w = $('toast-wrap');
  if (!w) return;
  var t = el('div', 'toast' + (type ? ' ' + type : ''));
  t.textContent = msg;
  w.appendChild(t);
  while (w.children.length > 4) w.removeChild(w.firstChild);
  setTimeout(function () {
    t.classList.add('out');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 350);
  }, ms || 3000);
}

/* ==================== 计分板 / 顶栏（移植 game.js） ==================== */
function drinksText(n, cap) {
  n = Math.round(n);
  if (n <= 0) return '🍺×0';
  if (n <= (cap || 3)) { var s = ''; for (var i = 0; i < n; i++) s += '🍺'; return s; }
  return '🍺×' + n;
}
function buildChips() {
  var box = $('chips');
  box.innerHTML = '';
  S.players.forEach(function (p) {
    var c = el('div', 'chip' + (p.isMe ? ' me' : ''));
    c.style.borderColor = p.color;
    c.innerHTML = '<div class="chip-avatar" style="border-color:' + p.color + '">' + p.emoji + '</div>' +
      '<div class="chip-name">' + pname(p) + '</div>' +
      '<div class="chip-drinks">🍺×0</div>';
    box.appendChild(c);
    p.chipEl = c;
    p.chipDrinksEl = c.getElementsByClassName('chip-drinks')[0];
  });
}
function renderBeerTray(p) {
  var tray = p.trayEl;
  if (!tray) return;
  var n = p.drinks, html = '', i;
  if (n <= 0) html = '';
  else if (n <= 3) { for (i = 0; i < n; i++) html += '<i class="bg g' + i + '">🍺</i>'; }
  else html = '<span class="btower"><i class="bg g0">🍺</i><i class="bg g1">🍺</i><i class="bg g2">🍺</i></span><b class="beer-n">×' + n + '</b>';
  tray.innerHTML = html;
}
function rollDrinks(p, from) {
  renderBeerTray(p);
  var pr = { v: from };
  animate(pr, { v: p.drinks }, {
    dur: 520, ease: easeOut,
    onU: function () { if (p.chipDrinksEl) p.chipDrinksEl.textContent = drinksText(pr.v, 3); }
  });
  var chip = p.chipEl;
  if (chip) {
    var ps = { s: 1 };
    animate(ps, { s: 1.3 }, {
      dur: 160, ease: easeOut,
      onU: function () { chip.style.transform = 'scale(' + ps.s.toFixed(3) + ')'; },
      onD: function () {
        var ps2 = { s: 1.3 };
        animate(ps2, { s: 1 }, {
          dur: 240, ease: easeOutBack,
          onU: function () { chip.style.transform = 'scale(' + ps2.s.toFixed(3) + ')'; }
        });
      }
    });
  }
  var gained = p.drinks - from;
  if (gained > 0 && p.chipEl) {
    var r = anchorRect(p.chipEl);
    var f = el('div', 'dmg-float');
    f.textContent = '+' + gained + ' 🍺';
    f.style.left = r.x + 'px';
    f.style.top = (r.top + r.h + 30) + 'px';
    f.style.opacity = '0';
    $('cardlayer').appendChild(f);
    var pf = { v: 0 };
    animate(pf, { v: 1 }, {
      dur: 950, ease: easeOut,
      onU: function () {
        f.style.opacity = '' + Math.max(0, 1 - pf.v * pf.v);
        f.style.transform = 'translate(-50%,-50%) translateY(' + (-30 * pf.v).toFixed(1) + 'px)';
      },
      onD: function () { if (f.parentNode) f.parentNode.removeChild(f); }
    });
  }
  Scheduler.add(Clock.t + 140, function () { SFX.chip(); });
  Scheduler.add(Clock.t + 300, function () { SFX.chip(); });
}
function updateRoundBadge(init) {
  $('round-num').textContent = init ? '-' : '' + S.round;
  $('round-name').textContent = init ? '酒局' : RNAMES[S.round];
  $('round-dots').className = init ? '' : 'd' + S.round;
}
function updateBetVisual(pop) {
  var bv = $('bet-visual');
  if (!bv) return;
  var lv = Math.max(1, Math.min(4, Math.round(Math.log(S.base) / Math.LN2) + 1));
  var t = bv.getElementsByClassName('bet-tower')[0];
  if (t) {
    var html = '';
    for (var i = 0; i < lv; i++) html += '<i style="bottom:' + (i * 8) + 'px"></i>';
    t.innerHTML = html;
  }
  var lb = $('bet-label');
  if (lb) lb.textContent = '酒注 ×' + S.base;
  if (pop && t) {
    var pr = { s: 1 };
    animate(pr, { s: 1.25 }, {
      dur: 160, ease: easeOut,
      onU: function () { t.style.transform = 'scale(' + pr.s.toFixed(3) + ')'; },
      onD: function () {
        var pr2 = { s: 1.25 };
        animate(pr2, { s: 1 }, {
          dur: 260, ease: easeOutBack,
          onU: function () { t.style.transform = 'scale(' + pr2.s.toFixed(3) + ')'; }
        });
      }
    });
    var r = anchorRect(bv);
    FX.burst(r.x, r.y - 8, { n: 18, colors: GOLDS, speed: 200, up: 130, grav: 480, size: 3.5, life: 0.8 });
  }
}
function updateBaseBadge(pop) {
  $('base-num').textContent = '' + S.base;
  updateBetVisual(pop);
  if (pop) {
    var b = $('round-badge'), pr = { s: 1 };
    animate(pr, { s: 1.35 }, {
      dur: 150, ease: easeOut,
      onU: function () { b.style.transform = 'scale(' + pr.s.toFixed(3) + ')'; },
      onD: function () {
        var pr2 = { s: 1.35 };
        animate(pr2, { s: 1 }, {
          dur: 220, ease: easeOutBack,
          onU: function () { b.style.transform = 'scale(' + pr2.s.toFixed(3) + ')'; }
        });
      }
    });
  }
}

/* ==================== 面板 / 标签（移植 game.js） ==================== */
function buildPanels() {
  var box = $('panels');
  box.innerHTML = '';
  var others = S.players.filter(function (p) { return !p.isMe; });
  var pos = SLOT_POS[others.length] || SLOT_POS[3];
  others.forEach(function (p, i) {
    var d = el('div', 'panel' + (pos[i][0] > 62 ? ' flip' : ''));
    d.style.left = pos[i][0] + '%';
    d.style.top = pos[i][1] + '%';
    d.innerHTML =
      '<div class="avatar" style="border-color:' + p.color + '">' + p.emoji + '</div>' +
      '<div class="pname">' + p.name + '</div>' +
      '<div>' + (p.tag ? '<span class="ptag ' + p.pers + '">' + p.tag + '</span>' : '') + '</div>' +
      '<div class="beer-tray"></div>' +
      '<div class="stack-anchor"></div>' +
      '<div class="stack-count"></div>' +
      '<div class="slot-anchor"></div>';
    box.appendChild(d);
    p.panel = d;
    p.avatarEl = d.getElementsByClassName('avatar')[0];
    p.stackEl = d.getElementsByClassName('stack-anchor')[0];
    p.stackCountEl = d.getElementsByClassName('stack-count')[0];
    p.slotEl = d.getElementsByClassName('slot-anchor')[0];
    p.trayEl = d.getElementsByClassName('beer-tray')[0];
    renderBeerTray(p);
  });
}
function updateStackCount(p) {
  if (p.isMe || !p.stackCountEl) return;
  p.stackCountEl.textContent = p.stackCards.length > 0 ? '×' + p.stackCards.length : '';
}
function positionTag(p) {
  if (!p.tagEl) return;
  var sc = (p.playedEls && p.playedEls.length) ? { x: p.playedEls[0].p.x, y: p.playedEls[0].p.y } : slotCenter(p);
  p.tagEl.style.left = sc.x + 'px';
  p.tagEl.style.top = (sc.y - L.ch * L.playedS * 0.78) + 'px';
}
function showTag(p, text) {
  var t = p.tagEl;
  if (!t) {
    t = el('div', 'tag-label');
    t.style.opacity = '0';
    $('cardlayer').appendChild(t);
    p.tagEl = t;
  }
  t.textContent = text;
  positionTag(p);
  t._o = { v: parseFloat(t.style.opacity) || 0 };
  animate(t._o, { v: 1 }, { dur: 200, ease: easeOut, onU: function () { t.style.opacity = t._o.v; } });
}
function fadeTag(p) {
  var t = p.tagEl;
  if (!t) return;
  t._o = { v: parseFloat(t.style.opacity) || 0 };
  animate(t._o, { v: 0 }, { dur: 240, ease: easeOut, onU: function () { t.style.opacity = t._o.v; } });
}

/* ==================== 横幅 / 聚光 / 闪光（移植 game.js） ==================== */
function showBanner(title, subHtml) {
  var b = $('banner');
  $('b-title').textContent = title;
  $('b-sub').innerHTML = subHtml;
  b.classList.remove('hidden');
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
}
function hideBanner() {
  $('banner').classList.add('hidden');
  $('banner').classList.remove('pop');
}
function showSpot(x, y) {
  var s = S.spotEl;
  if (!s) {
    s = el('div', 'spot-pool');
    s.style.opacity = '0';
    $('table').appendChild(s);
    S.spotEl = s;
  }
  s.style.left = x + 'px';
  s.style.top = y + 'px';
  s._o = { v: parseFloat(s.style.opacity) || 0 };
  animate(s._o, { v: 1 }, { dur: 380, ease: easeOut, onU: function () { s.style.opacity = s._o.v; } });
}
function hideSpot() {
  var s = S.spotEl;
  if (!s) return;
  s._o = { v: parseFloat(s.style.opacity) || 0 };
  animate(s._o, { v: 0 }, { dur: 300, ease: easeOut, onU: function () { s.style.opacity = s._o.v; } });
}
function flashEdge() {
  var f = $('edge-flash');
  if (!f) return;
  var pr = { v: 0 };
  animate(pr, { v: 1 }, {
    dur: 90, ease: easeOut,
    onU: function () { f.style.opacity = pr.v.toFixed(3); },
    onD: function () {
      var pr2 = { v: 1 };
      animate(pr2, { v: 0 }, { dur: 340, ease: easeOut, onU: function () { f.style.opacity = pr2.v.toFixed(3); } });
    }
  });
}

/* ==================== 飞行酒杯（移植 game.js） ==================== */
function bez(a, b, c, t) { var u = 1 - t; return u * u * a + 2 * u * t * b + t * t * c; }
function flyToLoser(loser, idx, last, oldDrinks) {
  var from = anchorRect($('deck-visual'));
  var to = loser.isMe ? anchorRect($('human-slot')) : anchorRect(loser.avatarEl);
  var d = el('div', idx === 1 ? 'fly-beer' : 'fly-chip');
  if (idx === 1) d.textContent = '🍺';
  d.style.left = '0px'; d.style.top = '0px';
  $('cardlayer').appendChild(d);
  var midx = (from.x + to.x) / 2 + (rngFx() - 0.5) * 120;
  var midy = Math.min(from.y, to.y) - 90 - rngFx() * 50;
  var pr = { t: 0 };
  var setP = function (x, y) { d.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)'; };
  setP(from.x, from.y);
  animate(pr, { t: 1 }, {
    dur: 820, delay: idx * 140, ease: easeInOut,
    onU: function () { setP(bez(from.x, midx, to.x, pr.t), bez(from.y, midy, to.y, pr.t)); },
    onD: function () {
      if (d.parentNode) d.parentNode.removeChild(d);
      SFX.chip();
      FX.burst(to.x, to.y, { n: 8, colors: GOLDS, speed: 120, up: 40, grav: 300, size: 3, life: 0.5 });
      if (last) rollDrinks(loser, oldDrinks);
    }
  });
}

/* ==================== 提示与确认按钮 ==================== */
function setHint(html) { $('hint').innerHTML = html; dbg(); }
function updateConfirm() {
  var btn = $('confirm-btn');
  var ok = S.phase === 'select' && !S.playedOk && S.selected.length === S.need;
  btn.disabled = !ok;
  btn.textContent = S.round === 4 ? '🔥 亮牌！' : '确认出牌';
  if (S.phase === 'select' && !S.playedOk) {
    setHint(HINTS[S.round] + '　·　已选 <b>' + S.selected.length + ' / ' + S.need + '</b>');
  }
}
function select(c) {
  c.sel = true;
  c.el.classList.add('sel');
  S.selected.push(c);
  animate(c.off, { s: -26 }, { dur: 200, ease: easeOutBack, onU: function () { applyCard(c); } });
  c.el.style.zIndex = ++L.zTop;
}
function deselect(c) {
  c.sel = false;
  c.el.classList.remove('sel');
  var i = S.selected.indexOf(c);
  if (i >= 0) S.selected.splice(i, 1);
  animate(c.off, { s: 0 }, { dur: 180, ease: easeOut, onU: function () { applyCard(c); } });
}
function onCardTap(c) {
  if (!isSelectableNow(c)) return;
  SFX.init(); SFX.resume(); SFX.select();
  if (c.sel) deselect(c);
  else {
    if (S.selected.length >= S.need) deselect(S.selected[0]);
    select(c);
  }
  updateConfirm();
}

/* ==================== 网络层 ==================== */
function wsUrl() {
  if (Q.ws) return Q.ws;
  /* 生产：GitHub Pages(https) → Render 新加坡机房；本地 file/http → 本机 8765 */
  if (window.location.protocol === 'https:') return 'wss://siju-room-server.onrender.com';
  return 'ws://' + (window.location.hostname || '127.0.0.1') + ':8765';
}
var mq = Promise.resolve();   // 消息串行处理队列
function send(o) {
  if (S.wlog) S.wlog.push({ dir: 'out', m: o });
  if (S.ws && S.wsOpen) {
    try { S.ws.send(JSON.stringify(o)); } catch (e) { }
  }
}
function connect() {
  return new Promise(function (res, rej) {
    var ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { rej(e); return; }
    if (S.ws) { S.intentionalClose = true; try { S.ws.close(); } catch (e) { } }
    S.ws = ws; S.wsOpen = false; S.intentionalClose = false;
    var settled = false;
    var to = setTimeout(function () {
      if (!settled) { settled = true; try { ws.close(); } catch (e) { } rej(new Error('连接超时')); }
    }, 8000);
    ws.onopen = function () {
      if (settled) return;
      settled = true; clearTimeout(to);
      S.wsOpen = true; dbg();
      res();
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (S.wlog) S.wlog.push({ dir: 'in', m: m });
      mq = mq.then(function () { return dispatch(m); }).catch(function (e2) {
        pushErr('dispatch[' + (m && m.a) + ']: ' + ((e2 && e2.message) || e2));
      });
    };
    ws.onclose = function () {
      clearTimeout(to);
      if (S.ws === ws) {
        S.wsOpen = false; dbg();
        if (!S.intentionalClose) onUnexpectedClose();
      }
      if (!settled) { settled = true; rej(new Error('连接被关闭')); }
    };
    ws.onerror = function () { /* onclose 会跟进 */ };
  });
}
function onUnexpectedClose() {
  if (!S.session) return;   // 大厅里断开：无所谓
  if (S.view === 'lobby') return;
  S.reconnects = 0;
  tryReconnect();
}
function tryReconnect() {
  if (!S.session) return;
  S.reconnects++;
  if (S.reconnects > 6) {
    toast('重连失败，请重新加入', 'err');
    clearSession();
    leaveToLobby();
    return;
  }
  toast('连接断开，第 ' + S.reconnects + ' 次重连…', 'err', 2200);
  setTimeout(function () {
    if (!S.session) return;
    connect().then(function () {
      send({ a: 'rejoin', room: S.session.room, token: S.session.token });
    }).catch(function () {
      tryReconnect();
    });
  }, Math.min(1000 * S.reconnects, 6000));
}
function saveSession(room, token, pid, name) {
  S.session = { room: room, token: token, pid: pid, name: name };
  S.myPid = pid;
  store.set('zph_session', JSON.stringify(S.session));
}
function clearSession() {
  S.session = null;
  store.del('zph_session');
}

/* ==================== 视图切换 ==================== */
function showView(v) {
  S.view = v;
  $('view-lobby').classList.toggle('hidden', v !== 'lobby');
  $('view-room').classList.toggle('hidden', v !== 'room');
  $('view-table').classList.toggle('hidden', v !== 'table');
  dbg();
}
function leaveToLobby() {
  teardownTable();
  $('final-modal').classList.add('hidden');
  $('double-modal').classList.add('hidden');
  showView('lobby');
  setLobbyBusy(false);
}
function doLeave() {
  send({ a: 'leave' });
  S.intentionalClose = true;
  if (S.ws) { try { S.ws.close(); } catch (e) { } }
  clearSession();
  leaveToLobby();
}

/* ==================== 大厅 ==================== */
function setLobbyBusy(b) {
  $('btn-create').disabled = b;
  $('btn-join').disabled = b;
}
function lobbyErr(msg) { $('lobby-err').textContent = msg || ''; }
function myName() {
  var n = ($('inp-name').value || '').trim();
  return n || '玩家' + (1 + Math.floor(rngFx() * 99));
}
function doCreate() {
  var name = myName();
  store.set('zph_name', name);
  S.pendingName = name;
  lobbyErr(''); setLobbyBusy(true);
  SFX.init(); SFX.resume();
  connect().then(function () {
    send({ a: 'create', name: name });
  }).catch(function (e) {
    setLobbyBusy(false);
    lobbyErr('连不上服务器：' + e.message);
  });
}
function doJoin() {
  var code = ($('inp-code').value || '').trim().toUpperCase();
  if (code.length !== 4) { lobbyErr('请输入 4 位房间码'); return; }
  var name = myName();
  store.set('zph_name', name);
  S.pendingName = name;
  lobbyErr(''); setLobbyBusy(true);
  SFX.init(); SFX.resume();
  connect().then(function () {
    send({ a: 'join', room: code, name: name });
  }).catch(function (e) {
    setLobbyBusy(false);
    lobbyErr('连不上服务器：' + e.message);
  });
}

/* ==================== 房间页 ==================== */
function shareLink(code) {
  var base = window.location.href.split('?')[0].split('#')[0];
  return base + '?room=' + code;
}
function renderRoom(m) {
  $('room-code').textContent = m.code;
  $('share-link').value = shareLink(m.code);
  $('room-count').textContent = m.players.length;
  var box = $('room-players');
  box.innerHTML = '';
  m.players.forEach(function (p, i) {
    var row = el('div', 'prow' + (p.pid === S.myPid ? ' me' : '') + (p.connected ? '' : ' off'));
    var badges = '';
    if (p.pid === m.host) badges += '<span class="pb host">房主</span>';
    if (p.ai) badges += '<span class="pb ai">AI</span>';
    if (!p.connected) badges += '<span class="pb off">离线</span>';
    if (p.pid === S.myPid) badges += '<span class="pb">我</span>';
    row.innerHTML =
      '<div class="pa" style="border-color:' + PLAYER_COLORS[i % PLAYER_COLORS.length] + '">' + p.emoji + '</div>' +
      '<div class="pn">' + p.name + '</div>' + badges;
    box.appendChild(row);
  });
  var isFinal = m.state === 'final';
  if (S.isHost) {
    $('host-controls').classList.remove('hidden');
    $('btn-start').classList.remove('hidden');
    $('btn-start').textContent = isFinal ? '🍻 再来一局' : '🍻 开 局';
    $('wait-host').textContent = isFinal ? '上局已结束，可以再来一局' : ('人齐了就开局（空位自动补 AI）');
  } else {
    $('host-controls').classList.add('hidden');
    $('btn-start').classList.add('hidden');
    $('wait-host').textContent = isFinal ? '等待房主再来一局…' : '等待房主开局…';
  }
  var hasAi = m.players.some(function (p) { return p.ai; });
  $('btn-rmai').disabled = !hasAi;
  $('btn-addai').disabled = m.players.length >= 6;
}

/* ==================== 牌桌搭建 ==================== */
function buildTable(players, base) {
  S.players = players.map(function (pub, i) {
    return {
      pid: pub.pid, name: pub.name, emoji: pub.emoji, ai: !!pub.ai,
      connected: pub.connected !== false, drinks: pub.drinks || 0,
      handCount: pub.handCount != null ? pub.handCount : 0,
      pers: pub.pers, tag: pub.tag,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      isMe: pub.pid === S.myPid,
      panel: null, avatarEl: null, stackEl: null, stackCountEl: null, slotEl: null, trayEl: null,
      chipEl: null, chipDrinksEl: null, tagEl: null,
      stackCards: [], slotBacks: [], playedEls: []
    };
  });
  S.me = null;
  S.players.forEach(function (p) { if (p.isMe) S.me = p; });
  S.myHand = []; S.mySlotCards = []; S.selected = [];
  S.base = base || 1; S.round = 0;
  S.dealtDone = false; S.playedOk = false;
  buildPanels();
  buildChips();
  if (S.me) { S.me.trayEl = $('human-tray'); renderBeerTray(S.me); }
  S.players.forEach(function (p) { if (!p.isMe) updateStackCount(p); });
  updateRoundBadge(true);
  updateBaseBadge(false);
  setHint('等待发牌……');
  $('confirm-btn').disabled = true;
}
function teardownTable() {
  $('cardlayer').innerHTML = '';
  $('panels').innerHTML = '';
  $('chips').innerHTML = '';
  var spots = document.querySelectorAll('.spot-pool');
  for (var i = 0; i < spots.length; i++) spots[i].parentNode.removeChild(spots[i]);
  S.spotEl = null;
  FX.parts = [];
  if (FX.ctx) FX.ctx.clearRect(0, 0, FX.w, FX.h);
  hideBanner();
  S.players = []; S.me = null;
  S.myHand = []; S.mySlotCards = []; S.selected = [];
  S.round = 0; S.base = 1; S.phase = 'idle';
  S.dealtDone = false; S.playedOk = false; S.waiting = [];
  L.zTop = 10;
}

/* ==================== 发牌 ==================== */
function mkDummy() {
  return mkCardEl({ id: -(DUMMY_ID++), rank: 2, suit: 0 });
}
function dealAnimation(cards) {
  S.phase = 'dealing';
  setHint('发牌中……');
  var da = anchorRect($('deck-visual'));
  /* 我的牌（实体牌面，先扣着发） */
  var mine = cards.map(function (c) {
    var cc = mkCardEl({ id: c.id, rank: c.rank, suit: c.suit });
    cc.owner = 'me';
    return cc;
  });
  /* 对手牌堆（纯背面） */
  var others = S.players.filter(function (p) { return !p.isMe; });
  others.forEach(function (p) {
    for (var i = 0; i < p.handCount; i++) {
      var c = mkDummy();
      c.owner = p;
      p.stackCards.push(c);
    }
  });
  /* 全部摆到牌堆处 */
  var all = [];
  mine.forEach(function (c) { all.push({ c: c, me: true }); });
  others.forEach(function (p) { p.stackCards.forEach(function (c) { all.push({ c: c, me: false, p: p }); }); });
  all.forEach(function (it, i) {
    it.c.p.x = da.x + (i % 4) * 0.6;
    it.c.p.y = da.y - (i % 7) * 0.5;
    it.c.p.s = 0.5;
    applyCard(it.c);
  });
  /* 轮流发牌：按“圈”交错发，先对手后自己（自己牌最后落定翻面） */
  var d = 0, r, i;
  var total = cards.length;
  for (r = 0; r < total; r++) {
    for (i = 0; i < others.length; i++) {
      (function (p, idx) {
        var c = p.stackCards[idx];
        if (!c) return;
        var sp = stackPos(p, idx);
        tweenCard(c, { x: sp.x, y: sp.y, rz: (rngFx() * 2 - 1) * 4, s: L.miniS }, { dur: 430, delay: d, ease: easeOutBack });
        c.el.style.zIndex = ++L.zTop;
        Scheduler.add(Clock.t + d, function () { SFX.whoosh(); });
        updateStackCount(p);
      })(others[i], r);
      d += 42;
    }
    (function (cc, idx) {
      cc.state = 'hand';
      var fp = fanPos(idx, total);
      cc.tilt = (rngFx() * 2 - 1) * 3;
      tweenCard(cc, { x: fp.x, y: fp.y, rz: fp.rz + cc.tilt, s: 1 }, { dur: 430, delay: d, ease: easeOutBack });
      cc.el.style.zIndex = ++L.zTop;
      Scheduler.add(Clock.t + d, function () { SFX.whoosh(); });
    })(mine[r], r);
    d += 42;
  }
  S.myHand = mine;
  return wait(d + 420).then(function () {
    /* 理牌（服务器已按点序排好）+ 翻面 */
    layoutHand(true);
    others.forEach(function (p) { updateStackCount(p); });
    S.myHand.forEach(function (c, k) {
      tweenCard(c, { ry: 180 }, { dur: 380, delay: k * 70, ease: easeInOut });
      Scheduler.add(Clock.t + k * 70, function () { SFX.flip(); });
    });
    return wait(S.myHand.length * 70 + 420);
  }).then(function () {
    S.dealtDone = true;
    S.phase = 'idle';
    setHint('等待第 1 轮开始……');
    dbg();
  });
}
/* 重连：无动画直接铺 */
function instantLayout(cards) {
  var others = S.players.filter(function (p) { return !p.isMe; });
  others.forEach(function (p) {
    for (var i = 0; i < p.handCount; i++) {
      var c = mkDummy();
      c.owner = p;
      var sp = stackPos(p, i);
      c.p.x = sp.x; c.p.y = sp.y; c.p.rz = (rngFx() * 2 - 1) * 4; c.p.s = L.miniS;
      applyCard(c);
      p.stackCards.push(c);
    }
    updateStackCount(p);
  });
  S.myHand = cards.map(function (c) {
    var cc = mkCardEl({ id: c.id, rank: c.rank, suit: c.suit });
    cc.owner = 'me';
    cc.state = 'hand';
    cc.tilt = (rngFx() * 2 - 1) * 3;
    cc.p.ry = 180;
    return cc;
  });
  layoutHand(false);
  S.dealtDone = true;
  S.phase = 'idle';
  setHint('已重连 · 等待当前轮结算……');
}

/* ==================== 出牌（我的操作） ==================== */
function commitSelected() {
  var cards = S.selected.slice();
  S.selected = [];
  S.myHand.forEach(function (c) { c.el.classList.remove('selectable'); });
  cards.forEach(function (c, k) {
    c.state = 'played';
    c.sel = false;
    c.el.classList.remove('sel', 'locked');
    c.off.s = 0; c.off.h = 0;
    var pos = slotPos(S.me, k, cards.length);
    tweenCard(c, { x: pos.x, y: pos.y, rz: pos.rz, ry: 0, s: L.playedS }, { dur: 430, delay: k * 90, ease: easeInOut })
      .then(function () { return tweenCard(c, { s: L.playedS * 1.06 }, { dur: 80, ease: easeOut }); })
      .then(function () { tweenCard(c, { s: L.playedS }, { dur: 130, ease: easeInOut }); });
    c.el.style.zIndex = 100 + k;
    Scheduler.add(Clock.t + k * 90, function () { SFX.whoosh(); });
  });
  S.mySlotCards = cards;
  S.myHand = S.myHand.filter(function (c) { return cards.indexOf(c) < 0; });
  layoutHand(true);
}
function onConfirm() {
  if (S.phase !== 'select' || S.playedOk) return;
  if (S.selected.length !== S.need) return;
  var ids = S.selected.map(function (c) { return c.id; });
  send({ a: 'play', cards: ids });
  S.playedOk = true;
  S.phase = 'waiting';
  $('confirm-btn').disabled = true;
  commitSelected();
  setHint('已暗扣出牌，等待其他玩家……');
  dbg();
}

/* ==================== 对手暗牌（牌背落到槽位） ==================== */
function addSlotBack(p) {
  if (!p || p.isMe) return;
  if (S.phase === 'reveal' || S.phase === 'result' || S.view !== 'table') return;
  if (p.slotBacks.length >= S.need) return;
  var c = p.stackCards.pop();
  if (!c) return;
  var k = p.slotBacks.length;
  var pos = slotPos(p, k, S.need);
  p.slotBacks.push(c);
  c.state = 'played';
  tweenCard(c, { x: pos.x, y: pos.y, rz: pos.rz, ry: 0, s: L.playedS }, { dur: 340, ease: easeOut });
  c.el.style.zIndex = 90 + k;
  SFX.whoosh();
  updateStackCount(p);
}

/* ==================== 亮牌 ==================== */
function revealPlayed(p, cards) {
  var backs = p.slotBacks.length;
  p.slotBacks.forEach(destroyCard);
  p.slotBacks = [];
  /* 槽位里没摆够背面（如重连观战）：从牌堆补扣 */
  var extra = cards.length - backs;
  while (extra-- > 0 && p.stackCards.length) destroyCard(p.stackCards.pop());
  var a = p.stackEl ? anchorRect(p.stackEl) : slotCenter(p);
  p.playedEls = cards.map(function (cd, k) {
    var c = mkCardEl({ id: cd.id, rank: cd.rank, suit: cd.suit });
    c.owner = p;
    c.state = 'played';
    c.p.x = a.x; c.p.y = a.y; c.p.s = L.miniS; c.p.ry = 0;
    applyCard(c);
    var pos = slotPos(p, k, cards.length);
    tweenCard(c, { x: pos.x, y: pos.y, rz: pos.rz, s: L.playedS }, { dur: 260, delay: k * 60, ease: easeOut });
    c.el.style.zIndex = 100 + k;
    return c;
  });
  updateStackCount(p);
}
/* 我的出牌与服务器对账（超时 AI 代打时会不一致） */
function ensureMePlayed(cards) {
  var wantIds = cards.map(function (c) { return c.id; }).sort().join(',');
  var haveIds = S.mySlotCards.map(function (c) { return c.id; }).sort().join(',');
  if (wantIds === haveIds && S.mySlotCards.length) return S.mySlotCards;
  /* 不一致：以服务器为准重建 */
  S.mySlotCards.forEach(destroyCard);
  var out = [];
  cards.forEach(function (cd, k) {
    var found = null;
    for (var i = 0; i < S.myHand.length; i++) {
      if (S.myHand[i].id === cd.id) { found = S.myHand.splice(i, 1)[0]; break; }
    }
    var c = found || mkCardEl({ id: cd.id, rank: cd.rank, suit: cd.suit });
    c.state = 'played';
    c.sel = false;
    if (c.el) c.el.classList.remove('sel', 'locked');
    c.off.s = 0; c.off.h = 0;
    if (!found) {
      var da = anchorRect($('deck-visual'));
      c.p.x = da.x; c.p.y = da.y; c.p.s = 0.5; c.p.ry = 0;
      applyCard(c);
    }
    var pos = slotPos(S.me, k, cards.length);
    tweenCard(c, { x: pos.x, y: pos.y, rz: pos.rz, ry: 0, s: L.playedS }, { dur: 300, delay: k * 60, ease: easeOut });
    c.el.style.zIndex = 100 + k;
    out.push(c);
  });
  S.mySlotCards = out;
  layoutHand(true);
  return out;
}
function cleanupRound() {
  var dis = anchorRect($('discard-visual'));
  hideSpot();
  S.players.forEach(function (p) {
    p.slotBacks.forEach(destroyCard);
    p.slotBacks = [];
    p.playedEls.forEach(function (c) {
      tweenCard(c, {
        x: dis.x + (rngFx() - 0.5) * 14, y: dis.y + (rngFx() - 0.5) * 14,
        rz: (rngFx() - 0.5) * 40, s: 0.4, o: 0.22
      }, { dur: 420, ease: easeInOut });
    });
    Scheduler.add(Clock.t + 460, function () {
      p.playedEls.forEach(destroyCard);
      p.playedEls = [];
    });
    fadeTag(p);
    if (p.panel) p.panel.classList.remove('win-flash', 'lose-flash', 'turn');
    if (p.chipEl) p.chipEl.classList.remove('win-flash', 'lose-flash');
  });
  S.mySlotCards.forEach(function (c) {
    tweenCard(c, {
      x: dis.x + (rngFx() - 0.5) * 14, y: dis.y + (rngFx() - 0.5) * 14,
      rz: (rngFx() - 0.5) * 40, s: 0.4, o: 0.22
    }, { dur: 420, ease: easeInOut });
  });
  var oldMine = S.mySlotCards;
  Scheduler.add(Clock.t + 460, function () { oldMine.forEach(destroyCard); });
  S.mySlotCards = [];
  return wait(430);
}

/* ==================== 消息处理 ==================== */
function dispatch(m) {
  dbg(m.a);
  switch (m.a) {
    case 'created': return onCreated(m);
    case 'joined': return onJoined(m);
    case 'room': return onRoom(m);
    case 'game': return onGame(m);
    case 'hand': return onHand(m);
    case 'round': return onRound(m);
    case 'status': return onStatus(m);
    case 'reveal': return onReveal(m);
    case 'doubleAsk': return onDoubleAsk(m);
    case 'doubleResult': return onDoubleResult(m);
    case 'final': return onFinal(m);
    case 'toast': toast(m.msg); return null;
    case 'error': return onServerError(m);
    default: return null;
  }
}
function onCreated(m) {
  saveSession(m.room, m.token, m.pid, S.pendingName);
  setLobbyBusy(false);
  lobbyErr('');
  toast('房间 ' + m.room + ' 已创建', 'ok');
  showView('room');
  if (S.auto && S.auto.mode === 'create') autoAfterCreated();
}
function onJoined(m) {
  saveSession(m.room, m.token, m.pid, S.pendingName || (S.session && S.session.name));
  S.reconnects = 0;
  if (m.rejoin) toast('重连成功', 'ok');
  setLobbyBusy(false);
  lobbyErr('');
  showView('room');
}
function onRoom(m) {
  S.roomMsg = m;
  S.isHost = m.host === S.myPid;
  if (m.state === 'playing') {
    if (S.view !== 'table') {
      /* 重连进进行中的牌局：服务器不会再发 game，用房间快照搭桌 */
      buildTable(m.players, m.base);
      showView('table');
      setHint('已重连 · 同步牌局中……');
    } else {
      /* 局中有人掉线/重连：同步在线状态与数据 */
      m.players.forEach(function (pub) {
        var p = byPid(pub.pid);
        if (!p) return;
        p.connected = pub.connected !== false;
        p.drinks = pub.drinks;
        if (p.panel) p.panel.classList.toggle('off', !p.connected);
        if (p.chipDrinksEl) p.chipDrinksEl.textContent = drinksText(p.drinks, 3);
        renderBeerTray(p);
      });
    }
    return null;
  }
  if (m.state === 'lobby') {
    if (S.view === 'table') {
      /* 再来一局：全员回房间页 */
      teardownTable();
      $('final-modal').classList.add('hidden');
      showView('room');
    }
    if (S.view === 'room') renderRoom(m);
    return null;
  }
  if (m.state === 'final') {
    if (S.view !== 'table') { showView('room'); renderRoom(m); }
    return null;
  }
  return null;
}
function onGame(m) {
  /* 新一局开始（可能来自再来一局） */
  teardownTable();
  buildTable(m.players, m.base);
  $('final-modal').classList.add('hidden');
  showView('table');
  S.phase = 'dealing';
  setHint('发牌中……');
  return null;
}
function onHand(m) {
  if (S.view !== 'table') {
    /* 极少见：hand 先于界面就绪，补搭 */
    if (S.roomMsg) { buildTable(S.roomMsg.players, S.roomMsg.base); showView('table'); }
    else return null;
  }
  if (S.dealtDone || (S.roomMsg && S.roomMsg.state === 'playing' && S.roomMsg.rnd > 0 && !S.myHand.length)) {
    /* 重连补发：直接铺 */
    return wait(0).then(function () { instantLayout(m.cards); });
  }
  return dealAnimation(m.cards);
}
function onRound(m) {
  if (!m.n) return null;   // 重连恰好落在轮次间隙
  if (S.view !== 'table') return null;
  var first = function () {
    S.round = m.n;
    S.need = m.need;
    S.base = m.base;
    S.selected = [];
    S.playedOk = false;
    S.waiting = [];
    S.autoPlayedAt = -1;
    S.players.forEach(function (p) { p.slotBacks.forEach(destroyCard); p.slotBacks = []; });
    S.mySlotCards = [];
    updateRoundBadge(false);
    setSlotFrames(m.n);
    updateBaseBadge(false);
  };
  var prevCleanup = (S.round >= 1 && (S.phase === 'result' || S.phase === 'double' || S.phase === 'idle'))
    ? cleanupRound() : wait(0);
  return prevCleanup.then(function () {
    first();
    if (m.rejoin) {
      /* 重连进某轮：服务器已用 AI 代打完我的出牌，本轮观战 */
      S.phase = 'waiting';
      setHint('已重连：本轮观战，下一轮归位');
      return null;
    }
    S.phase = 'banner';
    showBanner('第 ' + m.n + ' 轮 · ' + m.name,
      m.rule + '<br>当前罚酒基数 <b>×' + m.base + '</b>');
    SFX.whoosh();
    return wait(1500);
  }).then(function () {
    if (m.rejoin) return null;
    hideBanner();
    /* AI 立即已出牌：摆背面，错开一点更自然 */
    S.players.forEach(function (p) {
      if (p.isMe || !p.ai) return;
      for (var k = 0; k < m.need; k++) {
        (function (pp, kk) {
          Scheduler.add(Clock.t + 480 + rngFx() * 1100 + kk * 160, function () { addSlotBack(pp); });
        })(p, k);
      }
    });
    /* 进入选牌 */
    S.phase = 'select';
    if (m.n === 4) {
      S.need = 3;
      S.selected = S.myHand.slice(0, 3);
      S.selected.forEach(function (c) {
        c.sel = true;
        c.el.classList.add('locked');
        animate(c.off, { s: -12 }, { dur: 240, ease: easeOutBack, onU: function () { applyCard(c); } });
      });
      setHint('第 4 轮 · <b>炸金花</b>：最后 3 张已锁定，直接亮牌！');
      $('confirm-btn').disabled = false;
      $('confirm-btn').textContent = '🔥 亮牌！';
    } else {
      S.myHand.forEach(function (c) { c.el.classList.add('selectable'); });
      updateConfirm();
    }
    dbg();
    scheduleAutoPlay();
    return null;
  });
}
function onStatus(m) {
  S.waiting = m.waiting || [];
  var names = S.waiting.map(function (pid) {
    var p = byPid(pid);
    return p ? pname(p) : '?';
  });
  /* 面板高亮仍在思考的人；已出牌的人类摆背面 */
  S.players.forEach(function (p) {
    if (p.isMe || !p.panel) return;
    var stillWaiting = S.waiting.indexOf(p.pid) >= 0;
    p.panel.classList.toggle('turn', stillWaiting);
    if (!p.ai && !stillWaiting) {
      for (var k = p.slotBacks.length; k < S.need; k++) addSlotBack(p);
    }
  });
  if (S.phase === 'waiting') {
    setHint(names.length ? '已暗扣出牌 ｜ 等待 <b>' + names.join('、') + '</b> 出牌…' : '全部就位，亮牌在即…');
  }
  dbg();
  return null;
}
function onReveal(m) {
  if (S.view !== 'table') return null;
  S.phase = 'reveal';
  S.waiting = [];
  S.players.forEach(function (p) { if (p.panel) p.panel.classList.remove('turn'); });
  setHint('亮牌！');
  dbg();
  /* 1) 把各家出牌摆进槽位（扣着） */
  var playByPid = {};
  m.plays.forEach(function (pl) { playByPid[pl.pid] = pl; });
  m.plays.forEach(function (pl) {
    var p = byPid(pl.pid);
    if (!p) return;
    if (p.isMe) p.playedEls = ensureMePlayed(pl.cards);
    else revealPlayed(p, pl.cards);
  });
  var gap = Math.min(520, Math.max(300, Math.round(1900 / Math.max(1, m.order.length))));
  return wait(350).then(function () {
    /* 2) 按 order（最差→最好）依次翻牌 */
    var chain = Promise.resolve();
    m.order.forEach(function (pid) {
      chain = chain.then(function () {
        var p = byPid(pid);
        var pl = playByPid[pid];
        if (!p || !pl) return null;
        if (p.panel) p.panel.classList.add('turn');
        p.playedEls.forEach(function (c, k) {
          tweenCard(c, { ry: 180 }, { dur: 360, delay: k * 140, ease: easeInOut });
          tweenCard(c, { s: L.playedS * 1.14 }, { dur: 180, delay: k * 140, ease: easeOut })
            .then(function () { tweenCard(c, { s: L.playedS }, { dur: 200, ease: easeInOut }); });
          Scheduler.add(Clock.t + k * 140, function () { SFX.flip(); });
        });
        var sc = slotCenter(p);
        Scheduler.add(Clock.t + pl.cards.length * 140 + 120, function () {
          FX.burst(sc.x, sc.y - 10, { n: 10, colors: SPARKS, speed: 150, up: 60, grav: 300, size: 3, life: 0.6 });
        });
        if (m.n === 3 && pl.tot != null) {
          Scheduler.add(Clock.t + pl.cards.length * 140 + 240, function () { showTag(p, '总点 ' + fmtTot(pl.tot)); });
        } else if (m.n === 4 && pl.label) {
          Scheduler.add(Clock.t + pl.cards.length * 140 + 260, function () { showTag(p, pl.label); });
        }
        return wait(gap).then(function () {
          if (p.panel) p.panel.classList.remove('turn');
        });
      });
    });
    return chain;
  }).then(function () {
    /* 3) 结果：赢家/输家高亮 + 罚酒动画 */
    S.phase = 'result';
    var w = byPid(m.winner), l = byPid(m.loser);
    if (!w || !l) return wait(600);
    var prevDrinks = {};
    S.players.forEach(function (p) { prevDrinks[p.pid] = p.drinks; });
    S.players.forEach(function (p) { if (m.drinks[p.pid] != null) p.drinks = m.drinks[p.pid]; });
    showBanner('第 ' + m.n + ' 轮 · ' + RNAMES[m.n],
      '<span class="win">🏆 ' + pname(w) + ' 赢了</span><br>' +
      '<span class="lose">😵 ' + pname(l) + ' 罚酒</span><span class="amt">+' + m.delta + ' 🍺</span>');
    if (w.panel) w.panel.classList.add('win-flash');
    if (l.panel) l.panel.classList.add('lose-flash');
    if (w.chipEl) w.chipEl.classList.add('win-flash');
    if (l.chipEl) l.chipEl.classList.add('lose-flash');
    var t = $('table');
    t.classList.remove('shake');
    void t.offsetWidth;
    t.classList.add('shake');
    Scheduler.add(Clock.t + 460, function () { t.classList.remove('shake'); });
    var wc = slotCenter(w), lc = slotCenter(l);
    if (w.playedEls.length) { var mx = 0, my = 0; w.playedEls.forEach(function (c) { mx += c.p.x; my += c.p.y; }); wc = { x: mx / w.playedEls.length, y: my / w.playedEls.length }; }
    if (l.playedEls.length) { var nx = 0, ny = 0; l.playedEls.forEach(function (c) { nx += c.p.x; ny += c.p.y; }); lc = { x: nx / l.playedEls.length, y: ny / l.playedEls.length }; }
    w.playedEls.forEach(function (c) {
      c.el.classList.add('spot');
      tweenCard(c, { s: L.playedS * 1.45, y: c.p.y - 14 }, { dur: 400, ease: easeOutBack });
    });
    l.playedEls.forEach(function (c) {
      tweenCard(c, { s: L.playedS * 0.82, o: 0.45 }, { dur: 400, ease: easeOut });
    });
    S.players.forEach(function (p) {
      if (p === w || p === l) return;
      p.playedEls.forEach(function (c) { tweenCard(c, { o: 0.7 }, { dur: 400, ease: easeOut }); });
    });
    showSpot(wc.x, wc.y);
    flashEdge();
    FX.burst(wc.x, wc.y - 20, { n: 44, colors: GOLDS, speed: 340, up: 200, grav: 620, size: 4.5, life: 1.1 });
    FX.burst(wc.x, wc.y - 30, { n: 34, colors: CONFETTI, speed: 380, up: 280, grav: 300, size: 5, life: 1.7, shape: 'rect', flutter: true });
    FX.burst(wc.x, wc.y - 16, { n: 16, colors: STARS, speed: 430, up: 120, grav: 60, size: 7, life: 1.0, shape: 'star' });
    FX.burst(lc.x, lc.y - 10, { n: 30, colors: REDS, speed: 260, up: 140, grav: 700, size: 4, life: 0.9 });
    FX.burst(lc.x, lc.y + 6, { n: 24, colors: EMBERS, speed: 90, up: 30, grav: -170, size: 3, life: 1.5 });
    SFX.chord();
    Scheduler.add(Clock.t + 120, function () { SFX.thud(); });
    for (var i = 0; i < 3; i++) flyToLoser(l, i, i === 2, prevDrinks[l.pid]);
    return wait(1700);
  }).then(function () {
    hideBanner();
    dbg();
  });
}
function onDoubleAsk(m) {
  if (S.view !== 'table') return null;
  S.phase = 'double';
  S.dblAnswered = false;
  var loser = byPid(m.pid);
  if (m.pid === S.myPid) {
    $('dm-info').textContent = '你这轮被罚 ' + m.base + ' 杯 · 当前罚酒基数 ×' + m.base;
    $('dm-double-sub').textContent = '下轮罚酒 → ' + m.next + ' 杯';
    $('dm-safe-sub').textContent = '保持 ' + m.base + ' 杯';
    $('double-modal').classList.remove('hidden');
    /* 倒计时显示（服务器到点默认保持） */
    var t0 = Clock.t, total = (m.timeout || 20) * 1000;
    S.dblTickAt = t0;
    var tick = function () {
      if (S.dblAnswered || $('double-modal').classList.contains('hidden')) return;
      var left = Math.max(0, total - (Clock.t - t0));
      $('dm-count').textContent = '⏳ ' + Math.ceil(left / 1000) + ' 秒后默认保持';
      if (left > 0) Scheduler.add(Clock.t + 250, tick);
      else chooseDouble(false);
    };
    tick();
    if (S.auto) {
      /* 自动模式：停一拍让截图能拍到模态，然后选保持 */
      Scheduler.add(Clock.t + 2600, function () { chooseDouble(false); });
    }
  } else {
    setHint('等待 <b>' + pname(loser) + '</b> 抉择是否翻倍…');
    if (loser && loser.panel) loser.panel.classList.add('turn');
  }
  dbg();
  return null;
}
function chooseDouble(yes) {
  if (S.dblAnswered) return;
  S.dblAnswered = true;
  send({ a: 'double', yes: !!yes });
  $('double-modal').classList.add('hidden');
}
function onDoubleResult(m) {
  if (S.view !== 'table') return null;
  $('double-modal').classList.add('hidden');
  S.dblAnswered = true;
  S.players.forEach(function (p) { if (p.panel) p.panel.classList.remove('turn'); });
  var p = byPid(m.pid);
  S.base = m.base;
  updateBaseBadge(true);
  showBanner(m.yes ? '🔥 翻倍！' : '🛡️ 保持',
    pname(p) + (m.yes ? ' 把下轮罚酒拉到 <b>×' + m.base + '</b>' : ' 选择稳住，罚酒基数 <b>×' + m.base + '</b>'));
  if (m.yes) SFX.heart(); else SFX.select();
  setHint('等待下一轮……');
  return wait(1100).then(function () {
    hideBanner();
    S.phase = 'idle';
    dbg();
  });
}
function onFinal(m) {
  if (S.view !== 'table') return null;
  S.phase = 'final';
  setHint('牌局结束');
  return cleanupRound().then(function () {
    return wait(200);
  }).then(function () {
    var kings = m.kings || [];
    var names = kings.map(function (pid) { return pname(byPid(pid)); });
    $('fm-sub').textContent = '👑 酒王：' + names.join('、') + (kings.length > 1 ? '（并列）' : '');
    var box = $('final-rows');
    box.innerHTML = '';
    m.ranked.forEach(function (r, i) {
      var p = byPid(r.pid);
      if (!p) return;
      var isKing = kings.indexOf(r.pid) >= 0;
      var row = el('div', 'frow' + (isKing ? ' king' : '') + (p.isMe ? ' me' : ''));
      row.innerHTML =
        '<div class="fk">' + (isKing ? '👑' : (i + 1)) + '</div>' +
        '<div class="fa">' + p.emoji + '</div>' +
        '<div class="fn">' + pname(p) + (p.tag ? '<span class="ptag ' + p.pers + '">' + p.tag + '</span>' : '') + '</div>' +
        '<div class="fd">' + drinksText(r.drinks, 6) + '</div>';
      box.appendChild(row);
      (function (rr, k) { Scheduler.add(Clock.t + 120 + k * 90, function () { rr.classList.add('in'); }); })(row, i);
    });
    if (S.isHost) {
      $('btn-again').classList.remove('hidden');
      $('btn-leave-final').classList.add('hidden');
    } else {
      $('btn-again').classList.add('hidden');
      $('btn-leave-final').classList.remove('hidden');
    }
    $('final-modal').classList.remove('hidden');
    SFX.chord();
    for (var k = 0; k < 5; k++) {
      (function (k) {
        Scheduler.add(Clock.t + k * 240, function () {
          FX.burst(rngFx() * FX.w, FX.h * 0.18 + rngFx() * 70, {
            n: 30, colors: CONFETTI, speed: 300, up: 30, grav: 220, size: 4.5, life: 2.6, shape: 'rect', flutter: true
          });
        });
      })(k);
    }
    dbg('kings=' + names.join(','));
  });
}
function onServerError(m) {
  toast(m.msg || '服务器错误', 'err');
  if (S.view === 'lobby') {
    lobbyErr(m.msg || '出错了');
    setLobbyBusy(false);
  }
  /* 重连被拒：清掉旧会话 */
  if (m.msg && m.msg.indexOf('重连') >= 0) clearSession();
}

/* ==================== 自动模式（无头测试） ==================== */
function scheduleAutoPlay() {
  if (!S.auto) return;
  if (S.autoPlayedAt === S.round) return;
  S.autoPlayedAt = S.round;
  Scheduler.add(Clock.t + 900, function () {
    if (S.phase !== 'select' || S.playedOk) return;
    var cards = (S.auto.lose ? playToLose(S.myHand, S.round) : S.myHand.slice(0, S.need)) || S.myHand.slice(0, S.need);
    cards.forEach(function (c) {
      if (!c.sel) { c.sel = true; c.el.classList.add('sel'); }
      c.off.s = -26;
      applyCard(c);
    });
    S.selected = cards.slice();
    updateConfirm();
    Scheduler.add(Clock.t + 250, onConfirm);
  });
}
function autoAfterCreated() {
  var n = S.auto.ai || 0;
  for (var i = 0; i < n; i++) {
    (function (k) { Scheduler.add(Clock.t + 200 + k * 180, function () { send({ a: 'addAi' }); }); })(i);
  }
  if (!S.auto.nostart) {
    Scheduler.add(Clock.t + 300 + n * 180 + 500, function () { send({ a: 'start' }); });
  }
}

/* ==================== UI 绑定 ==================== */
function bindUI() {
  $('btn-create').addEventListener('click', doCreate);
  $('btn-join').addEventListener('click', doJoin);
  $('inp-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
  $('inp-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') doCreate(); });
  $('btn-copy').addEventListener('click', function () {
    var v = $('share-link').value;
    var done = function () { toast('分享链接已复制', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(done, function () { fallbackCopy(v); done(); });
    } else { fallbackCopy(v); done(); }
  });
  $('btn-addai').addEventListener('click', function () { send({ a: 'addAi' }); SFX.select(); });
  $('btn-rmai').addEventListener('click', function () { send({ a: 'removeAi' }); SFX.select(); });
  $('btn-start').addEventListener('click', function () {
    SFX.init(); SFX.resume(); SFX.chip();
    if (S.roomMsg && S.roomMsg.state === 'final') send({ a: 'again' });
    else send({ a: 'start' });
  });
  $('btn-leave-room').addEventListener('click', doLeave);
  $('confirm-btn').addEventListener('click', onConfirm);
  $('btn-double').addEventListener('click', function () { chooseDouble(true); });
  $('btn-safe').addEventListener('click', function () { chooseDouble(false); });
  $('btn-again').addEventListener('click', function () {
    send({ a: 'again' });
    $('final-modal').classList.add('hidden');
  });
  $('btn-leave-final').addEventListener('click', doLeave);
  $('leave-btn').addEventListener('click', doLeave);
  $('mute-btn').addEventListener('click', function () {
    SFX.init();
    SFX.muted = !SFX.muted;
    store.set('sj_mute', SFX.muted ? '1' : '0');
    updateMuteIcon();
  });
}
function fallbackCopy(v) {
  try {
    var ta = el('textarea');
    ta.value = v;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (e) { }
}
function updateMuteIcon() { $('mute-btn').textContent = SFX.muted ? '🔇' : '🔊'; }
function onResize() {
  setCardSize();
  FX.resize();
  relayoutAllInstant();
}

/* ==================== 启动 ==================== */
function boot() {
  if (window.__ZPH_BOOTED) return;
  window.__ZPH_BOOTED = 1;
  setCardSize();
  FX.init();
  bindUI();
  SFX.muted = store.get('sj_mute') === '1';
  updateMuteIcon();
  window.addEventListener('resize', onResize);
  document.addEventListener('pointerdown', function () { SFX.init(); SFX.resume(); });
  $('ws-addr').textContent = '服务器：' + wsUrl();
  $('inp-name').value = store.get('zph_name') || '';
  if (Q.room) $('inp-code').value = ('' + Q.room).toUpperCase().slice(0, 4);

  /* WS 流量日志（?wlog=1，供 CDP 抓取） */
  if (Q.wlog === '1') {
    S.wlog = [];
    window.__WLOG = function () { return JSON.stringify(S.wlog); };
  }

  /* 自动模式 */
  if (Q.auto === 'create' || Q.auto === 'join') {
    S.auto = {
      mode: Q.auto,
      ai: parseInt(Q.ai || '0', 10) || 0,
      lose: Q.lose === '1',
      nostart: Q.nostart === '1'
    };
    var name = Q.name || '测试';
    S.pendingName = name;
    $('inp-name').value = name;
    if (Q.auto === 'create') {
      connect().then(function () { send({ a: 'create', name: name }); })
        .catch(function (e) { lobbyErr('连不上服务器：' + e.message); pushErr('auto connect: ' + e.message); });
    } else {
      var code = (Q.room || '').toUpperCase();
      if (code.length !== 4) { lobbyErr('auto=join 需要 ?room=CODE'); pushErr('auto join: bad room code'); }
      else {
        connect().then(function () { send({ a: 'join', room: code, name: name }); })
          .catch(function (e) { lobbyErr('连不上服务器：' + e.message); pushErr('auto connect: ' + e.message); });
      }
    }
    Clock.start();
    return;
  }

  /* 断线重连：本地有会话则自动 rejoin */
  var sess = null;
  try { sess = JSON.parse(store.get('zph_session') || 'null'); } catch (e) { }
  if (sess && sess.room && sess.token) {
    S.pendingName = sess.name || '';
    $('inp-name').value = S.pendingName;
    toast('检测到房间 ' + sess.room + '，尝试重连…');
    connect().then(function () {
      send({ a: 'rejoin', room: sess.room, token: sess.token });
    }).catch(function () {
      toast('连不上服务器', 'err');
    });
  }
  Clock.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
