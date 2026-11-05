/* ============================================================
   纸牌屋 · 酒王争霸
   单文件、无依赖、无 ES Modules，file:// 直接运行。
   所有随机性均通过 mulberry32 种子流（?seed=<int> 可复现）。
   ============================================================ */
(function () {
'use strict';

/* ==================== 可调配置 ==================== */
var CONFIG = {
  baseDrinks: 1,        // 第 1 轮罚酒基数（杯）
  maxBase: 8,           // 罚酒基数上限 1→2→4→8
  handSize: 7,          // 每人手牌数
  targetPoint: 10.5,    // 十点半目标点数
  dealStagger: 38,      // 发牌间隔 ms
  dealDur: 430,         // 单张发牌飞行 ms
  revealGap: 560,       // 亮牌节奏间隔 ms
  flipDur: 360,         // 翻牌 ms
  resultMs: 2000,       // 结果横幅停留 ms
  bannerMs: 1500,       // 轮次横幅停留 ms
  doubleAiMs: 1500,     // AI 翻倍抉择停留 ms
  fanMaxSpread: 26,     // 手牌扇形最大张开角度
  selLift: 26,          // 选中抬升 px
  hovLift: 12           // 悬停抬升 px
};

/* ==================== 随机流 ==================== */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var rngGame = mulberry32(1), rngFx = mulberry32(2), rngAuto = mulberry32(3);

function shuffleArr(a, rng) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function pick(arr, rng) { return arr[Math.floor((rng || rngFx)() * arr.length)]; }

/* ==================== 牌与规则核心 ==================== */
var SUITCH = ['♦', '♣', '♥', '♠'];           // 花色 0<1<2<3（♠ 最大）
var RNAMES = ['', '比大', '比小', '十点半', '炸金花'];
var CATNAMES = ['散牌', '对子', '顺子', '金花', '同花顺', '豹子'];

function rankChar(r) { return r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : r === 14 ? 'A' : '' + r; }
function cardName(c) { return rankChar(c.rank) + SUITCH[c.suit]; }
/* 数字牌标准点阵（x/y 为点阵区内小数坐标；y>.5 的花色倒置） */
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
function mkDeck() {
  var d = [], id = 0, s, r;
  for (s = 0; s < 4; s++) for (r = 2; r <= 14; r++) d.push({ id: id++, rank: r, suit: s });
  return d;
}
/* 点数大者胜；同点比花色。返回 >0 表示 a 强 */
function cmpCardHigh(a, b) { return (a.rank - b.rank) || (a.suit - b.suit); }
function rank01(c) { return (c.rank * 4 + c.suit - 8) / 51; }
function val3(c) { return c.rank >= 11 ? 0.5 : (c.rank === 14 ? 1 : c.rank); }
function fmtTot(t) { return (t % 1 === 0) ? '' + t : t.toFixed(1); }

/* --- 炸金花牌型评估 --- */
function eval3(cards) {
  var rs = cards.map(function (c) { return c.rank; }).sort(function (a, b) { return b - a; });
  var ss = cards.map(function (c) { return c.suit; });
  var flush = ss[0] === ss[1] && ss[1] === ss[2];
  var asc = [rs[2], rs[1], rs[0]];
  var straight = false, top = 0;
  if (asc[0] === 2 && asc[1] === 3 && asc[2] === 14) { straight = true; top = 3; }
  else if (asc[1] === asc[0] + 1 && asc[2] === asc[1] + 1) { straight = true; top = asc[2]; }
  var trips = rs[0] === rs[1] && rs[1] === rs[2];
  var pair = !trips && (rs[0] === rs[1] || rs[1] === rs[2]);
  var suitOfRank = function (r) {
    for (var i = 0; i < cards.length; i++) if (cards[i].rank === r) return cards[i].suit;
    return -1;
  };
  var cat, tb, sb;
  if (trips) { cat = 5; tb = [rs[0]]; sb = ss.slice().sort(function (a, b) { return b - a; }); }
  else if (flush && straight) { cat = 4; tb = [top]; sb = [suitOfRank(top)]; }
  else if (flush) { cat = 3; tb = rs.slice(); sb = rs.map(suitOfRank); }
  else if (straight) { cat = 2; tb = [top]; sb = [suitOfRank(top)]; }
  else if (pair) {
    var pr = rs[0] === rs[1] ? rs[0] : rs[1];
    var kick = rs[0] === rs[1] ? rs[2] : rs[0];
    var ps = cards.filter(function (c) { return c.rank === pr; })
      .map(function (c) { return c.suit; }).sort(function (a, b) { return b - a; });
    cat = 1; tb = [pr, kick]; sb = [ps[0], suitOfRank(kick)];
  } else { cat = 0; tb = rs.slice(); sb = rs.map(suitOfRank); }
  return { cat: cat, tb: tb, sb: sb };
}
function compareEval(e1, e2) {
  var d = e1.cat - e2.cat, i;
  if (d) return d;
  for (i = 0; i < 3; i++) { d = (e1.tb[i] || 0) - (e2.tb[i] || 0); if (d) return d; }
  for (i = 0; i < 3; i++) { d = (e1.sb[i] || 0) - (e2.sb[i] || 0); if (d) return d; }
  return 0;
}
function scalarOfEval(e) {
  var s = e.cat, i;
  for (i = 0; i < 3; i++) s = s * 15 + (e.tb[i] || 0);
  for (i = 0; i < 3; i++) s = s * 4 + (e.sb[i] || 0);
  return s;
}
var MAX_SCALAR = scalarOfEval({ cat: 5, tb: [14], sb: [3, 2, 1] });
function bestOf3(cards) {
  var best = null, bs = -1, i, j, k;
  for (i = 0; i < cards.length; i++) for (j = i + 1; j < cards.length; j++) for (k = j + 1; k < cards.length; k++) {
    var e = eval3([cards[i], cards[j], cards[k]]);
    var s = scalarOfEval(e);
    if (s > bs) { bs = s; best = e; }
  }
  return { e: best, scalar: bs };
}
function handLabel(e) {
  switch (e.cat) {
    case 5: return '豹子 ' + rankChar(e.tb[0]);
    case 4: return '同花顺 ' + rankChar(e.tb[0]) + ' 大';
    case 3: return '金花 ' + rankChar(e.tb[0]) + ' 大';
    case 2: return '顺子 ' + rankChar(e.tb[0]) + ' 大';
    case 1: return '对子 ' + rankChar(e.tb[0]);
    default: return '散牌 ' + rankChar(e.tb[0]) + ' 大';
  }
}

/* --- 一轮结算：返回 赢家/输家/亮牌顺序(最差→最好) --- */
function resolvePlays(round, plays) {
  var better;
  if (round === 1) {
    better = function (a, b) { return cmpCardHigh(a.cards[0], b.cards[0]); };
  } else if (round === 2) {
    better = function (a, b) { return cmpCardHigh(b.cards[0], a.cards[0]); };
  } else if (round === 3) {
    plays.forEach(function (pl) {
      pl.tot = val3(pl.cards[0]) + val3(pl.cards[1]);
      pl.dist = Math.abs(CONFIG.targetPoint - pl.tot);
      pl.mx = cmpCardHigh(pl.cards[0], pl.cards[1]) >= 0 ? pl.cards[0] : pl.cards[1];
    });
    better = function (a, b) {
      var d = b.dist - a.dist;
      if (d) return d;
      return cmpCardHigh(a.mx, b.mx);
    };
  } else {
    plays.forEach(function (pl) { pl.ev = eval3(pl.cards); pl.label = handLabel(pl.ev); });
    better = function (a, b) { return compareEval(a.ev, b.ev); };
  }
  var sorted = plays.slice().sort(function (a, b) { return better(b, a); });
  return { winner: sorted[0], loser: sorted[sorted.length - 1], order: sorted.slice().reverse() };
}

/* ==================== AI ==================== */
var PERS = {
  jin:     { key: 'jin',     tag: '激进', wWin: 0.72, wPot: 0.28, noise: 0.08, dBase: 0.62, dBehind: 0.30 },
  jinshen: { key: 'jinshen', tag: '谨慎', wWin: 0.40, wPot: 0.60, noise: 0.05, dBase: 0.16, dBehind: 0.06 },
  feng:    { key: 'feng',    tag: '疯子', wWin: 0.50, wPot: 0.50, noise: 0.40, dBase: 0.50, dBehind: 0.15 }
};
var ROSTER = [
  { name: '豹哥', emoji: '🐯', pers: 'jin' },
  { name: '老张', emoji: '🍶', pers: 'jinshen' },
  { name: '小疯', emoji: '🤪', pers: 'feng' },
  { name: '狐姐', emoji: '🦊', pers: 'jinshen' },
  { name: '鲨总', emoji: '🦈', pers: 'jin' }
];
var LINES = {
  win: {
    jin: ['看到没，这才叫实力！', '跟我斗？喝酒吧！'],
    jinshen: ['承让承让。', '稳，就是赢。'],
    feng: ['哈哈哈哈哈！', '爽！再来再来！']
  },
  double: {
    jin: ['怂什么？翻倍！', '玩就玩大的，翻倍！'],
    jinshen: ['……翻倍。别问为什么。', '赌一把。'],
    feng: ['翻倍翻倍翻倍！！', '哈哈哈哈翻倍！']
  },
  safe: {
    jin: ['呵，先让你们一杯。', '稳住，后面再收割。'],
    jinshen: ['稳住，别浪。', '保持就好。'],
    feng: ['切～没意思。', '行吧行吧。']
  }
};

function aiChoose(hand, round, pers, rng) {
  if (round === 4) return hand.slice(0, 3);
  var i, j, bestS = -1e18, best = null, s, imm, pot, rem;
  if (round === 1 || round === 2) {
    for (i = 0; i < hand.length; i++) {
      var c = hand[i];
      rem = hand.filter(function (x) { return x !== c; });
      imm = rank01(c);
      if (round === 2) imm = 1 - imm;
      pot = bestOf3(rem).scalar / MAX_SCALAR;
      s = pers.wWin * imm + pers.wPot * pot + (rng() - 0.5) * pers.noise;
      if (s > bestS) { bestS = s; best = [c]; }
    }
    return best;
  }
  for (i = 0; i < hand.length; i++) for (j = i + 1; j < hand.length; j++) {
    var a = hand[i], b = hand[j];
    var tot = val3(a) + val3(b);
    var close = 1 - Math.abs(CONFIG.targetPoint - tot) / CONFIG.targetPoint;
    rem = hand.filter(function (x) { return x !== a && x !== b; });
    pot = scalarOfEval(eval3(rem)) / MAX_SCALAR;
    var mx = cmpCardHigh(a, b) >= 0 ? a : b;
    s = pers.wWin * close + pers.wPot * pot + 0.02 * rank01(mx) + (rng() - 0.5) * pers.noise;
    if (s > bestS) { bestS = s; best = [a, b]; }
  }
  return best;
}
/* 刻意打输（shot=double 用） */
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
  var best = null, bd = -1, bmx = null;
  for (i = 0; i < hand.length; i++) for (j = i + 1; j < hand.length; j++) {
    var a = hand[i], b = hand[j];
    var d = Math.abs(CONFIG.targetPoint - (val3(a) + val3(b)));
    var mx = cmpCardHigh(a, b) >= 0 ? a : b;
    if (d > bd || (d === bd && bmx && cmpCardHigh(mx, bmx) < 0)) { bd = d; best = [a, b]; bmx = mx; }
  }
  return best;
}
function aiDouble(p, base, players, rng) {
  if (base >= CONFIG.maxBase) return false;
  var sum = 0, n = 0;
  players.forEach(function (x) { if (x !== p) { sum += x.drinks; n++; } });
  var behind = n > 0 && p.drinks > sum / n + 0.01;
  var pr = p.persObj.dBase + (behind ? p.persObj.dBehind : 0);
  return rng() < pr;
}

/* ==================== 时钟 / 调度 / 补间 ==================== */
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
      tickAll(dt);
      self.rafId = requestAnimationFrame(fr);
    };
    this.rafId = requestAnimationFrame(fr);
  },
  stop: function () {
    this.running = false;
    if (this.rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
    this.rafId = 0;
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
  },
  clear: function () { this.q = []; }
};
function wait(ms) { return new Promise(function (res) { Scheduler.add(Clock.t + ms, res); }); }

