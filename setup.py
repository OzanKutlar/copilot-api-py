#!/usr/bin/env python3
"""One-command setup for copilot-api, and for CombineWebUI when it is cloned inside.

    python3 setup.py        create .venv, pick a mode, install what it needs, write run.sh
    ./run.sh                run the chosen mode
    ./run.sh --menu         pick another default mode

This is NOT a packaging script. pip and setuptools run any setup.py they find, so
packaging commands are refused before anything is touched.

Stage 1 runs on the system Python with the standard library only: it creates .venv
and installs the two packages the menu needs. Stage 2 is this same file re-run by
the venv's Python, with the arrow-key picker ported from the Book Translator.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
import venv
from collections import deque
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV_DIR = ROOT / ".venv"
LAUNCH_FILE = ROOT / ".launch.json"
RUN_SCRIPT = ROOT / "run.sh"
RUN_PYTHON = ".venv/bin/python"
STAMP_FILENAME = ".combine-setup.json"
COPILOT_REQUIREMENTS = ROOT / "requirements.txt"
MIN_PYTHON = (3, 9)
BOOTSTRAP_PACKAGES = ("rich>=13.0.0", "prompt_toolkit>=3.0.0")
BOOTSTRAP_CHECK = "import rich, prompt_toolkit"
STAGE2_FLAG = "--stage2"
PIP_TIMEOUT_SECONDS = 1800
GIT_TIMEOUT_SECONDS = 600
AUTH_TIMEOUT_SECONDS = 1200
TEST_TIMEOUT_SECONDS = 900
PROBE_TIMEOUT_SECONDS = 60
OUTPUT_TAIL_LINES = 25
MAX_PROMPT_ATTEMPTS = 5
MAX_CHOICE_ROUNDS = 3
LAUNCH_VERSION = 1
DEFAULT_CLONE_URL = "https://github.com/OzanKutlar/CombineWebUI.git"
CLONE_DIRNAME = "CombineWebUI"
CLONE_LABEL = "＋ Clone CombineWebUI now…"
UI_PLACEHOLDER = "{ui}"
VENDOR_FILES = ("tailwindcss.js", "lucide.js", "marked.min.js", "purify.min.js")
PACKAGING_COMMANDS = frozenset((
    "egg_info", "dist_info", "bdist_wheel", "bdist_egg", "bdist", "sdist", "build", "build_py",
    "build_ext", "install", "develop", "editable_wheel", "clean", "check", "register", "upload",
))
BUILD_MODULES = ("setuptools.build_meta", "pip._internal")
CERT_HINT = ("Certificate error: with the python.org installer on macOS, run 'Install Certificates.command' "
             "from its Applications folder, then run setup again.")
VENV_HINT = "On Debian or Ubuntu, install the python3-venv package first."


class SetupError(RuntimeError):
    """Setup cannot continue. The message is shown to the user as is."""


@dataclass(frozen=True)
class Mode:
    """One thing run.sh can start. '{ui}' in command and requirements is the CombineWebUI clone."""

    name: str
    label: str
    hint: str
    command: tuple
    requirements: tuple
    needs_ui: bool = False
    copilot: bool = False
    desktop: bool = False


MODES = (
    Mode("desktop", "Copilot desktop (embedded)", "no ports · Copilot built into the CombineWebUI window",
         ("main.py", "start", "--ui-dir", UI_PLACEHOLDER),
         ("requirements.txt", f"{UI_PLACEHOLDER}/requirements-desktop.txt"),
         needs_ui=True, copilot=True, desktop=True),
    Mode("proxy", "Copilot API proxy", "listens on port 4141 · for Claude Code and other API clients",
         ("main.py", "start", "--server"), ("requirements.txt",), copilot=True),
    Mode("ui-desktop", "CombineWebUI desktop only", "no ports · uses the endpoints in CombineWebUI's Settings",
         (f"{UI_PLACEHOLDER}/main.py", "desktop"), (f"{UI_PLACEHOLDER}/requirements-desktop.txt",),
         needs_ui=True, desktop=True),
    Mode("ui-browser", "CombineWebUI in the browser", "listens on port 4142 · open http://localhost:4142/",
         (f"{UI_PLACEHOLDER}/main.py", "start"), (f"{UI_PLACEHOLDER}/requirements.txt",), needs_ui=True),
    Mode("ui-cli", "CombineWebUI CLI", "no server, no API calls · the conversation goes through the clipboard",
         (f"{UI_PLACEHOLDER}/main.py", "cli"), (f"{UI_PLACEHOLDER}/requirements-cli.txt",), needs_ui=True),
)


# ======================================================================
# Pure helpers (standard library only, used by both stages and the tests)
# ======================================================================

def packaging_refusal(argv, modules=None):
    """Why this script must not run for argv, or None when it may."""
    loaded = sys.modules if modules is None else modules
    first = argv[0] if argv else ""
    if first in PACKAGING_COMMANDS:
        return (f"setup.py is this repo's installer, not a packaging script; '{first}' is a setuptools command. "
                "Run `python3 setup.py` with no arguments to set up copilot-api.")
    if any(name in loaded for name in BUILD_MODULES):
        return ("setup.py is this repo's installer, not a packaging script, and cannot be built by pip. "
                "Run `python3 setup.py` instead.")
    return None


def available_modes(has_ui):
    """Modes that can run here, in menu order."""
    return tuple(mode for mode in MODES if has_ui or not mode.needs_ui)


def find_mode(name):
    for mode in MODES:
        if mode.name == name:
            return mode
    return None


def ui_reference(ui_dir, root=ROOT):
    """The clone's path for run.sh: relative to root when inside it, else absolute."""
    resolved = Path(ui_dir).resolve()
    try:
        return resolved.relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        return str(resolved)


