#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""协议探针：模拟 auto=create&ai=2 的客户端，打印全部服务器消息（定位 R3 判定）"""
import asyncio
import json
import sys

import websockets

URL = 'ws://127.0.0.1:8765'


async def main():
    async with websockets.connect(URL) as ws:
        await ws.send(json.dumps({'a': 'create', 'name': '探针'}))
        hand = []
        mypid = None

        async def play(need):
            ids = [c['id'] for c in hand[:need]]
            await ws.send(json.dumps({'a': 'play', 'cards': ids}))
            print('>>> 我出牌:', [(c['rank'], c['suit']) for c in hand[:need]], flush=True)
            del hand[:need]

        async for raw in ws:
            m = json.loads(raw)
            a = m.get('a')
            if a == 'created':
                mypid = m['pid']
                print('created room=%s pid=%s' % (m['room'], m['pid']), flush=True)
                await ws.send(json.dumps({'a': 'addAi'}))
                await ws.send(json.dumps({'a': 'addAi'}))
                await ws.send(json.dumps({'a': 'start'}))
            elif a == 'hand':
                hand = m['cards']
                print('hand:', [(c['rank'], c['suit'], c['id']) for c in hand], flush=True)
            elif a == 'round':
                print('round %d %s need=%d base=%d' % (m['n'], m['name'], m['need'], m['base']), flush=True)
                await asyncio.sleep(0.3)
                await play(m['need'])
            elif a == 'reveal':
                print('reveal rd=%d winner=%s loser=%s delta=%d' % (m['n'], m['winner'], m['loser'], m['delta']), flush=True)
                for pl in m['plays']:
                    extra = ''
                    if 'tot' in pl:
                        extra = ' tot=%s' % pl['tot']
                    if 'label' in pl:
                        extra = ' label=%s' % pl['label']
                    tag = ' <== 我' if pl['pid'] == mypid else ''
                    print('   play pid=%s cards=%s%s%s' % (
                        pl['pid'], [(c['rank'], c['suit']) for c in pl['cards']], extra, tag), flush=True)
                print('   order=%s drinks=%s' % (m['order'], m['drinks']), flush=True)
            elif a == 'doubleAsk':
                if m['pid'] == mypid:
                    await ws.send(json.dumps({'a': 'double', 'yes': False}))
                    print('>>> 我被问翻倍，选保持', flush=True)
            elif a == 'doubleResult':
                print('doubleResult pid=%s yes=%s base=%d' % (m['pid'], m['yes'], m['base']), flush=True)
            elif a == 'final':
                print('final:', m, flush=True)
                return
            elif a in ('game', 'room', 'status', 'toast', 'error', 'joined'):
                print('%s: %s' % (a, json.dumps(m, ensure_ascii=False)[:200]), flush=True)


if __name__ == '__main__':
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    asyncio.run(main())