function linear(k) { return k; }
function easeOut(k) { return 1 - Math.pow(1 - k, 3); }
function easeInOut(k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; }
function easeOutBack(k) { var c1 = 1.35, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); }

var Tweens = {
  list: [],
  run: function () {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var tw = this.list[i];
      if (Clock.t < tw.t0) continue;
      var k = (Clock.t - tw.t0) / tw.dur;
      if (k >= 1) k = 1;
      var e = tw.ease(k);
      for (var key in tw.to) tw.obj[key] = tw.from[key] + (tw.to[key] - tw.from[key]) * e;
      if (tw.onU) tw.onU(tw.obj);
      if (k >= 1) { this.list.splice(i, 1); if (tw.onD) tw.onD(); tw.res(); }
    }
  },
  killOverlap: function (obj, to) {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var tw = this.list[i];
      if (tw.obj !== obj) continue;
      for (var key in to) if (tw.to.hasOwnProperty(key)) { this.list.splice(i, 1); break; }
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

/* ==================== 音效（100% WebAudio 程序化） ==================== */
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

/* ==================== 粒子画布 ==================== */
var GOLDS = ['#ffd76a', '#f5b942', '#fff3c4', '#e8a02a', '#ffffff'];
var REDS = ['#e0455a', '#a51f30', '#ff9a7a', '#7a1220'];
var SPARKS = ['#fff3c4', '#ffd76a', '#ffffff'];
var EMBERS = ['#ff9a7a', '#ff6a3d', '#ffc46e', '#e0455a'];
var STARS = ['#ffffff', '#fff3c4', '#ffd76a'];
var CONFETTI = ['#ffd76a', '#f0c75e', '#e0455a', '#7ab8ff', '#7fe0a8', '#ffffff'];
var FX = {
  cv: null, ctx: null, parts: [], frozen: false, dpr: 1, w: 0, h: 0,
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
    if (this.frozen || !this.ctx) return;
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

/* ==================== 全局状态 ==================== */
var G = {
  players: [], human: null, deckCards: [],
  round: 0, base: 1, phase: 'menu', need: 0,
  selected: [], selectRes: null, doubleRes: null,
  cw: 64, ch: 91, playedS: 0.66, miniS: 0.34, zTop: 10,
  revealStopT: null, resultStartT: 0,
  doubleModalShown: false, finalShown: false, finalShownT: 0,
  autoSelected: false, pendingSeed: null, seed: 1, shotMode: false
};
var SLOT_POS = {
  1: [[50, 10]],
  2: [[27, 12], [73, 12]],
  3: [[17, 15], [50, 8], [83, 15]],
  4: [[13, 19], [37, 8], [63, 8], [87, 19]],
  5: [[11, 23], [29, 9], [50, 5], [71, 9], [89, 23]]
};
/* 玩家个人色编码（计分条 / 面板描边） */
var PLAYER_COLORS = ['#f0c75e', '#ff7a8a', '#7ab8ff', '#7fe0a8', '#d49aff', '#ffb36e'];
var HINTS = [
  '',
  '第 1 轮 · <b>比大</b>：选 1 张，最大者赢，最小者罚酒',
  '第 2 轮 · <b>比小</b>：选 1 张，最小者赢，最大者罚酒',
  '第 3 轮 · <b>十点半</b>：选 2 张凑 10.5（A=1，J/Q/K=半张）',
  '第 4 轮 · <b>炸金花</b>：最后 3 张已锁定，直接亮牌！'
];

/* ==================== DOM 工具 ==================== */
function $(id) { return document.getElementById(id); }
function el(tag, cls) { var d = document.createElement(tag); if (cls) d.className = cls; return d; }
function anchorRect(e) {
  var r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left };
}
var store = {
  get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { } }
};