def _substitute(value, ui_ref):
    if UI_PLACEHOLDER not in value:
        return value
    if not ui_ref:
        raise ValueError(f"'{value}' needs a CombineWebUI clone")
    return value.replace(UI_PLACEHOLDER, ui_ref)


def command_for(mode, ui_ref):
    """The arguments run.sh passes to the venv's Python for mode."""
    return [_substitute(part, ui_ref) for part in mode.command]


def requirement_paths(modes, ui_ref, root=ROOT):
    """Requirement files for modes, without duplicates, in order."""
    paths, seen = [], set()
    for mode in modes:
        for item in mode.requirements:
            path = Path(root) / _substitute(item, ui_ref)
            key = str(path.resolve())
            if key not in seen:
                seen.add(key)
                paths.append(path)
    return paths


def _script_case(mode, ui_ref):
    arguments = " ".join(shlex.quote(part) for part in command_for(mode, ui_ref))
    return f'    {mode.name}) exec "$PY" {arguments} ${{@+"$@"}} ;;'


def render_run_script(modes, default_name, ui_ref):
    """The text of run.sh. ${@+"$@"} keeps macOS's bash 3.2 happy under set -u with no arguments."""
    names = [mode.name for mode in modes]
    if default_name not in names:
        raise ValueError(f"Unknown default mode {default_name!r}")
    width = max(len(name) for name in names)
    header = [
        "#!/bin/bash",
        "# Generated by setup.py. Run `python3 setup.py` again to change it.",
        "#",
        f"#   ./run.sh                 run the default mode ({default_name})",
        "#   ./run.sh <mode> [args]   run another mode once; extra args go to its command",
        "#   ./run.sh --menu          pick a new default mode, then run it",
        "#",
        "# Modes:",
    ]
    header += [f"#   {mode.name.ljust(width)}  {mode.label}: {mode.hint}" for mode in modes]
    body = [
        "set -euo pipefail",
        'cd "$(dirname "$0")"',
        "",
        f"PY={shlex.quote(RUN_PYTHON)}",
        'if [ ! -x "$PY" ]; then',
        '    echo "No virtual environment at $(pwd)/.venv. Run: python3 setup.py" >&2',
        "    exit 1",
        "fi",
        "",
        f"MODE={shlex.quote(default_name)}",
        'if [ "$#" -gt 0 ]; then',
        '    case "$1" in',
        "        --menu)",
        "            shift",
        '            "$PY" setup.py --menu',
        '            exec ./run.sh ${@+"$@"}',
        "            ;;",
        f"        {'|'.join(names)})",
        '            MODE="$1"',
        "            shift",
        "            ;;",
        "    esac",
        "fi",
        "",
        'case "$MODE" in',
        *[_script_case(mode, ui_ref) for mode in modes],
        "esac",
        'echo "Unknown mode: $MODE" >&2',
        "exit 2",
        "",
    ]
    return "\n".join(header + body)


