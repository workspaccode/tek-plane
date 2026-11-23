"""In-process WebSocket hub. Route handlers run in a threadpool, so publish() is thread-safe."""

import asyncio
import json
from collections import defaultdict

from fastapi import WebSocket


class Hub:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.connections: dict[int, set[WebSocket]] = defaultdict(set)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    async def connect(self, user_id: int, ws: WebSocket) -> None:
        await ws.accept()
        self.connections[user_id].add(ws)

    def disconnect(self, user_id: int, ws: WebSocket) -> None:
        conns = self.connections.get(user_id)
        if conns:
            conns.discard(ws)
            if not conns:
                self.connections.pop(user_id, None)

    def online_user_ids(self) -> list[int]:
        return list(self.connections.keys())

    async def _send(self, user_ids: list[int], text: str) -> None:
        for uid in set(user_ids):
            for ws in list(self.connections.get(uid, ())):
                try:
                    await ws.send_text(text)
                except Exception:
                    self.disconnect(uid, ws)

    def publish(self, user_ids, message: dict) -> None:
        if not self.loop or not user_ids:
            return
        text = json.dumps(message, default=str)
        coro = self._send(list(user_ids), text)
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self.loop.create_task(coro)
        else:
            asyncio.run_coroutine_threadsafe(coro, self.loop)


hub = Hub()