/* ==================== 卡牌对象 ==================== */
function mkCardEl(c) {
  var d = el('div', 'card ' + ((c.suit === 0 || c.suit === 2) ? 'suit-r' : 'suit-b'));
  var rc = rankChar(c.rank), sc = SUITCH[c.suit];
  var mid;
  if (c.rank === 14) {
    /* A：中央特大花色 + 椭圆环 + 四角装饰 */
    mid = '<div class="acefield"><div class="ace-ring"></div><span class="ace-big">' + sc + '</span>' +
      '<span class="fl fl-n">' + sc + '</span><span class="fl fl-s">' + sc + '</span>' +
      '<span class="fl fl-e">' + sc + '</span><span class="fl fl-w">' + sc + '</span></div>';
  } else if (c.rank >= 11) {
    /* J/Q/K：装饰几何牌面 */
    mid = '<div class="faceart fa-' + rc + '"><div class="fa-frame"></div>' +
      '<span class="fa-rank">' + rc + '</span><span class="fa-suit">' + sc + '</span></div>';
  } else {
    /* 2-10：标准花色点阵 */
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
  c.p = { x: 0, y: 0, rz: 0, ry: 0, s: 1, o: 1 };
  c.off = { s: 0, h: 0 };
  c.sel = false;
  c.state = 'deck';
  c.tilt = 0;
  $('cardlayer').appendChild(d);
  d.addEventListener('click', function () { onCardTap(c); });
  d.addEventListener('pointerenter', function () {
    if (isSelectableNow(c)) animate(c.off, { h: -CONFIG.hovLift }, { dur: 200, ease: easeOutBack, onU: function () { applyCard(c); } });
  });
  d.addEventListener('pointerleave', function () {
    animate(c.off, { h: 0 }, { dur: 180, ease: easeOut, onU: function () { applyCard(c); } });
  });
}
function applyCard(c) {
  var p = c.p;
  var x = p.x - G.cw / 2, y = p.y + c.off.s + c.off.h - G.ch / 2;
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
function isSelectableNow(c) {
  return G.phase === 'select' && G.round !== 4 && c.owner === G.human && c.state === 'hand';
}

/* ==================== 布局 ==================== */
function setCardSize() {
  var vw = window.innerWidth, vh = window.innerHeight;
  var cw = Math.round(Math.min(Math.max(Math.min(vw * 0.155, vh * 0.16), 54), 96));
  var ch = Math.round(cw * 1.42);
  document.documentElement.style.setProperty('--cw', cw + 'px');
  document.documentElement.style.setProperty('--ch', ch + 'px');
  G.cw = cw; G.ch = ch;
}
function fanPos(i, n) {
  var r = $('hand').getBoundingClientRect();
  var cx = r.left + r.width / 2;
  var dx = n > 1 ? Math.min(G.cw * 0.62, (r.width - G.cw * 1.2) / (n - 1)) : 0;
  var spread = Math.min(4.2 * (n - 1), CONFIG.fanMaxSpread);
  var ang = n > 1 ? -spread / 2 + spread * i / (n - 1) : 0;
  return {
    x: cx + (i - (n - 1) / 2) * dx,
    y: r.top + r.height * 0.52 + Math.abs(ang) * 1.1,
    rz: ang
  };
}
function stackPos(p, i) {
  var a = anchorRect(p.stackEl);
  return { x: a.x + ((i % 3) - 1) * 2, y: a.y - i * 0.9 };
}
function slotCenter(p) {
  return p.isHuman ? anchorRect($('human-slot')) : anchorRect(p.slotEl);
}
function slotPos(p, k, total) {
  var c = slotCenter(p);
  var off = total === 1 ? [0] : total === 2 ? [-0.36, 0.36] : [-0.52, 0, 0.52];
  var rz = total === 3 ? [-8, 0, 8][k] : total === 2 ? [-4, 4][k] : 0;
  return { x: c.x + off[k] * G.cw, y: c.y, rz: rz };
}
/* 槽位微光描边框宽度按每轮出牌数调整 */
function setSlotFrames(rd) {
  if (!rd) return;
  var n = rd === 3 ? 2 : rd === 4 ? 3 : 1;
  var span = n === 1 ? 0 : n === 2 ? 0.72 : 1.04;
  var w = Math.round(G.cw * (span + G.playedS) + 24);
  var i, els = [];
  G.players.forEach(function (p) { if (p.slotEl) els.push(p.slotEl); });
  var hs = $('human-slot');
  if (hs) els.push(hs);
  for (i = 0; i < els.length; i++) {
    if (els[i].style && els[i].style.setProperty) els[i].style.setProperty('--slotw', w + 'px');
  }
}
function layoutHand(anim) {
  var hs = G.human.hand, i;
  for (i = 0; i < hs.length; i++) {
    var c = hs[i];
    var fp = fanPos(i, hs.length);
    var to = { x: fp.x, y: fp.y, rz: fp.rz + c.tilt };
    if (anim) tweenCard(c, to, { dur: 260, ease: easeOut });
    else { c.p.x = to.x; c.p.y = to.y; c.p.rz = to.rz; applyCard(c); }
  }
}
function relayoutAllInstant() {
  if (!G.players.length) return;
  setSlotFrames(G.round);
  G.players.forEach(function (p) {
    p.hand.forEach(function (c, i) {
      var t = p.isHuman ? fanPos(i, p.hand.length) : stackPos(p, i);
      c.p.x = t.x; c.p.y = t.y;
      if (p.isHuman) c.p.rz = t.rz + c.tilt;
      applyCard(c);
    });
    p.played.forEach(function (c, k) {
      var t = slotPos(p, k, p.played.length);
      c.p.x = t.x; c.p.y = t.y; c.p.rz = t.rz;
      applyCard(c);
    });
    if (p.bubbleEl && p.panel) {
      var a = anchorRect(p.avatarEl);
      p.bubbleEl.style.left = a.x + 'px';
      p.bubbleEl.style.top = (a.y - a.h / 2 - 8) + 'px';
    }
    positionTag(p);
  });
}

/* ==================== 计分板 / 顶栏 ==================== */
function pname(p) { return p.isHuman ? '你' : p.name; }
/* 酒杯可视化：少量逐杯显示，过量折叠为 ×n */
function drinksText(n, cap) {
  n = Math.round(n);
  if (n <= 0) return '🍺×0';
  if (n <= (cap || 3)) { var s = ''; for (var i = 0; i < n; i++) s += '🍺'; return s; }
  return '🍺×' + n;
}
function buildChips() {
  var box = $('chips');
  box.innerHTML = '';
  G.players.forEach(function (p) {
    var c = el('div', 'chip' + (p.isHuman ? ' me' : ''));
    c.style.borderColor = p.color;
    c.innerHTML = '<div class="chip-avatar" style="border-color:' + p.color + '">' + p.emoji + '</div>' +
      '<div class="chip-name">' + pname(p) + '</div>' +
      '<div class="chip-drinks">🍺×0</div>';
    box.appendChild(c);
    p.chipEl = c;
    p.chipDrinksEl = c.getElementsByClassName('chip-drinks')[0];
  });
}
function rollDrinks(p, from) {
  renderBeerTray(p);
  var pr = { v: from };
  animate(pr, { v: p.drinks }, {
    dur: 520, ease: easeOut,
    onU: function () { p.chipDrinksEl.textContent = drinksText(pr.v, 3); }
  });
  /* 计分芯片弹跳 */
  var chip = p.chipEl, ps = { s: 1 };
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
  /* 罚酒飘字 +N 🍺 */
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
  $('round-num').textContent = init ? '-' : '' + G.round;
  $('round-name').textContent = init ? '酒局' : RNAMES[G.round];
  $('round-dots').className = init ? '' : 'd' + G.round;
}
/* 中心酒注塔：层数随翻倍递增（×1 ×2 ×4 ×8） */
function updateBetVisual(pop) {
  var bv = $('bet-visual');
  if (!bv) return;
  var lv = Math.max(1, Math.min(4, Math.round(Math.log(G.base / CONFIG.baseDrinks) / Math.LN2) + 1));
  var t = bv.getElementsByClassName ? bv.getElementsByClassName('bet-tower')[0] : null;
  if (t) {
    var html = '';
    for (var i = 0; i < lv; i++) html += '<i style="bottom:' + (i * 8) + 'px"></i>';
    t.innerHTML = html;
  }
  var lb = $('bet-label');
  if (lb) lb.textContent = '酒注 ×' + G.base;
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
  $('base-num').textContent = '' + G.base;
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

/* ==================== 面板 / 气泡 / 标签 ==================== */
/* 罚酒上桌：渲染玩家位旁实体酒杯（≤3 逐杯，>3 叠塔+角标） */
function renderBeerTray(p) {
  var tray = p.trayEl;
  if (!tray) return;
  var n = p.drinks, html = '', i;
  if (n <= 0) {
    html = '';
  } else if (n <= 3) {
    for (i = 0; i < n; i++) html += '<i class="bg g' + i + '">🍺</i>';
  } else {
    html = '<span class="btower"><i class="bg g0">🍺</i><i class="bg g1">🍺</i><i class="bg g2">🍺</i></span><b class="beer-n">×' + n + '</b>';
  }
  tray.innerHTML = html;
}
function buildPanels() {
  var box = $('panels');
  box.innerHTML = '';
  var ais = G.players.filter(function (p) { return !p.isHuman; });
  var pos = SLOT_POS[ais.length] || SLOT_POS[3];
  ais.forEach(function (p, i) {
    var d = el('div', 'panel' + (pos[i][0] > 62 ? ' flip' : ''));
    d.style.left = pos[i][0] + '%';
    d.style.top = pos[i][1] + '%';
    d.innerHTML =
      '<div class="avatar" style="border-color:' + p.color + '">' + p.emoji + '</div>' +
      '<div class="pname">' + p.name + '</div>' +
      '<div><span class="ptag ' + p.pers + '">' + p.persObj.tag + '</span></div>' +
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
    p.trayEl = d.getElementsByClassName ? d.getElementsByClassName('beer-tray')[0] : null;
    renderBeerTray(p);
  });
}
function avatarCenter(p) { return anchorRect(p.avatarEl); }
function updateStack(p) {
  if (p.isHuman) return;
  p.hand.forEach(function (c, i) {
    var t = stackPos(p, i);
    tweenCard(c, { x: t.x, y: t.y }, { dur: 220, ease: easeOut });
  });
  p.stackCountEl.textContent = p.hand.length > 0 ? '×' + p.hand.length : '';
}
function showBubble(p, html, dur) {
  if (p.isHuman || !p.panel) return;
  var b = p.bubbleEl;
  if (!b) {
    b = el('div', 'bubble');
    b.style.left = '0px'; b.style.top = '0px';
    b.style.opacity = '0';
    $('cardlayer').appendChild(b);
    p.bubbleEl = b;
  }
  b.innerHTML = html;
  var a = avatarCenter(p);
  b.style.left = a.x + 'px';
  b.style.top = (a.y - a.h / 2 - 8) + 'px';
  b.style.transform = 'translate(-50%,-100%)';
  b._o = { v: parseFloat(b.style.opacity) || 0 };
  animate(b._o, { v: 1 }, { dur: 180, ease: easeOut, onU: function () { b.style.opacity = b._o.v; } });
  G.bubbleSeq = (G.bubbleSeq || 0) + 1;
  var tok = G.bubbleSeq;
  p.bubbleTok = tok;
  Scheduler.add(Clock.t + (dur || 1600), function () {
    if (p.bubbleTok === tok) hideBubble(p);
  });
  SFX.bubble();
}
function hideBubble(p) {
  var b = p.bubbleEl;
  if (!b) return;
  b._o = { v: parseFloat(b.style.opacity) || 0 };
  animate(b._o, { v: 0 }, { dur: 240, ease: easeOut, onU: function () { b.style.opacity = b._o.v; } });
}
function positionTag(p) {
  if (!p.tagEl) return;
  var sc = (p.played && p.played.length) ? { x: p.played[0].p.x, y: p.played[0].p.y } : slotCenter(p);
  p.tagEl.style.left = sc.x + 'px';
  p.tagEl.style.top = (sc.y - G.ch * G.playedS * 0.78) + 'px';
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

/* ==================== 横幅 ==================== */
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
/* 赢家聚光池 */
function showSpot(x, y) {
  var s = G.spotEl;
  if (!s) {
    s = el('div', 'spot-pool');
    s.style.opacity = '0';
    $('table').appendChild(s);
    G.spotEl = s;
  }
  s.style.left = x + 'px';
  s.style.top = y + 'px';
  s._o = { v: parseFloat(s.style.opacity) || 0 };
  animate(s._o, { v: 1 }, { dur: 380, ease: easeOut, onU: function () { s.style.opacity = s._o.v; } });
}
function hideSpot() {
  var s = G.spotEl;
  if (!s) return;
  s._o = { v: parseFloat(s.style.opacity) || 0 };
  animate(s._o, { v: 0 }, { dur: 300, ease: easeOut, onU: function () { s.style.opacity = s._o.v; } });
}
/* 屏幕边缘闪光 */
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

/* ==================== 飞行筹码 / 酒杯 ==================== */
function bez(a, b, c, t) { var u = 1 - t; return u * u * a + 2 * u * t * b + t * t * c; }
function flyToLoser(loser, idx, last, oldDrinks) {
  var from = anchorRect($('deck-visual'));
  var to = loser.isHuman ? anchorRect($('human-slot')) : avatarCenter(loser);
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

/* ==================== 游戏搭建 ==================== */
function clearTable() {
  $('cardlayer').innerHTML = '';
  $('panels').innerHTML = '';
  if (G.spotEl) G.spotEl.style.opacity = '0';
  FX.parts = [];
  if (FX.ctx) FX.ctx.clearRect(0, 0, FX.w, FX.h);
  G.players = []; G.human = null; G.deckCards = [];
  G.selected = []; G.selectRes = null; G.doubleRes = null;
  G.revealStopT = null; G.doubleModalShown = false;
  G.finalShown = false; G.autoSelected = false;
  G.zTop = 10; G.bubbleSeq = 0;
}
function buildPlayers(nAI) {
  var roster = ROSTER.slice();
  shuffleArr(roster, rngGame);
  var human = { idx: 0, isHuman: true, name: '你', emoji: '😎', pers: 'jin', persObj: PERS.jin, drinks: 0, hand: [], played: [], color: PLAYER_COLORS[0] };
  G.players = [human];
  G.human = human;
  for (var i = 0; i < nAI; i++) {
    var r = roster[i % roster.length];
    G.players.push({ idx: i + 1, isHuman: false, name: r.name, emoji: r.emoji, pers: r.pers, persObj: PERS[r.pers], drinks: 0, hand: [], played: [], color: PLAYER_COLORS[(i + 1) % PLAYER_COLORS.length] });
  }
}
function buildDeckCards() {
  var deck = mkDeck();
  shuffleArr(deck, rngGame);
  var n = G.players.length * CONFIG.handSize;
  G.deckCards = deck.slice(0, n);
  var da = anchorRect($('deck-visual'));
  G.deckCards.forEach(function (c, i) {
    mkCardEl(c);
    c.p.x = da.x + (i % 4) * 0.6;
    c.p.y = da.y - i * 0.35;
    c.p.s = 0.5;
    applyCard(c);
  });
}
function setupGame(nAI, seed) {
  G.seed = seed;
  rngGame = mulberry32(seed);
  rngFx = mulberry32(seed ^ 0x85eb);
  rngAuto = mulberry32(seed ^ 0x9e37);
  G.base = CONFIG.baseDrinks;
  G.round = 0;
  G.phase = 'dealing';
  clearTable();
  buildPlayers(nAI);
  buildPanels();
  buildChips();
  G.human.trayEl = $('human-tray');
  renderBeerTray(G.human);
  updateBaseBadge(false);
  updateRoundBadge(true);
  buildDeckCards();
}

/* ==================== 发牌 ==================== */
function dealSequence() {
  setHint('发牌中……');
  var ps = G.players, total = CONFIG.handSize;
  var d = 0, r, i;
  for (r = 0; r < total; r++) {
    for (i = 0; i < ps.length; i++) {
      var p = ps[i];
      var c = G.deckCards.pop();
      c.owner = p;
      c.state = 'hand';
      p.hand.push(c);
      var to;
      if (p.isHuman) {
        var fp = fanPos(p.hand.length - 1, total);
        c.tilt = (rngFx() * 2 - 1) * 3;
        to = { x: fp.x, y: fp.y, rz: fp.rz + c.tilt, s: 1 };
      } else {
        var sp = stackPos(p, p.hand.length - 1);
        to = { x: sp.x, y: sp.y, rz: (rngFx() * 2 - 1) * 4, s: G.miniS };
      }
      tweenCard(c, to, { dur: CONFIG.dealDur, delay: d, ease: easeOutBack });
      c.el.style.zIndex = ++G.zTop;
      (function (dd) { Scheduler.add(Clock.t + dd, function () { SFX.whoosh(); }); })(d);
      d += CONFIG.dealStagger;
    }
  }
  return wait(d + 480).then(function () {
    G.human.hand.sort(cmpCardHigh);
    layoutHand(true);
    G.players.forEach(function (p) { updateStack(p); });
    var hs = G.human.hand;
    hs.forEach(function (c, k) {
      tweenCard(c, { ry: 180 }, { dur: 380, delay: k * 70, ease: easeInOut });
      Scheduler.add(Clock.t + k * 70, function () { SFX.flip(); });
    });
    return wait(hs.length * 70 + 420);
  });
}

/* ==================== 选牌阶段 ==================== */
function setHint(html) { $('hint').innerHTML = html; }
function updateConfirm() {
  var btn = $('confirm-btn');
  var ok = G.phase === 'select' && G.selected.length === G.need;
  btn.disabled = !ok;
  btn.textContent = G.round === 4 ? '🔥 亮牌！' : '确认出牌';
  if (G.phase === 'select') {
    setHint(HINTS[G.round] + '　·　已选 <b>' + G.selected.length + ' / ' + G.need + '</b>');
  }
}
function select(c) {
  c.sel = true;
  c.el.classList.add('sel');
  G.selected.push(c);
  animate(c.off, { s: -CONFIG.selLift }, { dur: 200, ease: easeOutBack, onU: function () { applyCard(c); } });
  c.el.style.zIndex = ++G.zTop;
}
function deselect(c) {
  c.sel = false;
  c.el.classList.remove('sel');
  var i = G.selected.indexOf(c);
  if (i >= 0) G.selected.splice(i, 1);
  animate(c.off, { s: 0 }, { dur: 180, ease: easeOut, onU: function () { applyCard(c); } });
}
function onCardTap(c) {
  if (!isSelectableNow(c)) return;
  SFX.select();
  if (c.sel) deselect(c);
  else {
    if (G.selected.length >= G.need) deselect(G.selected[0]);
    select(c);
  }
  updateConfirm();
}
function waitHumanSelect() {
  return new Promise(function (res) { G.selectRes = res; });
}
function confirmSelection() {
  if (!G.selectRes) return;
  if (G.selected.length !== G.need) return;
  var r = G.selectRes;
  G.selectRes = null;
  r(G.selected.slice());
}
function selectPhase() {
  G.need = G.round === 3 ? 2 : 1;
  G.selected = [];
  G.phase = 'select';
  G.human.hand.forEach(function (c) { c.el.classList.add('selectable'); });
  updateConfirm();
  return waitHumanSelect().then(function (cards) {
    G.human.hand.forEach(function (c) { c.el.classList.remove('selectable'); });
    return cards;
  });
}
function lockPhase() {
  G.need = 3;
  G.phase = 'select';
  G.selected = G.human.hand.slice(0, 3);
  G.selected.forEach(function (c) {
    c.sel = true;
    c.el.classList.add('locked');
    animate(c.off, { s: -12 }, { dur: 240, ease: easeOutBack, onU: function () { applyCard(c); } });
  });
  updateConfirm();
  return waitHumanSelect();
}

/* ==================== 出牌 ==================== */
function commitAll(humanCards) {
  G.phase = 'commit';
  G.selected = [];
  updateConfirm();
  setHint('暗扣出牌，准备亮牌……');
  G.players.forEach(function (p) {
    if (!p.isHuman) p.played = aiChoose(p.hand, G.round, p.persObj, rngGame);
  });
  G.human.played = humanCards;
  G.players.forEach(function (p) {
    p.hand = p.hand.filter(function (c) { return p.played.indexOf(c) < 0; });
  });
  var d = 0;
  G.players.forEach(function (p) {
    p.played.forEach(function (c, k) {
      c.state = 'played';
      c.sel = false;
      c.el.classList.remove('sel');
      c.el.classList.remove('locked');
      c.off.s = 0; c.off.h = 0;
      var pos = slotPos(p, k, p.played.length);
      tweenCard(c, { x: pos.x, y: pos.y, rz: pos.rz, ry: 0, s: G.playedS }, { dur: 430, delay: d, ease: easeInOut })
        .then(function () {
          /* 落定回弹：份量感 */
          return tweenCard(c, { s: G.playedS * 1.06 }, { dur: 80, ease: easeOut });
        })
        .then(function () {
          tweenCard(c, { s: G.playedS }, { dur: 130, ease: easeInOut });
        });
      c.el.style.zIndex = 100 + d;
      d += 70;
    });
    (function (dd) { Scheduler.add(Clock.t + dd, function () { SFX.whoosh(); }); })(d);
    updateStack(p);
  });
  layoutHand(true);
  return wait(d + 560);
}

/* 亮牌后：各家牌从位前滑入舞台中央集结结算 */
function gatherPlays() {
  var st = anchorRect($('stage'));
  G.players.forEach(function (p) {
    if (!p.played.length) return;
    var c0 = slotCenter(p);
    var gx = c0.x + (st.x - c0.x) * 0.55;
    var gy = c0.y + (st.y - c0.y) * 0.55;
    p.played.forEach(function (c, k) {
      var t = slotPos(p, k, p.played.length);
      tweenCard(c, { x: gx + (t.x - c0.x), y: gy + (t.y - c0.y) }, { dur: 400, ease: easeInOut });
    });
  });
  return wait(430).then(function () {
    G.players.forEach(function (p) { positionTag(p); });
  });
}

/* ==================== 亮牌 ==================== */
function revealSequence(res) {
  G.phase = 'reveal';
  setHint('亮牌！');
  var order = res.order;
  var t0 = Clock.t + 300, i;
  G.revealTimes = [];
  for (i = 0; i < order.length; i++) G.revealTimes.push(t0 + i * CONFIG.revealGap);
  var mid = Math.floor(order.length / 2);
  G.revealStopT = G.revealTimes[mid] + 230;
  var chain = wait(300);
  order.forEach(function (pl, idx) {
    chain = chain.then(function () {
      var p = pl.p;
      if (p.panel) p.panel.classList.add('turn');
      pl.cards.forEach(function (c, k) {
        tweenCard(c, { ry: 180 }, { dur: CONFIG.flipDur, delay: k * 140, ease: easeInOut });
        tweenCard(c, { s: G.playedS * 1.14 }, { dur: 180, delay: k * 140, ease: easeOut })
          .then(function () { tweenCard(c, { s: G.playedS }, { dur: 200, ease: easeInOut }); });
        Scheduler.add(Clock.t + k * 140, function () { SFX.flip(); });
      });
      var sc = slotCenter(p);
      Scheduler.add(Clock.t + pl.cards.length * 140 + 120, function () {
        FX.burst(sc.x, sc.y - 10, { n: 10, colors: SPARKS, speed: 150, up: 60, grav: 300, size: 3, life: 0.6 });
      });
      if (G.round === 3) {
        Scheduler.add(Clock.t + pl.cards.length * 140 + 240, function () { showTag(p, '总点 ' + fmtTot(pl.tot)); });
      } else if (G.round === 4) {
        Scheduler.add(Clock.t + pl.cards.length * 140 + 260, function () { showTag(p, pl.label); });
      }
      return wait(CONFIG.revealGap).then(function () {
        if (p.panel) p.panel.classList.remove('turn');
      });
    });
  });
  return chain.then(function () { return wait(240); })
    .then(function () { return gatherPlays(); });
}

/* ==================== 结果 ==================== */
function showResult(res) {
  G.phase = 'result';
  G.resultStartT = Clock.t;
  var w = res.winner.p, l = res.loser.p;
  var old = l.drinks;
  l.drinks += G.base;
  showBanner('第 ' + G.round + ' 轮 · ' + RNAMES[G.round],
    '<span class="win">🏆 ' + pname(w) + ' 赢了</span><br>' +
    '<span class="lose">😵 ' + pname(l) + ' 罚酒</span><span class="amt">+' + G.base + ' 🍺</span>');
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
  if (w.played.length) { var mx = 0, my = 0; w.played.forEach(function (c) { mx += c.p.x; my += c.p.y; }); wc = { x: mx / w.played.length, y: my / w.played.length }; }
  if (l.played.length) { var nx = 0, ny = 0; l.played.forEach(function (c) { nx += c.p.x; ny += c.p.y; }); lc = { x: nx / l.played.length, y: ny / l.played.length }; }
  /* 赢家牌放大聚光，输家牌变暗缩小，旁观牌压暗 */
  w.played.forEach(function (c) {
    c.el.classList.add('spot');
    tweenCard(c, { s: G.playedS * 1.45, y: c.p.y - 14 }, { dur: 400, ease: easeOutBack });
  });
  l.played.forEach(function (c) {
    tweenCard(c, { s: G.playedS * 0.82, o: 0.45 }, { dur: 400, ease: easeOut });
  });
  G.players.forEach(function (p) {
    if (p === w || p === l) return;
    p.played.forEach(function (c) { tweenCard(c, { o: 0.7 }, { dur: 400, ease: easeOut }); });
  });
  showSpot(wc.x, wc.y);
  flashEdge();
  /* 四层粒子：金色爆发 + 彩带 + 余烬 + 星芒 */
  FX.burst(wc.x, wc.y - 20, { n: 44, colors: GOLDS, speed: 340, up: 200, grav: 620, size: 4.5, life: 1.1 });
  FX.burst(wc.x, wc.y - 30, { n: 34, colors: CONFETTI, speed: 380, up: 280, grav: 300, size: 5, life: 1.7, shape: 'rect', flutter: true });
  FX.burst(wc.x, wc.y - 16, { n: 16, colors: STARS, speed: 430, up: 120, grav: 60, size: 7, life: 1.0, shape: 'star' });
  FX.burst(lc.x, lc.y - 10, { n: 30, colors: REDS, speed: 260, up: 140, grav: 700, size: 4, life: 0.9 });
  FX.burst(lc.x, lc.y + 6, { n: 24, colors: EMBERS, speed: 90, up: 30, grav: -170, size: 3, life: 1.5 });
  SFX.chord();
  Scheduler.add(Clock.t + 120, function () { SFX.thud(); });
  if (!w.isHuman) showBubble(w, pick(LINES.win[w.pers]), 1700);
  for (var i = 0; i < 3; i++) flyToLoser(l, i, i === 2, old);
  return wait(CONFIG.resultMs).then(function () {
    hideBanner();
  });
}

/* ==================== 翻倍抉择 ==================== */
function applyDouble(d) {
  if (d) {
    G.base = Math.min(G.base * 2, CONFIG.maxBase);
    updateBaseBadge(true);
    SFX.heart();
  }
}
function humanDoubleUI() {
  $('dm-info').textContent = '你这轮被罚 ' + G.base + ' 杯 · 当前罚酒基数 ×' + G.base;
  $('dm-double-sub').textContent = '下轮罚酒 → ' + Math.min(G.base * 2, CONFIG.maxBase) + ' 杯';
  $('dm-safe-sub').textContent = '保持 ' + G.base + ' 杯';
  $('double-modal').classList.remove('hidden');
  G.doubleModalShown = true;
  return new Promise(function (res) { G.doubleRes = res; });
}
function chooseDouble(d) {
  if (!G.doubleRes) return;
  var r = G.doubleRes;
  G.doubleRes = null;
  G.doubleModalShown = false;
  $('double-modal').classList.add('hidden');
  applyDouble(d);
  r();
}
function doublePhase(res) {
  G.phase = 'double';
  var l = res.loser.p;
  if (l.isHuman) {
    return humanDoubleUI();
  }
  var d = aiDouble(l, G.base, G.players, rngGame);
  var line = pick(d ? LINES.double[l.pers] : LINES.safe[l.pers]);
  showBubble(l, line + (d ? '<br>下轮罚酒 ×2 → ' + Math.min(G.base * 2, CONFIG.maxBase) + ' 杯！' : ''), 400 + CONFIG.doubleAiMs);
  return wait(420).then(function () {
    applyDouble(d);
    return wait(CONFIG.doubleAiMs);
  }).then(function () {
    hideBubble(l);
  });
}

/* ==================== 清理 / 下一轮 / 终局 ==================== */
function cleanupRound() {
  var dis = anchorRect($('discard-visual'));
  hideSpot();
  G.players.forEach(function (p) {
    p.played.forEach(function (c) {
      c.state = 'discard';
      c.el.classList.remove('spot');
      tweenCard(c, {
        x: dis.x + (rngFx() - 0.5) * 14, y: dis.y + (rngFx() - 0.5) * 14,
        rz: (rngFx() - 0.5) * 40, s: 0.4, o: 0.22
      }, { dur: 420, ease: easeInOut });
    });
    p.played = [];
    fadeTag(p);
    if (p.panel) p.panel.classList.remove('win-flash', 'lose-flash', 'turn');
    if (p.chipEl) p.chipEl.classList.remove('win-flash', 'lose-flash');
  });
  return wait(430);
}
function roundBanner() {
  if (G.shotMode) return wait(0);
  var rules = [
    '',
    '出 1 张，牌大者赢，牌小者罚酒！',
    '出 1 张，牌小者赢，牌大者罚酒！',
    '出 2 张凑 10.5（A=1，J/Q/K=半张），离目标最远者罚酒！',
    '剩余 3 张自动锁定，牌型最弱者罚酒！'
  ];
  showBanner('第 ' + G.round + ' 轮 · ' + RNAMES[G.round],
    rules[G.round] + '<br>当前罚酒基数 <b>×' + G.base + '</b>');
  SFX.whoosh();
  return wait(CONFIG.bannerMs).then(function () { hideBanner(); });
}
function showFinal() {
  G.phase = 'final';
  var ranked = G.players.slice().sort(function (a, b) { return b.drinks - a.drinks; });
  var max = ranked[0].drinks;
  var kings = ranked.filter(function (p) { return p.drinks === max; });
  $('fm-sub').textContent = '👑 酒王：' + kings.map(pname).join('、') + (kings.length > 1 ? '（并列）' : '');
  var box = $('final-rows');
  box.innerHTML = '';
  ranked.forEach(function (p, i) {
    var row = el('div', 'frow' + (p.drinks === max ? ' king' : '') + (p.isHuman ? ' me' : ''));
    row.innerHTML =
      '<div class="fk">' + (p.drinks === max ? '👑' : (i + 1)) + '</div>' +
      '<div class="fa">' + p.emoji + '</div>' +
      '<div class="fn">' + pname(p) + (p.isHuman ? '' : '<span class="ptag ' + p.pers + '">' + p.persObj.tag + '</span>') + '</div>' +
      '<div class="fd">' + drinksText(p.drinks, 6) + '</div>';
    box.appendChild(row);
    (function (rr, k) { Scheduler.add(Clock.t + 120 + k * 90, function () { rr.classList.add('in'); }); })(row, i);
  });
  $('final-modal').classList.remove('hidden');
  G.finalShown = true;
  G.finalShownT = Clock.t;
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
  return wait(0);
}

/* ==================== 主流程 ==================== */
function runGame() {
  return dealSequence()
    .then(function () {
      var chain = Promise.resolve();
      [1, 2, 3, 4].forEach(function (rd) {
        chain = chain.then(function () {
          G.round = rd;
          updateRoundBadge(false);
          setSlotFrames(rd);
          return roundBanner();
        }).then(function () {
          return rd < 4 ? selectPhase() : lockPhase();
        }).then(function (played) {
          return commitAll(played);
        }).then(function () {
          return resolvePlays(G.round, G.players.map(function (p) { return { p: p, cards: p.played }; }));
        }).then(function (res) {
          return revealSequence(res).then(function () { return showResult(res); })
            .then(function () { return rd < 4 ? doublePhase(res) : null; });
        }).then(function () {
          return cleanupRound();
        });
      });
      return chain;
    })
    .then(function () { return wait(400); })
    .then(function () { return showFinal(); })
    .catch(function (e) { G.flowError = e ? '' + (e.message || e) : 'unknown'; /* 静默兜底：保证控制台零报错 */ });
}

/* ==================== UI 绑定 ==================== */
function bindUI() {
  var pills = $('cnt-pills').getElementsByClassName('cnt-pill');
  var i;
  for (i = 0; i < pills.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var j = 0; j < pills.length; j++) pills[j].classList.remove('on');
        btn.classList.add('on');
        $('menu-count').textContent = '共 ' + (parseInt(btn.getAttribute('data-n'), 10) + 1) + ' 人酒局';
        SFX.select();
      });
    })(pills[i]);
  }
  $('start-btn').addEventListener('click', function () {
    SFX.init();
    SFX.resume();
    SFX.chip();
    var n = 2;
    for (i = 0; i < pills.length; i++) if (pills[i].classList.contains('on')) n = parseInt(pills[i].getAttribute('data-n'), 10);
    $('menu').classList.add('hidden');
    var seed = G.pendingSeed != null ? G.pendingSeed : ((Date.now() % 2147483647) | 0);
    G.pendingSeed = null;
    setupGame(n, seed);
    runGame();
  });
  $('confirm-btn').addEventListener('click', function () { confirmSelection(); });
  $('btn-double').addEventListener('click', function () { chooseDouble(true); });
  $('btn-safe').addEventListener('click', function () { chooseDouble(false); });
  $('btn-again').addEventListener('click', function () { softReset(); });
  $('mute-btn').addEventListener('click', function () {
    SFX.init();
    SFX.muted = !SFX.muted;
    store.set('sj_mute', SFX.muted ? '1' : '0');
    updateMuteIcon();
  });
}
function updateMuteIcon() { $('mute-btn').textContent = SFX.muted ? '🔇' : '🔊'; }
function softReset() {
  FX.frozen = false;
  G.shotMode = false;
  document.documentElement.classList.remove('noanim');
  $('final-modal').classList.add('hidden');
  $('double-modal').classList.add('hidden');
  hideBanner();
  clearTable();
  G.phase = 'menu';
  G.base = CONFIG.baseDrinks;
  updateRoundBadge(true);
  updateBaseBadge(false);
  setHint('欢迎来到纸牌屋');
  $('confirm-btn').disabled = true;
  $('menu').classList.remove('hidden');
  if (!Clock.running) Clock.start();
}
function onResize() {
  setCardSize();
  FX.resize();
  relayoutAllInstant();
}