def write_atomic(path, text, executable=False):
    """Write via a temp file and rename, so a crash never leaves half a file. Raises OSError."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.chmod(temp, 0o755 if executable else 0o644)
        os.replace(temp, target)
    except OSError:
        try:
            os.remove(temp)
        except OSError:
            pass  # the write error being re-raised is the one that matters
        raise


def read_launch(path=LAUNCH_FILE):
    """The saved choices, or {} when there are none or the file is unreadable."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_launch(path, mode_name, ui_ref):
    payload = {"version": LAUNCH_VERSION, "mode": mode_name, "ui_dir": ui_ref}
    write_atomic(path, json.dumps(payload, indent=2) + "\n")


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _display(path):
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _load_stamp(path):
    data = read_launch(path)
    files = data.get("files")
    return dict(files) if isinstance(files, dict) else {}


def install_requirements(files, stamp_path, installer, force=False):
    """Install each file whose content changed since its last successful install.

    installer(path) -> (ok, output_tail). Returns (all_ok, [(level, message), ...]).
    """
    stamp = _load_stamp(stamp_path)
    report, all_ok = [], True
    for path in files:
        shown = _display(path)
        if not Path(path).is_file():
            report.append(("fail", f"{shown} is missing."))
            all_ok = False
            continue
        key, digest = str(Path(path).resolve()), file_digest(path)
        if not force and stamp.get(key) == digest:
            report.append(("dim", f"{shown} is unchanged and already installed."))
            continue
        ok, tail = installer(path)
        if not ok:
            report.append(("fail", f"Installing {shown} failed."))
            if tail:
                report.append(("dim", tail))
            all_ok = False
            continue
        stamp[key] = digest
        try:
            write_atomic(stamp_path, json.dumps({"version": 1, "files": stamp}, indent=2) + "\n")
        except OSError as e:
            report.append(("warn", f"Could not record the install of {shown} ({e}); it is reinstalled next time."))
        report.append(("ok", f"Installed {shown}."))
    return all_ok, report


# ======================================================================
# Commands
# ======================================================================

def run_command(argv, timeout, stream=False, label=""):
    """Run argv in ROOT. Returns (ok, last lines of output). A failed command never raises."""
    command = [str(part) for part in argv]
    shown = label or " ".join(command)
    try:
        if stream:
            result = subprocess.run(command, cwd=str(ROOT), timeout=timeout)
            return result.returncode == 0, ""
        result = subprocess.run(command, cwd=str(ROOT), timeout=timeout, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors="replace")
    except subprocess.TimeoutExpired:
        return False, f"{shown} did not finish within {timeout}s."
    except OSError as e:
        return False, f"Could not start {shown}: {e}"
    tail = "\n".join(deque((result.stdout or "").splitlines(), maxlen=OUTPUT_TAIL_LINES))
    return result.returncode == 0, tail


def pip_install(python, arguments, verbose=False):
    ok, tail = run_command([python, "-m", "pip", "install", "--disable-pip-version-check", *arguments],
                           PIP_TIMEOUT_SECONDS, stream=verbose)
    if not ok and "CERTIFICATE" in tail.upper():
        tail = f"{tail}\n{CERT_HINT}"
    return ok, tail


