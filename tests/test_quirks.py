import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from copilot_api import config, quirks
from copilot_api.config import state

HAIKU = "claude-haiku-4.5"
CODEX = "gpt-5.3-codex"
HAIKU_ERROR = json.dumps({"error": {
    "message": 'reasoning_effort "none" was provided, but model claude-haiku-4.5 does not support reasoning effort',
    "code": "invalid_reasoning_effort"}})
MAX_TOKENS_ERROR = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
CODEX_ERROR = json.dumps({"error": {
    "message": "model gpt-5.3-codex is not accessible via the /chat/completions endpoint",
    "code": "unsupported_api_for_model"}})
NONE_ERROR = json.dumps({"error": {
    "message": "Unsupported value: 'none' is not supported with this model.",
    "param": "reasoning.effort", "code": "unsupported_value"}})


class QuirkTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "model_quirks.json"
        for patcher in (
            mock.patch.object(config, "MODEL_QUIRKS_PATH", self.path),
            mock.patch.object(state, "quirks", {key: [] for key in config.QUIRK_KEYS}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def learn(self, error, payload, model, route=quirks.ROUTE_CHAT):
        rule = quirks.match_rule(error, payload, route)
        self.assertIsNotNone(rule)
        quirks.record(rule, model)
        return rule, rule.fix(payload, route)

    def test_reasoning_effort_is_learned_then_avoided(self):
        rule, route = self.learn(HAIKU_ERROR, {"reasoning_effort": "none"}, HAIKU)
        self.assertEqual((rule.key, route), ("no_reasoning_effort", quirks.ROUTE_CHAT))
        later = {"reasoning_effort": "high"}
        self.assertEqual(quirks.apply_known(later, HAIKU, quirks.ROUTE_CHAT), (quirks.ROUTE_CHAT, ["no_reasoning_effort"]))
        self.assertNotIn("reasoning_effort", later)
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved["no_reasoning_effort"], [HAIKU])

    def test_recording_twice_is_a_no_op(self):
        rule = quirks.RULES[0]
        self.assertTrue(quirks.record(rule, CODEX))
        self.assertFalse(quirks.record(rule, CODEX))
        self.assertEqual(state.quirks[rule.key], [CODEX])

    def test_max_tokens_is_renamed(self):
        payload = {"max_tokens": 100}
        rule, _ = self.learn(MAX_TOKENS_ERROR, payload, "o9")
        self.assertEqual(rule.key, "requires_max_completion_tokens")
        self.assertEqual(payload, {"max_completion_tokens": 100})

    def test_responses_only_changes_the_route(self):
        rule, route = self.learn(CODEX_ERROR, {}, CODEX)
        self.assertEqual((rule.key, route), ("responses_only", quirks.ROUTE_RESPONSES))
        self.assertEqual(quirks.apply_known({}, CODEX, quirks.ROUTE_CHAT)[0], quirks.ROUTE_RESPONSES)

    def test_only_none_effort_is_dropped(self):
        rule, _ = self.learn(NONE_ERROR, {"reasoning_effort": "none"}, CODEX, quirks.ROUTE_RESPONSES)
        self.assertEqual(rule.key, "rejects_reasoning_effort_none")
        kept = {"reasoning_effort": "high"}
        quirks.apply_known(kept, CODEX, quirks.ROUTE_RESPONSES)
        self.assertEqual(kept, {"reasoning_effort": "high"})

    def test_unrecognised_errors_learn_nothing(self):
        error = '{"error":{"message":"rate limited"}}'
        self.assertIsNone(quirks.match_rule(error, {"reasoning_effort": "none"}, quirks.ROUTE_CHAT))

    def test_a_rule_needs_something_to_fix(self):
        self.assertIsNone(quirks.match_rule(HAIKU_ERROR, {}, quirks.ROUTE_CHAT))

    def test_tried_rules_are_skipped(self):
        payload = {"reasoning_effort": "high"}
        self.assertIsNone(quirks.match_rule(HAIKU_ERROR, payload, quirks.ROUTE_CHAT, {"no_reasoning_effort"}))


class QuirkFileTests(unittest.TestCase):
    def test_rule_keys_match_the_config(self):
        self.assertEqual({rule.key for rule in quirks.RULES}, set(config.QUIRK_KEYS))

    def test_old_and_corrupt_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model_quirks.json"
            with mock.patch.object(config, "MODEL_QUIRKS_PATH", path):
                path.write_text('{"requires_max_completion_tokens": ["o9"]}')
                loaded = config.load_model_quirks()
                self.assertEqual(loaded["requires_max_completion_tokens"], ["o9"])
                self.assertEqual(loaded["no_reasoning_effort"], [])
                path.write_text("{not json")
                self.assertEqual(config.load_model_quirks(), {key: [] for key in config.QUIRK_KEYS})


if __name__ == "__main__":
    unittest.main()
