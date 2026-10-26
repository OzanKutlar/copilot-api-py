import asyncio
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

from copilot_api import chat, config
from copilot_api.config import state
from copilot_api.utils import HTTPError, redact_secrets

WAIT_SECONDS = 10.0
HAIKU = "claude-haiku-4.5"
CODEX = "gpt-5.3-codex"
HAIKU_ERROR = {"error": {
    "message": 'reasoning_effort "none" was provided, but model claude-haiku-4.5 does not support reasoning effort',
    "code": "invalid_reasoning_effort"}}
CODEX_ERROR = {"error": {
    "message": "model gpt-5.3-codex is not accessible via the /chat/completions endpoint",
    "code": "unsupported_api_for_model"}}
CHAT_REPLY = {"id": "c1", "object": "chat.completion",
              "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]}
RESPONSES_REPLY = {"id": "r1", "status": "completed",
                   "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]}
RESPONSES_EVENTS = (
    {"type": "response.created", "response": {"id": "resp_1", "model": CODEX}},
    {"type": "response.output_text.delta", "delta": "Hello"},
    {"type": "response.completed", "response": {"status": "completed"}},
)
SSE_HEADERS = {"content-type": "text/event-stream"}


def sse_body(events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, WAIT_SECONDS))


def message(model, **extra):
    return {"model": model, "messages": [{"role": "user", "content": "hi"}], **extra}


class ChatTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        folder = Path(tmp.name)
        self.models = {"data": [{"id": HAIKU}, {"id": CODEX}, {"id": "gpt-4o"}]}
        self.calls = []
        self.reply = lambda path, body: httpx.Response(500, text="no reply set")
        for patcher in (
            mock.patch.object(config, "SETTINGS_PATH", folder / "settings.json"),
            mock.patch.object(config, "MODEL_QUIRKS_PATH", folder / "model_quirks.json"),
            mock.patch.object(state, "quirks", {key: [] for key in config.QUIRK_KEYS}),
            mock.patch.object(state, "models", self.models),
            mock.patch.object(state, "copilot_token", "test-token"),
            mock.patch.object(chat, "get_client", self.client),
            mock.patch.object(chat, "display_usage", mock.AsyncMock()),
            mock.patch("sys.stdout", new_callable=io.StringIO),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def client(self, timeout=60.0):
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle), timeout=timeout)

    def handle(self, request):
        body = json.loads(request.content)
        self.calls.append((request.url.path, body))
        return self.reply(request.url.path, body)

    def test_reasoning_effort_error_is_learned_once(self):
        def reply(path, body):
            if "reasoning_effort" in body:
                return httpx.Response(400, json=HAIKU_ERROR)
            return httpx.Response(200, json=CHAT_REPLY)
        self.reply = reply
        first = run(chat.create_chat_completions(message(HAIKU, reasoning_effort="none")))
        second = run(chat.create_chat_completions(message(HAIKU, reasoning_effort="none")))
        self.assertEqual(first["choices"][0]["message"]["content"], "hi")
        self.assertEqual(second["choices"][0]["message"]["content"], "hi")
        # The first request costs one rejected attempt; the second goes straight through.
        self.assertEqual(len(self.calls), 3)
        self.assertIn(HAIKU, state.quirks["no_reasoning_effort"])

    def test_codex_is_moved_to_responses_and_streams(self):
        def reply(path, body):
            if path == "/chat/completions":
                return httpx.Response(400, json=CODEX_ERROR)
            return httpx.Response(200, content=sse_body(RESPONSES_EVENTS), headers=SSE_HEADERS)
        self.reply = reply

        async def collect():
            stream = await chat.create_chat_completions(message(CODEX, stream=True), stream=True)
            return [line async for line in stream]

        text = "".join(run(collect()))
        self.assertIn('"content":"Hello"', text)
        self.assertTrue(text.endswith("data: [DONE]\n\n"))
        self.assertEqual([path for path, _ in self.calls], ["/chat/completions", "/responses"])
        self.assertEqual(self.calls[1][1]["input"][0]["content"][0]["text"], "hi")
        self.assertIn(CODEX, state.quirks["responses_only"])

    def test_catalog_endpoints_skip_the_failed_attempt(self):
        self.models["data"][1]["supported_endpoints"] = ["/responses"]
        self.reply = lambda path, body: httpx.Response(200, json=RESPONSES_REPLY)
        reply = run(chat.create_chat_completions(message(CODEX)))
        self.assertEqual(reply["choices"][0]["message"]["content"], "ok")
        self.assertEqual([path for path, _ in self.calls], ["/responses"])

    def test_missing_model_gets_a_clear_404(self):
        self.reply = lambda path, body: httpx.Response(404, text="404 page not found")
        with self.assertRaises(HTTPError) as caught:
            run(chat.create_chat_completions(message("gpt-9-codex")))
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(caught.exception.data["error"]["code"], "model_not_found")

    def test_unrecognised_errors_are_not_retried(self):
        self.reply = lambda path, body: httpx.Response(400, json={"error": {"message": "bad", "code": "other"}})
        with self.assertRaises(HTTPError) as caught:
            run(chat.create_chat_completions(message(HAIKU, reasoning_effort="none")))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(state.quirks["no_reasoning_effort"], [])


class RedactTests(unittest.TestCase):
    def test_tokens_are_masked(self):
        with mock.patch.object(state, "show_token", False):
            text = redact_secrets('{"token":"tid=secretsecretsecret;exp=1","sku":"free"}')
        self.assertNotIn("secretsecretsecret", text)
        self.assertIn('"sku":"free"', text)

    def test_show_token_keeps_them(self):
        with mock.patch.object(state, "show_token", True):
            self.assertIn("secretsecretsecret", redact_secrets('{"token":"secretsecretsecret"}'))


if __name__ == "__main__":
    unittest.main()