# ======================================================================
# Stage 1: system Python, standard library only
# ======================================================================

def say(message):
    print(f"==> {message}", flush=True)


def complain(message):
    print(f"ERROR: {message}", file=sys.stderr, flush=True)


def venv_python(venv_dir=VENV_DIR):
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _inside_venv():
    try:
        return Path(sys.prefix).resolve() == VENV_DIR.resolve()
    except OSError:
        return False


def _venv_version(venv_dir):
    """(major, minor) recorded in pyvenv.cfg, or None."""
    try:
        lines = (venv_dir / "pyvenv.cfg").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        key, sep, value = line.partition("=")
        parts = value.strip().split(".")
        if sep and key.strip() in ("version", "version_info") and len(parts) >= 2 \
                and parts[0].isdigit() and parts[1].isdigit():
            return int(parts[0]), int(parts[1])
    return None


def _remove_venv():
    resolved = VENV_DIR.resolve()
    if resolved.parent != ROOT or resolved.name != VENV_DIR.name:
        raise SetupError(f"Refusing to delete {resolved}: it is not this repo's .venv.")
    try:
        shutil.rmtree(resolved)
    except OSError as e:
        raise SetupError(f"Could not delete {resolved}: {e}") from e


def _rebuild_reason(recreate, python):
    if recreate:
        return "--recreate was given"
    recorded = _venv_version(VENV_DIR)
    current = sys.version_info[:2]
    if recorded is None:
        return "its pyvenv.cfg is unreadable"
    if recorded != current:
        return f"it was built with Python {recorded[0]}.{recorded[1]}, not {current[0]}.{current[1]}"
    if not python.exists():
        return "its Python is missing"
    return None


def ensure_venv(recreate):
    """Create or reuse .venv. Returns its Python. Raises SetupError."""
    python = venv_python()
    if VENV_DIR.exists():
        reason = _rebuild_reason(recreate, python)
        if reason is None:
            say("Reusing .venv")
            return python
        say(f"Rebuilding .venv because {reason}")
        _remove_venv()
    say(f"Creating .venv with Python {platform.python_version()}")
    try:
        venv.EnvBuilder(with_pip=True, symlinks=os.name != "nt").create(str(VENV_DIR))
    except (OSError, subprocess.CalledProcessError) as e:
        raise SetupError(f"Could not create .venv: {e}. {VENV_HINT}") from e
    if not python.exists():
        raise SetupError(f"The new .venv has no Python at {python}. {VENV_HINT}")
    return python


def ensure_bootstrap(python, verbose):
    """Install the menu's packages into .venv unless they are already there."""
    present, _ = run_command([python, "-c", BOOTSTRAP_CHECK], PROBE_TIMEOUT_SECONDS)
    if present:
        return True
    say("Installing the setup menu's packages (rich, prompt_toolkit)")
    ok, tail = pip_install(python, ["--upgrade", "pip"], verbose)
    if not ok:
        say("Could not upgrade pip; continuing with the bundled version.")
    ok, tail = pip_install(python, list(BOOTSTRAP_PACKAGES), verbose)
    if not ok:
        complain("Installing rich and prompt_toolkit failed.")
        if tail:
            print(tail, file=sys.stderr)
    return ok


def stage1(args, argv):
    say(f"copilot-api setup · Python {platform.python_version()} at {sys.executable}")
    python = ensure_venv(args.recreate)
    if not ensure_bootstrap(python, args.verbose):
        return 1
    say("Starting the setup menu inside .venv")
    forwarded = [arg for arg in argv if arg not in (STAGE2_FLAG, "--recreate")]
    try:
        # Interactive session: no timeout. Every prompt inside it is bounded instead.
        result = subprocess.run([str(python), str(Path(__file__).resolve()), STAGE2_FLAG, *forwarded], cwd=str(ROOT))
    except OSError as e:
        raise SetupError(f"Could not start {python}: {e}") from e
    return result.returncode