/* ==================== 调试快照（?seed / ?shot / ?freeze / ?ai） ==================== */
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
function autoSelect(cards) {
  cards.forEach(function (c) {
    if (!c.sel) { c.sel = true; c.el.classList.add('sel'); }
    c.off.s = -CONFIG.selLift;
    applyCard(c);
  });
  G.selected = cards.slice();
  updateConfirm();
}
function shotAuto(target) {
  if (G.phase === 'select' && G.selectRes) {
    if (target === 'deal') return; /* deal：停留在选牌界面，不出牌 */
    if (target === 'round3' && G.round === 3) {
      if (!G.autoSelected) {
        autoSelect(aiChoose(G.human.hand, 3, PERS.jinshen, rngAuto));
        G.autoSelected = true;
      }
      return;
    }
    var cards;
    if (G.round === 4) cards = G.human.hand.slice(0, 3);
    else if (target === 'double') cards = playToLose(G.human.hand, G.round);
    else cards = aiChoose(G.human.hand, G.round, PERS.jinshen, rngAuto);
    autoSelect(cards);
    confirmSelection();
  }
  if (G.phase === 'double' && G.doubleRes && target !== 'double') {
    chooseDouble(rngAuto() < 0.5);
  }
}
function shotMet(target) {
  switch (target) {
    case 'deal': return G.phase === 'select' && G.round === 1;
    case 'reveal': return G.revealStopT != null && Clock.t >= G.revealStopT;
    case 'result': return G.phase === 'result' && Clock.t >= G.resultStartT + 1350;
    case 'double': return G.doubleModalShown === true;
    case 'round3': return G.phase === 'select' && G.round === 3 && G.selected.length === 2;
    case 'final': return G.finalShown === true && Clock.t >= G.finalShownT + 650;
    default: return false;
  }
}
function shotSettle(target) {
  return { deal: 280, reveal: 40, result: 40, double: 140, round3: 200, final: 80 }[target] || 100;
}
function runShot(q, seed) {
  document.documentElement.classList.add('noanim');
  $('menu').classList.add('hidden');
  var aiN = parseInt(q.ai || '3', 10);
  if (!(aiN >= 1 && aiN <= 5)) aiN = 3;
  var target = q.shot;
  G.shotMode = true;
  setupGame(aiN, seed);
  runGame();
  var budget = 120000, settle = 0, latched = false;
  function loop() {
    if (Clock.t >= budget) { finish(); return; }
    if (!latched) {
      shotAuto(target);
      if (shotMet(target)) latched = true;
    } else {
      settle += 16;
      if (settle >= shotSettle(target)) { finish(); return; }
    }
    tickAll(16);
    Promise.resolve().then(function () { Promise.resolve().then(loop); });
  }
  function finish() {
    if (target === 'double' && !G.doubleModalShown) { humanDoubleUI(); }
    FX.frozen = true;
    /* 快照模式：整体定格于构图帧，保证截图确定性（Clock 不再前进） */
  }
  loop();
}

