#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
无头 Edge 实时截图工具（CDP 驱动，避开 --virtual-time-budget 与 WS/rAF 的冲突）
用法：
  python scripts/shoot.py <url> <outdir> <W>x<H> <t1,name1> <t2,name2> ...
  每个 <t,name>：导航后第 t 毫秒（真实时间）截一帧存为 outdir/name.png
示例：
  python scripts/shoot.py "file:///C:/.../online.html?auto=create&ai=2" shots 1280x800 6000,deal 12000,reveal
"""
import asyncio
import base64
import json
import subprocess
import sys
import time
import urllib.request
import urllib.parse

import websockets

EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
PORT = 9333


def http_json(method, url):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))


async def main():
    url, outdir, size = sys.argv[1], sys.argv[2], sys.argv[3]
    w, h = size.split('x')
    marks = []
    for spec in sys.argv[4:]:
        t, name = spec.split(',', 1)
        marks.append((int(t), name))
    marks.sort()

    prof = __import__('tempfile').gettempdir() + r'\edge-cdp-shoot'
    proc = subprocess.Popen([
        EDGE, '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--remote-debugging-port=%d' % PORT,
        '--user-data-dir=%s' % prof,
        '--window-size=%s,%s' % (w, h),
        'about:blank',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        # 等 CDP 起来
        ver = None
        for _ in range(60):
            try:
                ver = http_json('GET', 'http://127.0.0.1:%d/json/version' % PORT)
                break
            except Exception:
                time.sleep(0.25)
        if not ver:
            raise RuntimeError('CDP 端口未就绪')
        target = None
        for meth in ('PUT', 'GET'):
            try:
                target = http_json(meth, 'http://127.0.0.1:%d/json/new?%s'
                                   % (PORT, urllib.parse.quote(url, safe='')))
                break
            except Exception:
                continue
        if not target:
            raise RuntimeError('无法创建标签页')
        ws_url = target['webSocketDebuggerUrl']
        async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
            mid = 0

            async def cmd(method, params=None):
                nonlocal mid
                mid += 1
                await ws.send(json.dumps({'id': mid, 'method': method,
                                          'params': params or {}}))
                while True:
                    m = json.loads(await ws.recv())
                    if m.get('id') == mid:
                        return m.get('result', {})

            await cmd('Page.enable')
            t0 = time.time()
            for t, name in marks:
                dt = t / 1000 - (time.time() - t0)
                if dt > 0:
                    await asyncio.sleep(dt)
                if name.startswith('eval:'):
                    r = await cmd('Runtime.evaluate', {
                        'expression': name[5:], 'returnByValue': True,
                        'awaitPromise': True, 'userGesture': True})
                    print('[eval] %sms -> %s' % (t, r.get('result', {}).get('value')), flush=True)
                    continue
                if name.startswith('nav:'):
                    await cmd('Page.navigate', {'url': name[4:]})
                    print('[nav] %sms -> %s' % (t, name[4:]), flush=True)
                    continue
                if name.startswith('await:'):
                    # await:NAME:TIMEOUT_MS:EXPR — 轮询 EXPR 为真后立刻截图存 NAME.png
                    fname, tmo, expr = name[6:].split(':', 2)
                    deadline = time.time() + int(tmo) / 1000
                    ok = False
                    while time.time() < deadline:
                        r = await cmd('Runtime.evaluate', {
                            'expression': expr, 'returnByValue': True})
                        if r.get('result', {}).get('value'):
                            ok = True
                            break
                        await asyncio.sleep(0.12)
                    shot = await cmd('Page.captureScreenshot', {'format': 'png'})
                    path = '%s/%s.png' % (outdir, fname)
                    with open(path, 'wb') as f:
                        f.write(base64.b64decode(shot['data']))
                    print('[await] %sms -> %s (hit=%s)' % (t, path, ok), flush=True)
                    continue
                shot = await cmd('Page.captureScreenshot', {'format': 'png'})
                path = '%s/%s.png' % (outdir, name)
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(shot['data']))
                print('[shot] %sms -> %s' % (t, path), flush=True)
    finally:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass


if __name__ == '__main__':
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