# ======================================================================
# Stage 2: inside .venv, with rich and prompt_toolkit
# ======================================================================

def _esc(text):
    from rich.markup import escape
    return escape(str(text))


def _print_report(con, report):
    printers = {"ok": con.ok, "info": con.info, "warn": con.warn, "fail": con.fail, "dim": con.dim}
    for level, message in report:
        printers.get(level, con.info)(_esc(message))


def _confirm(con, question, default):
    suffix = "[Y/n]" if default else "[y/N]"
    prompt = f"[bold]{_esc(question)} {_esc(suffix)}: [/bold]"
    for _ in range(MAX_PROMPT_ATTEMPTS):
        try:
            answer = con.console.input(prompt).strip().lower()
        except (KeyboardInterrupt, EOFError):
            return False
        if not answer:
            return default
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        con.warn("Please answer y or n.")
    return False


def _ask_text(con, question, default):
    prompt = f"[bold]{_esc(question)} {_esc('[' + default + ']')}: [/bold]"
    try:
        answer = con.console.input(prompt).strip()
    except (KeyboardInterrupt, EOFError):
        return None
    return answer or default


def _detect_ui(con):
    try:
        from copilot_api.embed.detect import find_combine_webui
    except ImportError as e:
        con.warn(f"Could not load CombineWebUI detection ({_esc(e)}); only the proxy mode is offered.")
        return None
    found = find_combine_webui(ROOT)
    if found:
        con.ok(f"Found CombineWebUI at {_esc(found)}")
    else:
        con.info("No CombineWebUI clone in this folder.")
    return found


def _valid_clone_url(url):
    return bool(url) and not url.startswith("-") and not any(ch.isspace() for ch in url)


def _clone_ui(con, assume_yes):
    """Clone CombineWebUI into this repo. Returns its path, or None."""
    from copilot_api.embed.detect import is_combine_webui
    git = shutil.which("git")
    if git is None:
        con.fail("git is not installed. Run xcode-select --install (macOS), or clone CombineWebUI yourself.")
        return None
    target = ROOT / CLONE_DIRNAME
    if target.exists():
        con.fail(f"{_esc(target)} exists but is not a complete CombineWebUI clone. Fix or remove it, then run setup again.")
        return None
    url = DEFAULT_CLONE_URL if assume_yes else _ask_text(con, "Repository URL", DEFAULT_CLONE_URL)
    if url is None:
        return None
    if not _valid_clone_url(url):
        con.fail(f"{_esc(url)} is not a usable repository URL.")
        return None
    con.info(f"Cloning {_esc(url)} into {CLONE_DIRNAME}/ …")
    ok, tail = run_command([git, "clone", "--", url, target], GIT_TIMEOUT_SECONDS)
    if not ok:
        con.fail("git clone failed.")
        if tail:
            con.dim(_esc(tail))
        return None
    if not is_combine_webui(target):
        con.fail("The clone does not look like CombineWebUI (main.py, pages/index.html or src/desktop/app.py is missing).")
        return None
    con.ok(f"Cloned CombineWebUI into {CLONE_DIRNAME}/")
    return target.resolve()


def _mode_from_arg(name, modes):
    mode = find_mode(name)
    if mode is None:
        raise SetupError(f"Unknown mode '{name}'. Choose one of: {', '.join(m.name for m in MODES)}.")
    if mode not in modes:
        raise SetupError(f"Mode '{name}' needs a CombineWebUI clone in this folder. "
                         "Run python3 setup.py without --mode to get the clone option.")
    return mode


def _default_index(modes, name):
    for index, mode in enumerate(modes):
        if mode.name == name:
            return index
    return 0


