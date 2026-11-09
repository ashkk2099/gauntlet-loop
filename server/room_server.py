#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
四轮酒局 · 联机房间服务器
=========================
权威服务器：洗牌发牌、规则判定、罚酒结算全部在服务端完成，
每个玩家只收到自己的手牌，防偷看。

协议（JSON over WebSocket）：

  客户端 → 服务器
    {"a":"create","name":"阿明"}                 建房
    {"a":"join","room":"K7Q2","name":"小张"}     加入
    {"a":"rejoin","room":"K7Q2","token":"..."}   断线重连
    {"a":"start"}                                开局（房主，空位补 AI）
    {"a":"play","cards":[12,33]}                 出牌（牌 id 列表）
    {"a":"double","yes":true}                    输家抉择：翻倍/保持
    {"a":"again"}                                再来一局（房主）
    {"a":"leave"}                                离开房间

  服务器 → 客户端
    created / joined / room / game / hand / round / status /
    reveal / doubleAsk / doubleResult / final / error / toast
"""
import asyncio
import json
import logging
import os
import random
import secrets
import string
import time

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

# ---------------- 配置 ----------------
CONFIG = {
    "baseDrinks": 1,
    "maxBase": 8,
    "handSize": 7,
    "targetPoint": 10.5,
    "maxPlayers": 6,
    "playTimeout": None,      # 出牌不设时限：一直等到玩家自己出牌（掉线才 AI 托管）；设秒数可恢复超时 AI 代打
    "doubleTimeout": 20,      # 翻倍抉择超时，默认保持
    "revealMs": 4.2,          # 亮牌结算后停顿（客户端播动画）
    "aiDoubleMs": 2.2,        # AI 翻倍抉择停顿
    "roundGapMs": 1.0,        # 轮次间隙
    "roomIdleTtl": 1800,      # 空房间保留时长
}

SUITCH = ['♦', '♣', '♥', '♠']            # 花色 0<1<2<3（♠ 最大）
RNAMES = ['', '比大', '比小', '十点半', '炸金花']
RULERULES = [
    '',
    '出 1 张，牌大者赢，牌小者罚酒！',
    '出 1 张，牌小者赢，牌大者罚酒！',
    '出 2 张凑 10.5（A=1，J/Q/K=半张），离目标最远者罚酒！',
    '剩余 3 张自动锁定，牌型最弱者罚酒！',
]
CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'  # 去掉易混淆字符

PERS = {
    'jin':     {'key': 'jin',     'tag': '鹰派', 'wWin': 0.72, 'wPot': 0.28, 'noise': 0.08, 'dBase': 0.62, 'dBehind': 0.30},
    'jinshen': {'key': 'jinshen', 'tag': '精算', 'wWin': 0.40, 'wPot': 0.60, 'noise': 0.05, 'dBase': 0.16, 'dBehind': 0.06},
    'feng':    {'key': 'feng',    'tag': '野马', 'wWin': 0.50, 'wPot': 0.50, 'noise': 0.40, 'dBase': 0.50, 'dBehind': 0.15},
}
# 《纸牌屋》剧中人物
ROSTER = [
    {'name': '弗兰克', 'emoji': '🎩', 'pers': 'jin'},
    {'name': '克莱尔', 'emoji': '🥂', 'pers': 'jinshen'},
    {'name': '彼得',   'emoji': '🎲', 'pers': 'feng'},
    {'name': '道格',   'emoji': '🍸', 'pers': 'jinshen'},
    {'name': '佐伊',   'emoji': '📰', 'pers': 'jin'},
]
EMOJI_POOL = ['😎', '🦊', '🐼', '🐸', '🦁', '🐰']
PLAYER_COLORS = ['#f0c75e', '#ff7a8a', '#7ab8ff', '#7fe0a8', '#d49aff', '#ffb36e']

log = logging.getLogger('siju')


# ==================== 牌与规则核心（与 game.js 严格一致） ====================

def mk_deck():
    return [{'id': s * 13 + (r - 2), 'rank': r, 'suit': s}
            for s in range(4) for r in range(2, 15)]


def cmp_card_high(a, b):
    """点数大者胜；同点比花色。>0 表示 a 强"""
    return (a['rank'] - b['rank']) * 4 + (a['suit'] - b['suit']) if a['rank'] != b['rank'] else (a['suit'] - b['suit'])


def rank01(c):
    return (c['rank'] * 4 + c['suit'] - 8) / 51


def val3(c):
    # 规则：A=1，J/Q/K=0.5，其余按点数（修正 game.js 中 A 被误判为 0.5 的顺序 bug）
    if c['rank'] == 14:
        return 1
    if c['rank'] >= 11:
        return 0.5
    return c['rank']


def rank_char(r):
    return {11: 'J', 12: 'Q', 13: 'K', 14: 'A'}.get(r, str(r))


def card_name(c):
    return rank_char(c['rank']) + SUITCH[c['suit']]


def eval3(cards):
    """炸金花牌型评估（移植自 game.js eval3）"""
    rs = sorted([c['rank'] for c in cards], reverse=True)
    ss = [c['suit'] for c in cards]
    flush = ss[0] == ss[1] == ss[2]
    asc = [rs[2], rs[1], rs[0]]
    straight, top = False, 0
    if asc[0] == 2 and asc[1] == 3 and asc[2] == 14:
        straight, top = True, 3
    elif asc[1] == asc[0] + 1 and asc[2] == asc[1] + 1:
        straight, top = True, asc[2]
    trips = rs[0] == rs[1] == rs[2]
    pair = (not trips) and (rs[0] == rs[1] or rs[1] == rs[2])

    def suit_of_rank(r):
        for c in cards:
            if c['rank'] == r:
                return c['suit']
        return -1

    if trips:
        cat, tb = 5, [rs[0]]
        sb = sorted(ss, reverse=True)
    elif flush and straight:
        cat, tb, sb = 4, [top], [suit_of_rank(top)]
    elif flush:
        cat, tb = 3, rs[:]
        sb = [suit_of_rank(r) for r in rs]
    elif straight:
        cat, tb, sb = 2, [top], [suit_of_rank(top)]
    elif pair:
        pr = rs[0] if rs[0] == rs[1] else rs[1]
        kick = rs[2] if rs[0] == rs[1] else rs[0]
        ps = sorted([c['suit'] for c in cards if c['rank'] == pr], reverse=True)
        cat, tb, sb = 1, [pr, kick], [ps[0], suit_of_rank(kick)]
    else:
        cat, tb = 0, rs[:]
        sb = [suit_of_rank(r) for r in rs]
    return {'cat': cat, 'tb': tb, 'sb': sb}


def compare_eval(e1, e2):
    d = e1['cat'] - e2['cat']
    if d:
        return d
    for i in range(3):
        d = (e1['tb'][i] if i < len(e1['tb']) else 0) - (e2['tb'][i] if i < len(e2['tb']) else 0)
        if d:
            return d
    for i in range(3):
        d = (e1['sb'][i] if i < len(e1['sb']) else 0) - (e2['sb'][i] if i < len(e2['sb']) else 0)
        if d:
            return d
    return 0


def scalar_of_eval(e):
    s = e['cat']
    for i in range(3):
        s = s * 15 + (e['tb'][i] if i < len(e['tb']) else 0)
    for i in range(3):
        s = s * 4 + (e['sb'][i] if i < len(e['sb']) else 0)
    return s


MAX_SCALAR = scalar_of_eval({'cat': 5, 'tb': [14], 'sb': [3, 2, 1]})


def best_of3(cards):
    best, bs = None, -1
    n = len(cards)
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                e = eval3([cards[i], cards[j], cards[k]])
                s = scalar_of_eval(e)
                if s > bs:
                    bs, best = s, e
    return {'e': best, 'scalar': bs}


def hand_label(e):
    cat = e['cat']
    if cat == 5:
        return '豹子 ' + rank_char(e['tb'][0])
    if cat == 4:
        return '同花顺 ' + rank_char(e['tb'][0]) + ' 大'
    if cat == 3:
        return '金花 ' + rank_char(e['tb'][0]) + ' 大'
    if cat == 2:
        return '顺子 ' + rank_char(e['tb'][0]) + ' 大'
    if cat == 1:
        return '对子 ' + rank_char(e['tb'][0])
    return '散牌 ' + rank_char(e['tb'][0]) + ' 大'


def resolve_plays(rnd, plays):
    """一轮结算：返回 winner/loser/order（最差→最好 的 pid 列表）"""
    if rnd == 1:
        def better(a, b):
            return cmp_card_high(a['cards'][0], b['cards'][0])
    elif rnd == 2:
        def better(a, b):
            return cmp_card_high(b['cards'][0], a['cards'][0])
    elif rnd == 3:
        for pl in plays:
            pl['tot'] = val3(pl['cards'][0]) + val3(pl['cards'][1])
            pl['dist'] = abs(CONFIG['targetPoint'] - pl['tot'])
            pl['mx'] = pl['cards'][0] if cmp_card_high(pl['cards'][0], pl['cards'][1]) >= 0 else pl['cards'][1]

        def better(a, b):
            d = b['dist'] - a['dist']
            if abs(d) > 1e-9:
                return 1 if d > 0 else -1
            return cmp_card_high(a['mx'], b['mx'])
    else:
        for pl in plays:
            pl['ev'] = eval3(pl['cards'])
            pl['label'] = hand_label(pl['ev'])

        def better(a, b):
            return compare_eval(a['ev'], b['ev'])

    import functools
    def _cmp(a, b):
        return better(a, b)
    srt = sorted(plays, key=functools.cmp_to_key(_cmp), reverse=True)
    return {'winner': srt[0], 'loser': srt[-1], 'order': [p['p'].pid for p in reversed(srt)]}


# ==================== AI（移植自 game.js） ====================

def ai_choose(hand, rnd, pers, rng):
    if rnd == 4:
        return hand[:3]
    best, best_s = None, -1e18
    if rnd in (1, 2):
        for c in hand:
            rem = [x for x in hand if x is not c]
            imm = rank01(c)
            if rnd == 2:
                imm = 1 - imm
            pot = best_of3(rem)['scalar'] / MAX_SCALAR if rem else 0
            s = pers['wWin'] * imm + pers['wPot'] * pot + (rng.random() - 0.5) * pers['noise']
            if s > best_s:
                best_s, best = s, [c]
        return best
    for i in range(len(hand)):
        for j in range(i + 1, len(hand)):
            a, b = hand[i], hand[j]
            tot = val3(a) + val3(b)
            close = 1 - abs(CONFIG['targetPoint'] - tot) / CONFIG['targetPoint']
            rem = [x for x in hand if x is not a and x is not b]
            pot = scalar_of_eval(eval3(rem)) / MAX_SCALAR if len(rem) >= 3 else 0
            mx = a if cmp_card_high(a, b) >= 0 else b
            s = pers['wWin'] * close + pers['wPot'] * pot + 0.02 * rank01(mx) + (rng.random() - 0.5) * pers['noise']
            if s > best_s:
                best_s, best = s, [a, b]
    return best


def ai_double(p, base, players, rng):
    if base >= CONFIG['maxBase']:
        return False
    others = [x for x in players if x is not p]
    avg = sum(x.drinks for x in others) / len(others) if others else 0
    behind = p.drinks > avg + 0.01
    pr = p.pers_obj['dBase'] + (p.pers_obj['dBehind'] if behind else 0)
    return rng.random() < pr


# ==================== 房间与玩家 ====================

class Player:
    _seq = 0

    def __init__(self, name, is_ai=False, pers_key=None):
        Player._seq += 1
        self.pid = 'p%d' % Player._seq
        self.token = secrets.token_urlsafe(16)
        self.name = name[:12] if name else '玩家'
        self.emoji = EMOJI_POOL[(Player._seq - 1) % len(EMOJI_POOL)]
        self.is_ai = is_ai
        self.pers_obj = PERS.get(pers_key) if pers_key else None
        self.ws = None
        self.connected = False
        self.drinks = 0
        self.hand = []
        self.played = []
        self.room = None
        self.sid = None  # websocket 会话标识，防旧连接顶新连接

    def pub(self):
        return {'pid': self.pid, 'name': self.name, 'emoji': self.emoji,
                'ai': self.is_ai, 'connected': self.connected,
                'drinks': self.drinks, 'handCount': len(self.hand),
                'pers': self.pers_obj['key'] if self.pers_obj else None,
                'tag': self.pers_obj['tag'] if self.pers_obj else None}


class Room:
    def __init__(self, code):
        self.code = code
        self.players = []
        self.host_pid = None
        self.state = 'lobby'      # lobby | playing | final
        self.rnd = 0
        self.base = CONFIG['baseDrinks']
        self.rng = random.Random()
        self.game_task = None
        self.play_events = {}     # pid -> asyncio.Event（出牌等待）
        self.play_buffer = {}     # pid -> card ids
        self.double_event = None
        self.double_choice = False
        self.again_event = None
        self.empty_since = None

    def humans(self):
        return [p for p in self.players if not p.is_ai]

    def host(self):
        for p in self.players:
            if p.pid == self.host_pid:
                return p
        return None

    def find(self, pid):
        for p in self.players:
            if p.pid == pid:
                return p
        return None


ROOMS = {}
ROOMS_LOCK = asyncio.Lock()


def new_code():
    while True:
        code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(4))
        if code not in ROOMS:
            return code


# ==================== 网络收发 ====================

async def send(p, obj):
    if p.is_ai or not p.ws:
        return
    try:
        await p.ws.send(json.dumps(obj, ensure_ascii=False))
    except ConnectionClosed:
        pass
    except Exception as e:
        log.warning('send to %s failed: %s', p.pid, e)


async def broadcast(room, obj, exclude=None):
    for p in room.players:
        if p is exclude:
            continue
        await send(p, obj)


async def broadcast_room(room):
    await broadcast(room, {
        'a': 'room', 'code': room.code, 'state': room.state,
        'host': room.host_pid, 'rnd': room.rnd, 'base': room.base,
        'players': [p.pub() for p in room.players],
    })


async def send_error(p, msg):
    await send(p, {'a': 'error', 'msg': msg})


# ==================== 游戏流程 ====================

async def run_game(room):
    """一局完整游戏：发牌 → 四轮 → 终局。作为 room.game_task 运行。"""
    try:
        room.state = 'playing'
        room.base = CONFIG['baseDrinks']
        for p in room.players:
            p.drinks, p.hand, p.played = 0, [], []

        # 洗牌发牌（服务器权威）
        deck = mk_deck()
        room.rng.shuffle(deck)
        need = len(room.players) * CONFIG['handSize']
        deck = deck[:need]
        for r in range(CONFIG['handSize']):
            for p in room.players:
                p.hand.append(deck.pop())
        for p in room.players:
            p.hand.sort(key=lambda c: (c['rank'], c['suit']))

        await broadcast(room, {'a': 'game', 'base': room.base,
                               'players': [p.pub() for p in room.players]})
        for p in room.players:
            await send(p, {'a': 'hand', 'cards': p.hand})

        for rd in (1, 2, 3, 4):
            room.rnd = rd
            need_cards = 2 if rd == 3 else (3 if rd == 4 else 1)

            # ---- 收集出牌（先建事件再广播轮次，防快客户端的出牌被丢弃） ----
            room.play_buffer = {}
            room.play_events = {}
            for p in room.players:
                p.played = []
                if p.is_ai:
                    p.played = ai_choose(p.hand, rd, p.pers_obj, room.rng)
                elif not p.connected:
                    p.played = ai_choose(p.hand, rd, PERS['jinshen'], room.rng)
                else:
                    room.play_events[p.pid] = asyncio.Event()

            await broadcast(room, {'a': 'round', 'n': rd, 'name': RNAMES[rd],
                                   'need': need_cards, 'base': room.base,
                                   'rule': RULERULES[rd]})

            if room.play_events:
                waiters = [ev.wait() for ev in room.play_events.values()]
                if CONFIG['playTimeout']:
                    try:
                        await asyncio.wait_for(
                            asyncio.gather(*waiters), timeout=CONFIG['playTimeout'])
                    except asyncio.TimeoutError:
                        pass
                else:
                    # 无时限：一直等到所有在线玩家出牌
                    # （掉线者由 leave_room 解除阻塞并 AI 托管，房间不会卡死）
                    await asyncio.gather(*waiters)
                for pid, ev in room.play_events.items():
                    p = room.find(pid)
                    if p is None or p.played:
                        continue
                    ids = room.play_buffer.get(pid)
                    picked = [c for c in p.hand if c['id'] in ids] if ids else []
                    if len(picked) != need_cards:
                        picked = ai_choose(p.hand, rd, PERS['jinshen'], room.rng)
                        if p.connected:
                            await broadcast(room, {'a': 'toast',
                                                   'msg': '%s 超时，AI 代打' % p.name})
                    p.played = picked

            for p in room.players:
                p.hand = [c for c in p.hand if c not in p.played]

            # ---- 结算 ----
            plays = [{'p': p, 'cards': p.played} for p in room.players]
            res = resolve_plays(rd, plays)
            loser = res['loser']['p']
            loser.drinks += room.base
            reveal_plays = []
            for pl in plays:
                item = {'pid': pl['p'].pid, 'cards': pl['cards']}
                if rd == 3:
                    item['tot'] = pl['tot']
                if rd == 4:
                    item['label'] = pl['label']
                reveal_plays.append(item)
            await broadcast(room, {
                'a': 'reveal', 'n': rd, 'plays': reveal_plays,
                'winner': res['winner']['p'].pid, 'loser': loser.pid,
                'order': res['order'], 'delta': room.base,
                'drinks': {p.pid: p.drinks for p in room.players},
            })
            await asyncio.sleep(CONFIG['revealMs'])

            # ---- 翻倍抉择（输家决定下轮基数） ----
            if rd < 4:
                nxt = min(room.base * 2, CONFIG['maxBase'])
                # 先建事件再广播提问，防快客户端的抉择被丢弃
                if not loser.is_ai and loser.connected:
                    room.double_event = asyncio.Event()
                    room.double_choice = False
                await broadcast(room, {'a': 'doubleAsk', 'pid': loser.pid,
                                       'base': room.base, 'next': nxt,
                                       'timeout': CONFIG['doubleTimeout']})
                if loser.is_ai or not loser.connected:
                    await asyncio.sleep(CONFIG['aiDoubleMs'])
                    yes = ai_double(loser, room.base, room.players, room.rng) \
                        if loser.is_ai else False
                else:
                    try:
                        await asyncio.wait_for(room.double_event.wait(),
                                               timeout=CONFIG['doubleTimeout'])
                    except asyncio.TimeoutError:
                        pass
                    yes = room.double_choice
                    room.double_event = None
                if yes:
                    room.base = min(room.base * 2, CONFIG['maxBase'])
                await broadcast(room, {'a': 'doubleResult', 'pid': loser.pid,
                                       'yes': yes, 'base': room.base})
                await asyncio.sleep(1.2)

        # ---- 终局 ----
        room.state = 'final'
        ranked = sorted(room.players, key=lambda p: -p.drinks)
        mx = ranked[0].drinks
        kings = [p.pid for p in ranked if p.drinks == mx]
        await broadcast(room, {'a': 'final',
                               'ranked': [{'pid': p.pid, 'drinks': p.drinks}
                                          for p in ranked],
                               'kings': kings})
        room.game_task = None
    except asyncio.CancelledError:
        raise
    except Exception as e:
        log.exception('game crash in room %s: %s', room.code, e)
        await broadcast(room, {'a': 'error', 'msg': '牌局异常中断，已回到大厅'})
        room.state = 'lobby'
        room.game_task = None
        await broadcast_room(room)


async def start_game(room):
    """房主开局：空位补 AI。"""
    if room.state != 'lobby':
        return
    roster = ROSTER[:]
    room.rng.shuffle(roster)
    i = 0
    while len(room.players) < 2:  # 至少 2 人：补 AI
        r = roster[i % len(roster)]
        ai = Player(r['name'], is_ai=True, pers_key=r['pers'])
        ai.emoji = r['emoji']
        ai.connected = True
        ai.room = room
        room.players.append(ai)
        i += 1
    room.game_task = asyncio.create_task(run_game(room))


# ==================== 会话与消息分发 ====================

async def handle_msg(p, msg, sid):
    a = msg.get('a')
    room = p.room

    if a == 'start':
        if room and room.host_pid == p.pid and room.state == 'lobby':
            await start_game(room)
        elif room and room.state == 'lobby':
            await send_error(p, '只有房主能开局')

    elif a == 'addAi':
        if not room or room.state != 'lobby':
            return
        if room.host_pid != p.pid:
            await send_error(p, '只有房主能加 AI')
            return
        if len(room.players) >= CONFIG['maxPlayers']:
            await send_error(p, '房间满了')
            return
        used = {q.name for q in room.players}
        roster = [r for r in ROSTER if r['name'] not in used] or ROSTER
        r = room.rng.choice(roster)
        ai = Player(r['name'], is_ai=True, pers_key=r['pers'])
        ai.emoji = r['emoji']
        ai.connected = True
        ai.room = room
        room.players.append(ai)
        await broadcast_room(room)

    elif a == 'removeAi':
        if not room or room.state != 'lobby' or room.host_pid != p.pid:
            return
        for q in reversed(room.players):
            if q.is_ai:
                room.players.remove(q)
                break
        await broadcast_room(room)

    elif a == 'play':
        if not room or room.state != 'playing':
            return
        ev = room.play_events.get(p.pid)
        if not ev or ev.is_set():
            return
        ids = msg.get('cards') or []
        need = 2 if room.rnd == 3 else (3 if room.rnd == 4 else 1)
        valid_ids = {c['id'] for c in p.hand}
        picked = [c for c in p.hand if c['id'] in ids and c['id'] in valid_ids]
        if len(picked) != need or len(set(c['id'] for c in picked)) != need:
            await send_error(p, '出牌不合法（需要 %d 张手牌）' % need)
            return
        p.played = picked
        room.play_buffer[p.pid] = ids
        ev.set()
        await broadcast(room, {'a': 'status',
                               'waiting': [q.pid for q in room.players
                                           if q.pid in room.play_events
                                           and not room.play_events[q.pid].is_set()]},
                        exclude=p)

    elif a == 'double':
        if room and room.double_event and not room.double_event.is_set():
            room.double_choice = bool(msg.get('yes'))
            room.double_event.set()

    elif a == 'again':
        if room and room.host_pid == p.pid and room.state == 'final':
            room.state = 'lobby'
            room.rnd = 0
            room.base = CONFIG['baseDrinks']
            for q in room.players:
                q.drinks, q.hand, q.played = 0, [], []
            await broadcast_room(room)

    elif a == 'leave':
        await leave_room(p)

    elif a == 'ping':
        await send(p, {'a': 'pong', 't': time.time()})


async def leave_room(p, silent=False):
    room = p.room
    if not room:
        return
    if room.state == 'lobby' or room.state == 'final':
        room.players.remove(p)
        p.room = None
        if room.host_pid == p.pid:
            hs = room.humans()
            room.host_pid = hs[0].pid if hs else None
        if not room.humans():
            if room.game_task:
                room.game_task.cancel()
            ROOMS.pop(room.code, None)
            log.info('room %s closed (empty)', room.code)
            return
        await broadcast_room(room)
    else:
        # 游戏中离开：保留座位，AI 托管，可重连
        p.connected = False
        p.ws = None
        # 若正在等此人出牌/抉择，立即解除阻塞（由游戏循环 AI 代打）
        ev = room.play_events.get(p.pid)
        if ev and not ev.is_set():
            ev.set()
        if room.double_event and not room.double_event.is_set():
            room.double_choice = False
            room.double_event.set()
        await broadcast_room(room)
        await broadcast(room, {'a': 'toast',
                               'msg': '%s 掉线，AI 托管中，可重连返回' % p.name})


async def client_session(ws):
    """一个 WebSocket 连接的完整生命周期"""
    p = None
    sid = secrets.token_hex(4)
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=30)
        msg = json.loads(raw)
        a = msg.get('a')

        if a == 'create':
            code = new_code()
            room = Room(code)
            ROOMS[code] = room
            p = Player(msg.get('name'))
            p.ws, p.sid, p.connected = ws, sid, True
            p.room = room
            room.players.append(p)
            room.host_pid = p.pid
            await send(p, {'a': 'created', 'room': code, 'pid': p.pid,
                           'token': p.token})
            log.info('room %s created by %s', code, p.name)

        elif a == 'join':
            room = ROOMS.get((msg.get('room') or '').upper())
            if not room:
                await send(wsless(ws), {'a': 'error', 'msg': '房间不存在'})
                return
            if room.state != 'lobby':
                await send(wsless(ws), {'a': 'error', 'msg': '牌局已开始，无法加入'})
                return
            if len(room.players) >= CONFIG['maxPlayers']:
                await send(wsless(ws), {'a': 'error', 'msg': '房间满了'})
                return
            p = Player(msg.get('name'))
            p.ws, p.sid, p.connected = ws, sid, True
            p.room = room
            room.players.append(p)
            await send(p, {'a': 'joined', 'room': room.code, 'pid': p.pid,
                           'token': p.token})

        elif a == 'rejoin':
            room = ROOMS.get((msg.get('room') or '').upper())
            if room:
                for q in room.players:
                    if q.token and q.token == msg.get('token'):
                        p = q
                        break
            if not p:
                await send(wsless(ws), {'a': 'error', 'msg': '重连失败，请重新加入'})
                return
            # 顶掉旧连接
            p.ws, p.sid, p.connected = ws, sid, True
            await send(p, {'a': 'joined', 'room': room.code, 'pid': p.pid,
                           'token': p.token, 'rejoin': True})
        else:
            await send(wsless(ws), {'a': 'error', 'msg': '第一条消息须为 create/join/rejoin'})
            return

        room = p.room
        await broadcast_room(room)

        # 重连补发：手牌 + 当前轮次
        if msg.get('a') == 'rejoin' and room.state == 'playing':
            await send(p, {'a': 'hand', 'cards': p.hand})
            await send(p, {'a': 'round', 'n': room.rnd, 'name': RNAMES[room.rnd],
                           'need': 2 if room.rnd == 3 else (3 if room.rnd == 4 else 1),
                           'base': room.base, 'rule': RULERULES[room.rnd],
                           'rejoin': True})

        async for raw in ws:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if p.sid != sid:
                break  # 已被新连接顶替
            try:
                await handle_msg(p, msg, sid)
            except Exception as e:
                log.exception('handle_msg error: %s', e)

    except asyncio.TimeoutError:
        try:
            await ws.send(json.dumps({'a': 'error', 'msg': '握手超时'},
                                     ensure_ascii=False))
        except Exception:
            pass
    except ConnectionClosed:
        pass
    except Exception as e:
        log.exception('session error: %s', e)
    finally:
        if p and p.sid == sid:
            p.connected = False
            p.ws = None
            if p.room:
                await leave_room(p)


class _WsShim:
    """握手阶段 Player 对象还不存在时的临时发送器"""
    def __init__(self, ws):
        self.ws = ws
        self.is_ai = False


def wsless(ws):
    return _WsShim(ws)


# ==================== 启动 ====================

async def janitor():
    """定期清理长期无人的房间"""
    while True:
        await asyncio.sleep(300)
        now = time.time()
        for code, room in list(ROOMS.items()):
            if room.humans():
                room.empty_since = None
                continue
            room.empty_since = room.empty_since or now
            if now - room.empty_since > CONFIG['roomIdleTtl']:
                if room.game_task:
                    room.game_task.cancel()
                ROOMS.pop(code, None)
                log.info('room %s reaped (idle)', code)


def process_request(connection, request):
    """Render 等平台需要 HTTP 健康检查端口"""
    if request.path == '/healthz':
        return connection.respond(200, 'ok\n')
    return None


async def main():
    port = int(os.environ.get('PORT', '8765'))
    logging.basicConfig(level=logging.INFO,
                        format='%(asctime)s %(levelname)s %(message)s')
    asyncio.create_task(janitor())
    async with serve(client_session, '0.0.0.0', port,
                     ping_interval=20, ping_timeout=25,
                     process_request=process_request,
                     max_size=64 * 1024):
        log.info('四轮酒局 room server listening on :%d', port)
        await asyncio.Future()  # run forever


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
