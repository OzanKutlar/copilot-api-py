import asyncio
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

from copilot_api import config
from copilot_api.config import state
from copilot_api.embed.detect import ENV_VAR, MARKERS, find_combine_webui, is_combine_webui
from copilot_api.embed.routing import install_routes, origins_for_port, routes_installed, uninstall_routes
from copilot_api.embed.transport import InProcessTransport

ROOT = Path(__file__).resolve().parent.parent
WAIT_SECONDS = 5.0
BASE = "http://localhost:4141"
TEXT = [(b"content-type", b"text/plain")]


def make_combine(path):
    """A fake CombineWebUI tree: just its marker files."""
    for marker in MARKERS:
        target = path / marker
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# marker\n", encoding="utf-8")
    return path


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, WAIT_SECONDS))


def refuse(*args, **kwargs):
    raise AssertionError("Something tried to use a socket")


def start(status=200):
    return {"type": "http.response.start", "status": status, "headers": TEXT}


def body(data, more=False):
    return {"type": "http.response.body", "body": data, "more_body": more}


async def echo_app(scope, receive, send):
    request = await receive()
    text = f"{scope['method']} {scope['path']} {scope['query_string'].decode()} {request['body'].decode()}"
    await send(start())
    await send(body(text.encode()))


def gated_app(gate):
    async def app(scope, receive, send):
        await receive()
        await send(start())
        await send(body(b"one", more=True))
        await gate.wait()
        await send(body(b"two"))
    return app


def hanging_app(record):
    async def app(scope, receive, send):
        await receive()
        await send(start())
        await send(body(b"first", more=True))
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            record.append("cancelled")
            raise
    return app


async def failing_app(scope, receive, send):
    await receive()
    raise RuntimeError("boom")


class DetectTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_preferred_name(self):
        make_combine(self.root / "CombineWebUI")
        self.assertEqual(find_combine_webui(self.root, env={}), (self.root / "CombineWebUI").resolve())

    def test_any_subfolder(self):
        make_combine(self.root / "my-ui")
        self.assertEqual(find_combine_webui(self.root, env={}), (self.root / "my-ui").resolve())

    def test_missing_marker(self):
        ui = make_combine(self.root / "CombineWebUI")
        (ui / "src" / "desktop" / "app.py").unlink()
        self.assertFalse(is_combine_webui(ui))
        self.assertIsNone(find_combine_webui(self.root, env={}))

    def test_env_variable_wins(self):
        make_combine(self.root / "CombineWebUI")
        other = make_combine(self.root / "elsewhere" / "ui")
        self.assertEqual(find_combine_webui(self.root, env={ENV_VAR: str(other)}), other.resolve())

    def test_hidden_folders_are_skipped(self):
        make_combine(self.root / ".hidden")
        self.assertIsNone(find_combine_webui(self.root, env={}))


class TransportTests(unittest.TestCase):
    def test_request_round_trip(self):
        async def scenario():
            async with httpx.AsyncClient(transport=InProcessTransport(echo_app)) as client:
                resp = await client.post(f"{BASE}/v1/echo?x=1", content=b"hello")
                return resp.status_code, resp.text
        self.assertEqual(run(scenario()), (200, "POST /v1/echo x=1 hello"))

    def test_chunks_arrive_before_the_response_ends(self):
        async def scenario():
            gate = asyncio.Event()
            chunks = []
            async with httpx.AsyncClient(transport=InProcessTransport(gated_app(gate))) as client:
                async with client.stream("GET", f"{BASE}/v1/stream") as resp:
                    async for chunk in resp.aiter_raw():
                        chunks.append(chunk)
                        gate.set()
            return chunks
        # A buffering transport would wait for "two" before handing over "one", and time out.
        self.assertEqual(run(scenario()), [b"one", b"two"])

    def test_closing_early_cancels_the_app(self):
        record = []

        async def scenario():
            async with httpx.AsyncClient(transport=InProcessTransport(hanging_app(record))) as client:
                async with client.stream("GET", f"{BASE}/v1/hang") as resp:
                    async for chunk in resp.aiter_raw():
                        self.assertEqual(chunk, b"first")
                        break
        run(scenario())
        self.assertEqual(record, ["cancelled"])

    def test_read_timeout_between_chunks(self):
        record = []

        async def scenario():
            transport = InProcessTransport(hanging_app(record))
            async with httpx.AsyncClient(transport=transport, timeout=0.2) as client:
                async with client.stream("GET", f"{BASE}/v1/hang") as resp:
                    async for _ in resp.aiter_raw():
                        pass
        with self.assertRaises(httpx.ReadTimeout):
            run(scenario())
        self.assertEqual(record, ["cancelled"])

    def test_app_failure_becomes_a_transport_error(self):
        async def scenario():
            async with httpx.AsyncClient(transport=InProcessTransport(failing_app)) as client:
                await client.get(f"{BASE}/v1/boom")
        with self.assertRaises(httpx.TransportError):
            run(scenario())


