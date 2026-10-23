"""In-process httpx transport: requests reach an ASGI app without any socket.

httpx.ASGITransport collects the whole response before returning it, which
would turn every streamed reply into one late block and defeat the Copilot
stream pacing. This transport hands each body chunk to the caller as soon as
the app sends it, cancels the app when the caller closes the response early,
and uses the request's read timeout as the longest wait for the response to
start and between chunks.
"""
import asyncio

import httpx

from copilot_api.config import logger

MAX_REQUEST_BYTES = 128 * 1024 * 1024
MAX_QUEUED_CHUNKS = 256
MAX_CHUNKS = 10_000_000
FINISH_GRACE_SECONDS = 1.0
CANCEL_WAIT_SECONDS = 5.0
# 2.3 rather than 2.4, so Starlette watches receive() for a disconnect and a
# closed stream stops at once instead of on its next write.
ASGI_INFO = {"version": "3.0", "spec_version": "2.3"}
DEFAULT_PORTS = {"http": 80, "https": 443}

_END = object()


class _AppFailure:
    """An app error raised after the response had started."""

    def __init__(self, error):
        self.error = error


def _read_timeout(request):
    timeouts = request.extensions.get("timeout")
    value = timeouts.get("read") if isinstance(timeouts, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    return float(value)


def build_scope(request):
    """The ASGI HTTP scope for an httpx request."""
    url = request.url
    return {
        "type": "http",
        "asgi": dict(ASGI_INFO),
        "http_version": "1.1",
        "method": request.method,
        "scheme": url.scheme,
        "path": url.path,
        "raw_path": url.raw_path.split(b"?", 1)[0],
        "query_string": url.query,
        "root_path": "",
        "headers": [(name.lower(), value) for name, value in request.headers.raw],
        "client": None,
        "server": (url.host, url.port or DEFAULT_PORTS.get(url.scheme, 80)),
    }


async def _read_body(request):
    try:
        body = await request.aread()
    except Exception as e:
        raise httpx.WriteError(f"Could not read the request body: {e}", request=request) from e
    if len(body) > MAX_REQUEST_BYTES:
        raise httpx.WriteError("The request body is too large", request=request)
    return body


async def _stop_task(task, grace=0.0):
    """Gives task up to grace seconds to finish, then cancels it and waits briefly."""
    if task is None or task.done():
        return
    if grace > 0:
        await asyncio.wait({task}, timeout=grace)
        if task.done():
            return
    task.cancel()
    await asyncio.wait({task}, timeout=CANCEL_WAIT_SECONDS)
    if not task.done():
        logger.warn("An in-process request did not stop after being cancelled")


def _consume_failure(future):
    # Retrieves an error nobody awaited, so asyncio does not log it as unhandled.
    if not future.cancelled():
        future.exception()


class _Exchange:
    """One request: the app runs as a task and its response events land here."""

    def __init__(self, app, scope, body):
        self._app = app
        self._scope = scope
        self._body = body
        self._body_sent = False
        self.ended = False
        self.start = asyncio.get_running_loop().create_future()
        self.start.add_done_callback(_consume_failure)
        self.queue = asyncio.Queue(maxsize=MAX_QUEUED_CHUNKS)
        self.disconnected = asyncio.Event()
        self.task = asyncio.create_task(self._run())

    async def _receive(self):
        if not self._body_sent:
            self._body_sent = True
            return {"type": "http.request", "body": self._body, "more_body": False}
        await self.disconnected.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message):
        kind = message.get("type")
        if kind == "http.response.start":
            if not self.start.done():
                status = int(message.get("status", 500))
                self.start.set_result((status, list(message.get("headers") or [])))
            return
        if kind != "http.response.body" or self.ended:
            return
        chunk = message.get("body") or b""
        if chunk:
            await self.queue.put(bytes(chunk))
        if not message.get("more_body", False):
            self.ended = True
            await self.queue.put(_END)

    async def _run(self):
        try:
            await self._app(self._scope, self._receive, self._send)
        except Exception as e:  # CancelledError is not an Exception, so a cancel propagates
            await self._fail(e)
            return
        if not self.ended:
            await self._fail(RuntimeError("The app ended without completing the response"))

    async def _fail(self, error):
        if not self.start.done():
            self.start.set_exception(error)
            return
        if self.ended:
            logger.debug(f"In-process app raised after its response ended: {type(error).__name__}: {error}")
            return
        self.ended = True
        await self.queue.put(_AppFailure(error))


class _ResponseStream(httpx.AsyncByteStream):
    """Yields body chunks as the app produces them."""

    def __init__(self, exchange, timeout, request):
        self._exchange = exchange
        self._timeout = timeout
        self._request = request
        self._closed = False

    async def __aiter__(self):
        queue = self._exchange.queue
        for _ in range(MAX_CHUNKS):
            try:
                item = await asyncio.wait_for(queue.get(), self._timeout)
            except asyncio.TimeoutError as e:
                raise httpx.ReadTimeout("The in-process app sent nothing within the read timeout",
                                        request=self._request) from e
            if item is _END:
                return
            if isinstance(item, _AppFailure):
                error = item.error
                raise httpx.RemoteProtocolError(
                    f"The in-process app failed mid-response: {type(error).__name__}: {error}",
                    request=self._request)
            yield item
        raise httpx.RemoteProtocolError("The response exceeded the chunk limit", request=self._request)

    async def aclose(self):
        if self._closed:
            return
        self._closed = True
        self._exchange.disconnected.set()
        grace = FINISH_GRACE_SECONDS if self._exchange.ended else 0.0
        await _stop_task(self._exchange.task, grace)


class InProcessTransport(httpx.AsyncBaseTransport):
    """Serves httpx requests by calling an ASGI app on the current event loop."""

    def __init__(self, app):
        if not callable(app):
            raise TypeError("app must be an ASGI callable")
        self._app = app

    async def handle_async_request(self, request):
        body = await _read_body(request)
        exchange = _Exchange(self._app, build_scope(request), body)
        timeout = _read_timeout(request)
        try:
            status, headers = await asyncio.wait_for(exchange.start, timeout)
        except asyncio.TimeoutError as e:
            await _stop_task(exchange.task)
            raise httpx.ReadTimeout("The in-process app did not respond within the read timeout",
                                    request=request) from e
        except asyncio.CancelledError:
            exchange.disconnected.set()
            await _stop_task(exchange.task)
            raise
        except Exception as e:
            await _stop_task(exchange.task)
            raise httpx.RemoteProtocolError(f"The in-process app failed: {type(e).__name__}: {e}",
                                            request=request) from e
        stream = _ResponseStream(exchange, timeout, request)
        return httpx.Response(status, headers=headers, stream=stream, request=request)

    async def aclose(self):
        return None