def _choose_mode(con, args, ui_dir, launch):
    """(mode, ui_dir), or (None, ui_dir) when cancelled. The clone row may change ui_dir."""
    from copilot_api import menu
    for _ in range(MAX_CHOICE_ROUNDS):
        modes = available_modes(ui_dir is not None)
        if args.mode:
            return _mode_from_arg(args.mode, modes), ui_dir
        default = _default_index(modes, launch.get("mode"))
        if args.yes:
            return modes[default], ui_dir
        labels = [mode.label for mode in modes]
        hints = [mode.hint for mode in modes]
        if ui_dir is None:
            labels.append(CLONE_LABEL)
            hints.append("adds the desktop and CombineWebUI modes")
        index = menu.select_or_number("Choose what ./run.sh starts", labels, hints, default)
        if index is None:
            return None, ui_dir
        if index < len(modes):
            return modes[index], ui_dir
        ui_dir = _clone_ui(con, args.yes) or ui_dir
    return None, ui_dir


def _pip_requirements(con, python, path, verbose):
    con.info(f"Installing {_esc(_display(path))} … (large packages such as PySide6 can take a few minutes)")
    return pip_install(python, ["-r", str(path)], verbose)


def _ensure_vendor(con, python, ui_dir, assume_yes):
    """Offer CombineWebUI's fetch_vendor.py so its window needs no CDN."""
    vendor = ui_dir / "pages" / "static" / "vendor"
    missing = [name for name in VENDOR_FILES if not (vendor / name).is_file()]
    if not missing:
        con.dim("Browser libraries are already downloaded.")
        return
    script = ui_dir / "scripts" / "fetch_vendor.py"
    if not script.is_file():
        con.warn("This CombineWebUI clone has no scripts/fetch_vendor.py; its page loads the libraries from CDNs.")
        return
    if not assume_yes and not _confirm(con, f"Download {len(missing)} browser libraries so the window needs no CDN?", True):
        con.dim("Skipped; the page loads the missing libraries from CDNs.")
        return
    ok, _ = run_command([python, script], PIP_TIMEOUT_SECONDS, stream=True)
    if ok:
        con.ok("Browser libraries downloaded.")
    else:
        con.warn("Some browser libraries could not be downloaded; the page uses the CDNs for those.")


def _has_github_token():
    try:
        from copilot_api.config import GITHUB_TOKEN_PATH
        return GITHUB_TOKEN_PATH.is_file() and bool(GITHUB_TOKEN_PATH.read_text(encoding="utf-8").strip())
    except (OSError, ImportError):
        return False


def _offer_extras(con, python, mode, copilot_installed):
    if mode.copilot and not _has_github_token():
        if _confirm(con, "Sign in to GitHub now? (needed once for Copilot)", True):
            ok, _ = run_command([python, "main.py", "auth"], AUTH_TIMEOUT_SECONDS, stream=True)
            if ok:
                con.ok("Signed in to GitHub.")
            else:
                con.warn("Sign-in did not finish; ./run.sh asks again on first start.")
    if copilot_installed and _confirm(con, "Run the test suite now?", False):
        ok, _ = run_command([python, "-m", "unittest", "discover", "tests"], TEST_TIMEOUT_SECONDS, stream=True)
        if ok:
            con.ok("All tests passed.")
        else:
            con.warn("Some tests failed; see the output above.")


def _summary(con, mode, modes, installed_all):
    lines = [
        f"Default mode: [bold green]{_esc(mode.label)}[/bold green] ({_esc(mode.name)})",
        "",
        _esc("  ./run.sh                 start it"),
        _esc("  ./run.sh <mode> [args]   run another mode once"),
        _esc("  ./run.sh --menu          choose a new default"),
        "",
        f"Modes: {_esc(', '.join(m.name for m in modes))}",
    ]
    if not installed_all and len(modes) > 1:
        lines.append("[dim]Only this mode's requirements were installed. ./run.sh --menu installs another "
                     "mode's when you pick it, or run python3 setup.py --all now.[/dim]")
    con.panel("\n".join(lines), title="Setup complete", style="green")