class RoutingTests(unittest.TestCase):
    def tearDown(self):
        uninstall_routes()

    def test_routes_reach_the_app_and_come_off_cleanly(self):
        original = httpx.AsyncClient.__init__
        install_routes(InProcessTransport(echo_app), origins_for_port(4141))
        self.assertTrue(routes_installed())

        async def scenario():
            async with httpx.AsyncClient() as client:
                return (await client.get(f"{BASE}/v1/ping?x=1")).text
        self.assertEqual(run(scenario()), "GET /v1/ping x=1 ")
        self.assertTrue(uninstall_routes())
        self.assertIs(httpx.AsyncClient.__init__, original)
        self.assertFalse(routes_installed())

    def test_only_the_chosen_origins_are_routed(self):
        transport = InProcessTransport(echo_app)
        install_routes(transport, origins_for_port(4141))
        client = httpx.AsyncClient()
        self.addCleanup(lambda: asyncio.run(client.aclose()))
        self.assertIs(client._transport_for_url(httpx.URL("http://localhost:4141/v1/models")), transport)
        self.assertIs(client._transport_for_url(httpx.URL("http://127.0.0.1:4141/v1/models")), transport)
        self.assertIsNot(client._transport_for_url(httpx.URL("http://localhost:4142/v1/models")), transport)
        self.assertIsNot(client._transport_for_url(httpx.URL("https://api.github.com/user")), transport)

    def test_double_install_fails(self):
        install_routes(InProcessTransport(echo_app), origins_for_port(4141))
        with self.assertRaises(RuntimeError):
            install_routes(InProcessTransport(echo_app), origins_for_port(4141))

    def test_bad_ports_are_rejected(self):
        for port in (0, 70000, "4141", True):
            with self.subTest(port=port):
                with self.assertRaises(ValueError):
                    origins_for_port(port)


class CopilotAppTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        models = {"data": [{"id": "gpt-4o", "_raw_model_id": "gpt-4o", "vendor": "Azure OpenAI", "name": "GPT-4o"}]}
        for patcher in (
            mock.patch.object(config, "SETTINGS_PATH", Path(tmp.name) / "settings.json"),
            mock.patch.object(state, "models", models),
            mock.patch.object(state, "copilot_token", None),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        from copilot_api.server import asgi_app
        install_routes(InProcessTransport(asgi_app), origins_for_port(4141))
        self.addCleanup(uninstall_routes)

    def request(self, method, path, **kwargs):
        async def scenario():
            # Patched inside the loop, so only the request itself is checked.
            with mock.patch.object(socket.socket, "bind", refuse), \
                    mock.patch.object(socket.socket, "listen", refuse), \
                    mock.patch.object(socket.socket, "connect", refuse):
                async with httpx.AsyncClient(timeout=5.0) as client:
                    return await client.request(method, f"{BASE}{path}", **kwargs)
        return run(scenario())

    def test_models_need_no_socket(self):
        resp = self.request("GET", "/v1/models")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual([m["id"] for m in data], ["gpt-4o"])
        self.assertEqual(data[0]["multiplier"], 1.0)

    def test_anthropic_routes_report_when_unavailable(self):
        with mock.patch("copilot_api.server.TRANSLATOR_MODULE", "missing_translator_pkg.translator"):
            resp = self.request("POST", "/v1/messages", json={"model": "gpt-4o", "messages": []})
        self.assertEqual(resp.status_code, 501)
        self.assertIn("--server", resp.json()["error"]["message"])


class BoundaryTests(unittest.TestCase):
    def python(self, code):
        return subprocess.run([sys.executable, "-c", code], cwd=str(ROOT), capture_output=True, text=True)

    def test_copilot_modules_never_load_src_or_uvicorn(self):
        code = ("import sys, main, copilot_api.server, copilot_api.embed.launcher\n"
                "loaded = [m for m in ('src', 'uvicorn', 'PySide6') if m in sys.modules]\n"
                "print(loaded)\n"
                "sys.exit(1 if loaded else 0)\n")
        result = self.python(code)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_activation_loads_the_clone(self):
        with tempfile.TemporaryDirectory() as tmp:
            ui = make_combine(Path(tmp) / "CombineWebUI")
            (ui / "src" / "__init__.py").write_text("", encoding="utf-8")
            (ui / "src" / "config.py").write_text("MARKER = 'combine'\n", encoding="utf-8")
            code = ("import sys\n"
                    "from copilot_api.embed.launcher import activate_combine\n"
                    f"activate_combine({str(ui)!r})\n"
                    "import src.config\n"
                    "sys.exit(0 if src.config.MARKER == 'combine' else 1)\n")
            result = self.python(code)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_activation_refuses_a_preloaded_src(self):
        with tempfile.TemporaryDirectory() as tmp:
            ui = make_combine(Path(tmp) / "CombineWebUI")
            (ui / "src" / "__init__.py").write_text("", encoding="utf-8")
            code = ("import sys, src\n"
                    "from copilot_api.embed.launcher import EmbedError, activate_combine\n"
                    "try:\n"
                    f"    activate_combine({str(ui)!r})\n"
                    "except EmbedError:\n"
                    "    sys.exit(0)\n"
                    "sys.exit(1)\n")
            result = self.python(code)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