/* ==================== 启动 ==================== */
function boot() {
  /* 幂等守卫：无头虚拟时间等场景下 DOMContentLoaded 可能重复触发 */
  if (window.__SJ_BOOTED) return;
  window.__SJ_BOOTED = 1;
  setCardSize();
  FX.init();
  bindUI();
  var q = parseQuery();
  var seed = q.seed != null ? (parseInt(q.seed, 10) || 0) : ((Date.now() % 2147483647) | 0);
  G.pendingSeed = q.seed != null ? seed : null;
  rngGame = mulberry32(seed);
  rngFx = mulberry32(seed ^ 0x85eb);
  rngAuto = mulberry32(seed ^ 0x9e37);
  SFX.muted = store.get('sj_mute') === '1';
  updateMuteIcon();
  window.addEventListener('resize', onResize);
  document.addEventListener('pointerdown', function () { SFX.init(); SFX.resume(); });
  if (q.shot) runShot(q, seed);
  else Clock.start();
}

if (typeof window !== 'undefined') {
  window.__SJ__ = {
    CONFIG: CONFIG, mulberry32: mulberry32, mkDeck: mkDeck, shuffleArr: shuffleArr,
    cmpCardHigh: cmpCardHigh, eval3: eval3, compareEval: compareEval,
    scalarOfEval: scalarOfEval, MAX_SCALAR: MAX_SCALAR, bestOf3: bestOf3,
    handLabel: handLabel, resolvePlays: resolvePlays, val3: val3,
    aiChoose: aiChoose, aiDouble: aiDouble, playToLose: playToLose,
    PERS: PERS, ROSTER: ROSTER, rankChar: rankChar, G: G
  };
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', boot);
}

})();
