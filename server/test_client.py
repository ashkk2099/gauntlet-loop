#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
四轮酒局房间服务器 · 端到端自测
用法：python test_client.py
模拟 2 个真人 + 房主补 2 个 AI，完整打一局并校验协议与规则。
"""
import asyncio
import json
import sys

import websockets

import room_server as rs

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

PORT = 8799
URL = 'ws://127.0.0.1:%d' % PORT


# ---------------- 规则单元校验 ----------------

def unit_tests():
    C = lambda r, s: {'id': r * 4 + s, 'rank': r, 'suit': s}
    # 牌型大小：豹子 > 同花顺 > 金花 > 顺子 > 对子 > 散牌
    trips = rs.eval3([C(9, 0), C(9, 1), C(9, 2)])
    sflush = rs.eval3([C(5, 1), C(6, 1), C(7, 1)])
    flush = rs.eval3([C(2, 2), C(9, 2), C(13, 2)])
    straight = rs.eval3([C(5, 0), C(6, 1), C(7, 2)])
    pair = rs.eval3([C(8, 0), C(8, 1), C(13, 2)])
    high = rs.eval3([C(2, 0), C(9, 1), C(13, 2)])
    order = [trips, sflush, flush, straight, pair, high]
    for i in range(len(order) - 1):
        assert rs.compare_eval(order[i], order[i + 1]) > 0, '牌型顺序错'
    # A23 顺子顶张为 3
    a23 = rs.eval3([C(14, 0), C(2, 1), C(3, 2)])
    assert a23['cat'] == 2 and a23['tb'][0] == 3, 'A23 顺子判定错'
    # 同牌型比点数再比花色
    assert rs.compare_eval(rs.eval3([C(14, 0), C(14, 1), C(14, 2)]),
                           rs.eval3([C(13, 0), C(13, 1), C(13, 2)])) > 0
    # 比大/比小
    assert rs.cmp_card_high(C(14, 0), C(13, 3)) > 0
    assert rs.cmp_card_high(C(7, 3), C(7, 0)) > 0
    # 十点半估值：JQK=0.5，A=1
    assert rs.val3(C(11, 0)) == 0.5 and rs.val3(C(14, 0)) == 1 and rs.val3(C(9, 3)) == 9
    print('[unit] 规则单元测试通过 ✓')


# ---------------- 模拟客户端 ----------------

class Client:
    def __init__(self, name):
        self.name = name
        self.ws = None
        self.pid = None
        self.token = None
        self.room = None
        self.hand = []
        self.inbox = asyncio.Queue()
        self.reader = None

    async def connect(self, first_msg):
        self.ws = await websockets.connect(URL)
        await self.ws.send(json.dumps(first_msg))
        self.reader = asyncio.create_task(self._pump())

    async def _pump(self):
        try:
            async for raw in self.ws:
                await self.inbox.put(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    async def wait_msg(self, action, timeout=30):
        """从队列里等某个 action 的消息（其他消息缓存回队列会乱序，这里简化：直接顺序消费并存到 backlog）"""
        end = asyncio.get_event_loop().time() + timeout
        while True:
            left = end - asyncio.get_event_loop().time()
            if left <= 0:
                raise AssertionError('%s 等 %s 超时' % (self.name, action))
            m = await asyncio.wait_for(self.inbox.get(), timeout=left)
            self.__dict__.setdefault('backlog', []).append(m)
            if m.get('a') == action:
                return m

    async def send(self, obj):
        await self.ws.send(json.dumps(obj))

    async def close(self):
        if self.reader:
            self.reader.cancel()
        if self.ws:
            await self.ws.close()


async def wait_room_players(c, n, timeout=15):
    """持续消费 room 广播直到人数为 n（广播有多代，旧消息可能先到）"""
    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        m = await c.wait_msg('room', timeout=end - asyncio.get_event_loop().time())
        if len(m['players']) == n:
            return m
    raise AssertionError('%s 房间人数未到 %d' % (c.name, n))


async def e2e():
    c1, c2 = Client('阿明'), Client('小张')

    await c1.connect({'a': 'create', 'name': c1.name})
    m = await c1.wait_msg('created')
    c1.room, c1.pid, c1.token = m['room'], m['pid'], m['token']
    print('[e2e] 建房 %s ✓' % c1.room)

    await c2.connect({'a': 'join', 'room': c1.room, 'name': c2.name})
    m = await c2.wait_msg('joined')
    c2.room, c2.pid, c2.token = m['room'], m['pid'], m['token']
    await wait_room_players(c1, 2)
    print('[e2e] 加入 ✓ 房间人数=2')

    await c1.send({'a': 'addAi'})
    await c1.send({'a': 'addAi'})
    await wait_room_players(c2, 4)
    print('[e2e] 房主补 2 个 AI ✓ 共 4 人')

    await c1.send({'a': 'start'})
    g1, g2 = await c1.wait_msg('game'), await c2.wait_msg('game')
    assert len(g1['players']) == 4
    h1, h2 = await c1.wait_msg('hand'), await c2.wait_msg('hand')
    assert len(h1['cards']) == 7 and len(h2['cards']) == 7, '每人 7 张'
    ids1 = {c['id'] for c in h1['cards']}
    ids2 = {c['id'] for c in h2['cards']}
    assert not (ids1 & ids2), '手牌不能重复'
    c1.hand, c2.hand = h1['cards'], h2['cards']
    print('[e2e] 开局发牌 ✓ 各 7 张且不重复（互相看不到）')

    # 打满四轮
    for rd in (1, 2, 3, 4):
        r1 = await c1.wait_msg('round')
        await c2.wait_msg('round')
        if r1['n'] != rd:
            # 可能先收到 status/doubleResult 等，继续等
            r1 = await c1.wait_msg('round')
        assert r1['n'] == rd
        need = r1['need']
        assert need == (2 if rd == 3 else (3 if rd == 4 else 1))

        await c1.send({'a': 'play', 'cards': [c['id'] for c in c1.hand[:need]]})
        await c2.send({'a': 'play', 'cards': [c['id'] for c in c2.hand[:need]]})
        c1.hand = c1.hand[need:]
        c2.hand = c2.hand[need:]

        v1 = await c1.wait_msg('reveal')
        assert v1['n'] == rd and len(v1['plays']) == 4, '第%d轮亮牌应为4份' % rd
        loser, delta = v1['loser'], v1['delta']
        assert v1['drinks'][loser] >= delta
        if rd == 3:
            assert all('tot' in pl for pl in v1['plays']), '十点半应带点数'
        if rd == 4:
            assert all('label' in pl for pl in v1['plays']), '炸金花应带牌型名'

        if rd < 4:
            ask = await c1.wait_msg('doubleAsk')
            assert ask['pid'] == loser
            if loser == c1.pid:
                await c1.send({'a': 'double', 'yes': rd == 1})  # 第1轮试翻倍，其余保持
            elif loser == c2.pid:
                await c2.send({'a': 'double', 'yes': False})
            dres = await c1.wait_msg('doubleResult')
            await c2.wait_msg('doubleResult')
            if loser in (c1.pid, c2.pid) and rd == 1:
                assert dres['yes'] is True and dres['base'] == 2, '翻倍未生效'
        print('[e2e] 第 %d 轮（%s）✓ 输家=%s 罚 %d 杯'
              % (rd, v1['n'], loser, delta))

    f1 = await c1.wait_msg('final', timeout=40)
    assert len(f1['ranked']) == 4 and f1['kings'], '终局排名异常'
    total = sum(r['drinks'] for r in f1['ranked'])
    assert total >= 4, '四轮至少罚出 4 杯, 实际 %d' % total
    print('[e2e] 终局 ✓ 酒王=%s 总罚酒=%d 杯' % (f1['kings'], total))

    # 再来一局 → 回大厅
    await c1.send({'a': 'again'})
    m = await c2.wait_msg('room')
    assert m['state'] == 'lobby', 'again 后应回大厅'
    print('[e2e] 再来一回大厅 ✓')

    await c1.close()
    await c2.close()


async def rejoin_test():
    """断线重连：游戏中掉线 → token 重连 → 手牌补发"""
    c1, c2 = Client('老王'), Client('阿丽')
    await c1.connect({'a': 'create', 'name': c1.name})
    m = await c1.wait_msg('created')
    c1.room, c1.token = m['room'], m['token']
    await c2.connect({'a': 'join', 'room': c1.room, 'name': c2.name})
    m = await c2.wait_msg('joined')
    c2.pid, c2.token = m['pid'], m['token']
    await c1.send({'a': 'addAi'})
    await c1.send({'a': 'start'})
    h2 = await c2.wait_msg('hand')
    await c1.wait_msg('round')
    await c2.wait_msg('round')

    # c2 掉线
    await c2.close()
    await asyncio.sleep(0.6)

    # c2 重连
    c3 = Client('阿丽')
    await c3.connect({'a': 'rejoin', 'room': c1.room, 'token': c2.token})
    m = await c3.wait_msg('joined')
    assert m.get('rejoin') is True
    m = await c3.wait_msg('room')
    me = [p for p in m['players'] if p['pid'] == c2.pid][0]
    assert me['connected'] is True, '重连后应在线'
    h = await c3.wait_msg('hand')
    orig = {c['id'] for c in h2['cards']}
    got = {c['id'] for c in h['cards']}
    assert got <= orig and len(got) >= 6, '重连手牌必须是原手牌的子集（掉线轮 AI 可能已代打 1 张）'
    print('[e2e] 断线重连 ✓ 手牌补发一致（%d/7 张，无幽灵牌）' % len(got))

    # 这局让 AI 托管跑完（c1 也不出了，等 final，超时轮 AI 代打）
    # 直接清理，避免拖慢测试：房主离开 → 房间在游戏中转为全员托管，这里仅断开
    await c1.close()
    await c3.close()


async def main():
    unit_tests()
    server = await websockets.serve(rs.client_session, '127.0.0.1', PORT,
                                    ping_interval=None)
    try:
        await asyncio.wait_for(e2e(), timeout=120)
        await asyncio.wait_for(rejoin_test(), timeout=60)
    finally:
        server.close()
        await server.wait_closed()
    print('\n全部测试通过 ✅')


if __name__ == '__main__':
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
