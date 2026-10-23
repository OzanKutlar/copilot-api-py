import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import setup
from copilot_api import menu

ROOT = Path(__file__).resolve().parent.parent
MODE_NAME_RE = re.compile(r"^[a-z][a-z-]*$")
HAS_BASH = os.name != "nt" and shutil.which("bash") is not None


class GuardTests(unittest.TestCase):
    def test_packaging_commands_are_refused(self):
        for command in ("egg_info", "bdist_wheel", "install", "develop"):
            with self.subTest(command=command):
                self.assertIsNotNone(setup.packaging_refusal([command], modules={}))

    def test_normal_runs_are_allowed(self):
        self.assertIsNone(setup.packaging_refusal([], modules={}))
        self.assertIsNone(setup.packaging_refusal(["--mode", "proxy"], modules={}))

    def test_build_backend_is_refused(self):
        self.assertIsNotNone(setup.packaging_refusal([], modules={"setuptools.build_meta": object()}))

    def test_egg_info_exits_before_touching_anything(self):
        result = subprocess.run([sys.executable, "setup.py", "egg_info"], cwd=str(ROOT),
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not a packaging script", result.stderr)


class ModeTests(unittest.TestCase):
    def test_without_a_clone_only_the_proxy_is_offered(self):
        self.assertEqual([m.name for m in setup.available_modes(False)], ["proxy"])

    def test_with_a_clone_every_mode_is_offered(self):
        names = [m.name for m in setup.available_modes(True)]
        self.assertEqual(names, ["desktop", "proxy", "ui-desktop", "ui-browser", "ui-cli"])
        self.assertTrue(all(MODE_NAME_RE.match(name) for name in names))

    def test_commands_point_at_the_clone(self):
        desktop = setup.find_mode("desktop")
        self.assertEqual(setup.command_for(desktop, "CombineWebUI"), ["main.py", "start", "--ui-dir", "CombineWebUI"])
        with self.assertRaises(ValueError):
            setup.command_for(desktop, None)

    def test_requirements_are_deduplicated(self):
        paths = setup.requirement_paths(setup.available_modes(True), "CombineWebUI", ROOT)
        shown = [p.relative_to(ROOT).as_posix() for p in paths]
        self.assertEqual(shown, ["requirements.txt", "CombineWebUI/requirements-desktop.txt",
                                 "CombineWebUI/requirements.txt", "CombineWebUI/requirements-cli.txt"])

    def test_ui_reference(self):
        self.assertEqual(setup.ui_reference(ROOT / "CombineWebUI", ROOT), "CombineWebUI")
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(setup.ui_reference(Path(tmp), ROOT), str(Path(tmp).resolve()))


class RunScriptTests(unittest.TestCase):
    def setUp(self):
        self.modes = setup.available_modes(True)
        self.text = setup.render_run_script(self.modes, "desktop", "CombineWebUI")

    def test_every_mode_has_a_case(self):
        for mode in self.modes:
            self.assertIn(f"    {mode.name}) exec", self.text)
        self.assertIn("MODE=desktop", self.text)
        self.assertIn('${@+"$@"}', self.text)

    def test_no_absolute_paths(self):
        self.assertNotIn(str(ROOT), self.text)

    def test_unknown_default_is_rejected(self):
        with self.assertRaises(ValueError):
            setup.render_run_script(self.modes, "nope", "CombineWebUI")

    @unittest.skipUnless(HAS_BASH, "needs bash")
    def test_bash_syntax(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.sh"
            setup.write_atomic(path, self.text, executable=True)
            self.assertTrue(os.access(path, os.X_OK))
            result = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(HAS_BASH, "needs bash")
    def test_script_runs_the_right_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            setup.write_atomic(root / ".venv" / "bin" / "python", '#!/bin/sh\necho "$@"\n', executable=True)
            script = root / "run.sh"
            setup.write_atomic(script, self.text, executable=True)

            def run(*args):
                result = subprocess.run(["bash", str(script), *args], capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()

            self.assertEqual(run(), "main.py start --ui-dir CombineWebUI")
            self.assertEqual(run("proxy", "--verbose"), "main.py start --server --verbose")
            self.assertEqual(run("--verbose"), "main.py start --ui-dir CombineWebUI --verbose")
            self.assertEqual(run("ui-cli"), "CombineWebUI/main.py cli")


class LaunchFileTests(unittest.TestCase):
    def test_round_trip_and_corrupt_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".launch.json"
            self.assertEqual(setup.read_launch(path), {})
            setup.write_launch(path, "proxy", None)
            data = setup.read_launch(path)
            self.assertEqual((data["mode"], data["ui_dir"]), ("proxy", None))
            path.write_text("{not json", encoding="utf-8")
            self.assertEqual(setup.read_launch(path), {})


class StampTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.req = self.dir / "requirements.txt"
        self.req.write_text("rich\n", encoding="utf-8")
        self.stamp = self.dir / "stamp.json"
        self.calls = []

    def installer(self, path):
        self.calls.append(path)
        return True, ""

    def install(self, force=False, installer=None):
        return setup.install_requirements([self.req], self.stamp, installer or self.installer, force)

    def test_unchanged_files_are_skipped(self):
        self.assertTrue(self.install()[0])
        self.install()
        self.assertEqual(len(self.calls), 1)
        self.req.write_text("rich\nhttpx\n", encoding="utf-8")
        self.install()
        self.assertEqual(len(self.calls), 2)
        self.install(force=True)
        self.assertEqual(len(self.calls), 3)

    def test_failures_are_not_recorded(self):
        ok, report = self.install(installer=lambda path: (False, "boom"))
        self.assertFalse(ok)
        self.assertIn(("dim", "boom"), report)
        self.install()
        self.assertEqual(len(self.calls), 1)

    def test_missing_file(self):
        self.req.unlink()
        ok, _ = self.install()
        self.assertFalse(ok)
        self.assertEqual(self.calls, [])


class MenuFallbackTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(menu, "select_option", side_effect=menu.MenuUnavailable("no terminal"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def pick(self, answers, default=0):
        replies = iter(answers)
        return menu.select_or_number("Pick", ["a", "b", "c"], None, default, ask=lambda prompt: next(replies))

    def test_number(self):
        self.assertEqual(self.pick(["2"]), 1)

    def test_enter_takes_the_default(self):
        self.assertEqual(self.pick([""], default=2), 2)

    def test_q_cancels(self):
        self.assertIsNone(self.pick(["q"]))

    def test_gives_up_after_invalid_answers(self):
        self.assertIsNone(self.pick(["x"] * menu.MAX_NUMBERED_ATTEMPTS))

    def test_eof_cancels(self):
        def ask(prompt):
            raise EOFError
        self.assertIsNone(menu.select_or_number("Pick", ["a"], None, 0, ask=ask))


if __name__ == "__main__":
    unittest.main()