def _write_launchers(con, modes, mode, ui_ref):
    try:
        write_atomic(RUN_SCRIPT, render_run_script(modes, mode.name, ui_ref), executable=True)
        write_launch(LAUNCH_FILE, mode.name, ui_ref)
    except (OSError, ValueError) as e:
        con.fail(f"Could not write run.sh: {_esc(e)}")
        return False
    con.ok(f"Wrote run.sh (default mode: {_esc(mode.name)})")
    return True


def stage2(args):
    from copilot_api import console as con
    python = Path(sys.executable)
    title = "copilot-api · choose a mode" if args.menu else "copilot-api setup"
    con.banner(title, _esc(f"{ROOT} · Python {platform.python_version()} · {VENV_DIR.name}"))
    ui_dir = _detect_ui(con)
    mode, ui_dir = _choose_mode(con, args, ui_dir, read_launch())
    if mode is None:
        con.warn("Cancelled. run.sh was not changed.")
        return 1
    ui_ref = ui_reference(ui_dir) if ui_dir else None
    modes = available_modes(ui_dir is not None)
    to_install = modes if args.all else (mode,)
    files = requirement_paths(to_install, ui_ref)
    con.rule("Requirements")
    ok, report = install_requirements(files, VENV_DIR / STAMP_FILENAME,
                                      lambda path: _pip_requirements(con, python, path, args.verbose), args.force)
    _print_report(con, report)
    if not ok:
        con.fail("Some requirements could not be installed, so run.sh was not changed. Fix the error above and run setup again.")
        return 1
    if ui_dir and any(m.desktop for m in to_install):
        _ensure_vendor(con, python, ui_dir, args.yes)
    if not _write_launchers(con, modes, mode, ui_ref):
        return 1
    if args.menu:
        return 0
    if args.yes:
        con.dim("--yes: skipped the GitHub sign-in and test prompts.")
    else:
        copilot_installed = any(p.resolve() == COPILOT_REQUIREMENTS for p in files)
        _offer_extras(con, python, mode, copilot_installed)
    _summary(con, mode, modes, args.all)
    return 0


# ======================================================================
# Entry point
# ======================================================================

def build_parser():
    parser = argparse.ArgumentParser(
        prog="setup.py",
        description="Set up copilot-api (and CombineWebUI when it is cloned inside): create .venv, "
                    "install what the chosen mode needs and write run.sh.",
    )
    parser.add_argument("--mode", help=f"Mode to set up without the menu: {', '.join(m.name for m in MODES)}")
    parser.add_argument("--all", action="store_true", help="Install the requirements of every available mode")
    parser.add_argument("--recreate", action="store_true", help="Delete and rebuild .venv")
    parser.add_argument("--force", action="store_true", help="Reinstall requirements even when unchanged")
    parser.add_argument("-y", "--yes", action="store_true", help="Accept every default; no prompts")
    parser.add_argument("--menu", action="store_true", help="Only choose a new default mode (used by ./run.sh --menu)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Show pip's output while it runs")
    parser.add_argument(STAGE2_FLAG, dest="stage2", action="store_true", help=argparse.SUPPRESS)
    return parser


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    refusal = packaging_refusal(arguments)
    if refusal:
        complain(refusal)
        return 2
    if sys.version_info < MIN_PYTHON:
        complain(f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer is needed; this is {platform.python_version()}. "
                 "Install it from python.org or with Homebrew (brew install python).")
        return 1
    args = build_parser().parse_args(arguments)
    try:
        if args.stage2:
            return stage2(args)
        if _inside_venv():
            if args.recreate:
                complain("--recreate cannot rebuild the venv it is running in. Run it with the system python3.")
                return 2
            return stage2(args)
        return stage1(args, arguments)
    except KeyboardInterrupt:
        print()
        complain("Cancelled.")
        return 130
    except SetupError as e:
        complain(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
