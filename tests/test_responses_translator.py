import json
import unittest

from copilot_api import responses_translator as rt

CODEX = "gpt-5.3-codex"


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            "model": CODEX,
            "stream": True,
            "max_tokens": 1000,
            "reasoning_effort": "high",
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": "Be brief."},
                {"role": "user", "content": [
                    {"type": "text", "text": "What is this?"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ]},
                {"role": "assistant", "content": None, "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "look", "arguments": '{"x":1}'}},
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "a cat"},
            ],
            "tools": [{"type": "function", "function": {"name": "look", "description": "Look", "parameters": {"type": "object"}}}],
            "tool_choice": {"type": "function", "function": {"name": "look"}},
        }

    def test_messages_become_input_items(self):
        body = rt.chat_to_responses(self.payload)
        self.assertEqual(body["instructions"], "Be brief.")
        self.assertEqual([item["type"] for item in body["input"]], ["message", "function_call", "function_call_output"])
        user = body["input"][0]
        self.assertEqual(user["content"][0], {"type": "input_text", "text": "What is this?"})
        self.assertEqual(user["content"][1]["type"], "input_image")
        self.assertEqual(body["input"][1]["call_id"], "call_1")
        self.assertEqual(body["input"][2], {"type": "function_call_output", "call_id": "call_1", "output": "a cat"})

    def test_options_are_mapped(self):
        body = rt.chat_to_responses(self.payload)
        self.assertEqual(body["max_output_tokens"], 1000)
        self.assertEqual(body["reasoning"], {"effort": "high", "summary": "auto"})
        self.assertEqual(body["tools"][0]["name"], "look")
        self.assertEqual(body["tool_choice"], {"type": "function", "name": "look"})
        self.assertTrue(body["stream"])
        self.assertFalse(body["store"])
        self.assertNotIn("temperature", body)

    def test_bad_payload(self):
        with self.assertRaises(ValueError):
            rt.chat_to_responses({"model": "x", "messages": "hi"})


class ReplyTests(unittest.TestCase):
    def test_reply_becomes_a_chat_completion(self):
        data = {
            "id": "resp_1", "model": CODEX, "created_at": 100, "status": "completed",
            "output": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Thinking."}]},
                {"type": "message", "content": [{"type": "output_text", "text": "Hello"}]},
            ],
            "usage": {"input_tokens": 5, "output_tokens": 7, "output_tokens_details": {"reasoning_tokens": 3}},
        }
        reply = rt.responses_to_chat(data, CODEX)
        message = reply["choices"][0]["message"]
        self.assertEqual(message["content"], "Hello")
        self.assertEqual(message["reasoning_content"], "Thinking.")
        self.assertEqual(reply["choices"][0]["finish_reason"], "stop")
        self.assertEqual(reply["usage"]["total_tokens"], 12)
        self.assertEqual(reply["usage"]["completion_tokens_details"]["reasoning_tokens"], 3)

    def test_tool_calls_and_truncation(self):
        data = {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
                "output": [{"type": "function_call", "call_id": "call_9", "name": "run", "arguments": "{}"}]}
        choice = rt.responses_to_chat(data, "m")["choices"][0]
        self.assertIsNone(choice["message"]["content"])
        self.assertEqual(choice["message"]["tool_calls"][0]["id"], "call_9")
        self.assertEqual(choice["finish_reason"], "length")

    def test_bad_reply(self):
        with self.assertRaises(ValueError):
            rt.responses_to_chat([], "m")


class StreamTests(unittest.TestCase):
    def run_events(self, events):
        state = rt.ResponsesStreamState(CODEX)
        chunks = []
        for event in events:
            chunks.extend(rt.event_to_chunks(event["type"], json.dumps(event), state))
        return state, chunks

    def test_text_reasoning_and_tools(self):
        state, chunks = self.run_events([
            {"type": "response.created", "response": {"id": "resp_1", "model": CODEX}},
            {"type": "response.reasoning_summary_text.delta", "delta": "Hmm"},
            {"type": "response.output_text.delta", "delta": "Hi"},
            {"type": "response.output_item.added", "output_index": 2,
             "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "run"}},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 2, "delta": '{"a":'},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 2, "delta": "1}"},
            {"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 1, "output_tokens": 2}}},
        ])
        deltas = [chunk["choices"][0]["delta"] for chunk in chunks]
        self.assertEqual(deltas[0], {"role": "assistant", "reasoning_content": "Hmm"})
        self.assertEqual(deltas[1], {"content": "Hi"})
        self.assertEqual(deltas[2]["tool_calls"][0]["id"], "call_1")
        arguments = "".join(delta["tool_calls"][0]["function"]["arguments"] for delta in deltas[2:5])
        self.assertEqual(arguments, '{"a":1}')
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "tool_calls")
        self.assertEqual(chunks[-1]["usage"]["total_tokens"], 3)
        self.assertTrue(state.finished)
        self.assertTrue(all(chunk["id"] == "resp_1" for chunk in chunks))

    def test_failure_raises(self):
        with self.assertRaises(rt.ResponsesStreamError):
            self.run_events([{"type": "response.failed", "response": {"error": {"message": "nope"}}}])

    def test_unknown_and_unreadable_events_are_ignored(self):
        state = rt.ResponsesStreamState(CODEX)
        self.assertEqual(rt.event_to_chunks("response.output_text.done", '{"text": "Hi"}', state), [])
        self.assertEqual(rt.event_to_chunks("message", "[DONE]", state), [])


if __name__ == "__main__":
    unittest.main()
