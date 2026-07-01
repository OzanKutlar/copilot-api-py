import os
import json
from pathlib import Path
import uuid
from rich.console import Console

console = Console()

class Logger:
    def __init__(self):
        self.level = 3

    def info(self, *args):
        if self.level >= 3:
            console.print("[bold cyan]INFO[/bold cyan]:", *args)
            
    def success(self, *args):
        if self.level >= 3:
            console.print("[bold green]SUCCESS[/bold green]:", *args)
            
    def warn(self, *args):
        if self.level >= 2:
            console.print("[bold yellow]WARN[/bold yellow]:", *args)
            
    def error(self, *args):
        if self.level >= 1:
            console.print("[bold red]ERROR[/bold red]:", *args)
            
    def debug(self, *args):
        if self.level >= 4:
            console.print("[bold magenta]DEBUG[/bold magenta]:", *args)

logger = Logger()

APP_DIR = Path(os.path.expanduser("~")) / ".local" / "share" / "copilot-api"
GITHUB_TOKEN_PATH = APP_DIR / "github_token"
SETTINGS_PATH = Path("settings.json")
MODEL_QUIRKS_PATH = APP_DIR / "model_quirks.json"
CHATS_PATH = APP_DIR / "chats.json"

def load_model_quirks():
    if not MODEL_QUIRKS_PATH.exists():
        return {"requires_max_completion_tokens": []}
    try:
        return json.loads(MODEL_QUIRKS_PATH.read_text())
    except Exception as e:
        logger.error(f"Failed to load {MODEL_QUIRKS_PATH}: {e}")
        return {"requires_max_completion_tokens": []}

def save_model_quirks(quirks):
    try:
        MODEL_QUIRKS_PATH.write_text(json.dumps(quirks, indent=2))
    except Exception as e:
        logger.error(f"Failed to save {MODEL_QUIRKS_PATH}: {e}")

def save_settings(config):
    try:
        SETTINGS_PATH.write_text(json.dumps(config, indent=2))
    except Exception as e:
        logger.error(f"Failed to save settings: {e}")

def load_settings():
    if Path("model_pricing.json").exists() and not SETTINGS_PATH.exists():
        try:
            Path("model_pricing.json").rename(SETTINGS_PATH)
            logger.info("Migrated model_pricing.json to settings.json")
        except Exception as e:
            logger.error(f"Failed to migrate settings: {e}")

    default_providers = [
        {"id": "openai", "name": "OpenAI", "keywords": ["gpt", "o1", "o3", "codex", "babbage", "dall-e", "davinci", "text-embedding"], "logo": "https://upload.wikimedia.org/wikipedia/commons/4/4d/OpenAI_Logo.svg"},
        {"id": "anthropic", "name": "Anthropic", "keywords": ["claude", "sonnet", "opus", "haiku"], "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Anthropic_logo.svg/2560px-Anthropic_logo.svg.png"},
        {"id": "google", "name": "Google", "keywords": ["gemini"], "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/1024px-Google_%22G%22_logo.svg.png"}
    ]
    default_payload = {
        "max_tokens": 16384,
        "temperature": None,
        "top_p": None,
        "presence_penalty": None,
        "frequency_penalty": None
    }
    default_thinking = {
        "enabled_keywords": ["opus", "sonnet"],
        "budget_tokens": 4096,
        "max_completion_tokens": 16384,
        "unlimited": False
    }
    
    if not SETTINGS_PATH.exists():
        default_config = {
            "providers": default_providers,
            "multipliers": [
                {"keywords": ["opus"], "multiplier": 3.0, "label": "3x"},
                {"keywords": ["sonnet", "pro"], "multiplier": 1.0, "label": "1x"},
                {"keywords": ["flash", "mini", "haiku"], "multiplier": 0.33, "label": "0.33x"}
            ],
            "default": {"multiplier": 1.0, "label": "1x"},
            "payload_defaults": default_payload,
            "thinking_defaults": default_thinking,
            "custom_endpoints": []
        }
        try:
            SETTINGS_PATH.write_text(json.dumps(default_config, indent=2))
        except Exception as e:
            logger.error(f"Failed to write default settings config: {e}")
        return default_config
    try:
        config = json.loads(SETTINGS_PATH.read_text())
        modified = False
        if "providers" not in config:
            config["providers"] = default_providers
            modified = True
        if "payload_defaults" not in config:
            config["payload_defaults"] = default_payload
            modified = True
        if "thinking_defaults" not in config:
            config["thinking_defaults"] = default_thinking
            modified = True
        if "custom_endpoints" not in config:
            config["custom_endpoints"] = []
            modified = True
        if modified:
            SETTINGS_PATH.write_text(json.dumps(config, indent=2))
        return config
    except Exception as e:
        logger.error(f"Failed to load {SETTINGS_PATH}: {e}")
        return {"providers": default_providers, "multipliers": [], "default": {"multiplier": 1.0, "label": "1x"}, "payload_defaults": default_payload, "custom_endpoints": []}

def get_model_multiplier(model_id: str, config: dict):
    model_id_lower = model_id.lower()
    for rule in config.get("multipliers", []):
        for keyword in rule.get("keywords", []):
            if keyword in model_id_lower:
                return rule.get("multiplier", 1.0), rule.get("label", f"{rule.get('multiplier', 1.0)}x")
    default = config.get("default", {})
    return default.get("multiplier", 1.0), default.get("label", "1x")

class State:
    def __init__(self):
        self.github_token = None
        self.copilot_token = None
        self.account_type = "individual"
        self.models = None
        self.vscode_version = "1.104.3"
        self.manual_approve = False
        self.rate_limit_wait = False
        self.show_token = False
        self.rate_limit_seconds = None
        self.last_request_timestamp = None
        self.use_proxy_env = False
        self.refresh_task = None
        self.quirks = load_model_quirks()

state = State()

def ensure_paths():
    APP_DIR.mkdir(parents=True, exist_ok=True)
    if not GITHUB_TOKEN_PATH.exists():
        GITHUB_TOKEN_PATH.touch(mode=0o600)

API_VERSION = "2025-04-01"
COPILOT_VERSION = "0.26.7"
EDITOR_PLUGIN_VERSION = f"copilot-chat/{COPILOT_VERSION}"
USER_AGENT = f"GitHubCopilotChat/{COPILOT_VERSION}"

GITHUB_API_BASE_URL = "https://api.github.com"
GITHUB_BASE_URL = "https://github.com"
GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
GITHUB_APP_SCOPES = "read:user"

def standard_headers():
    return {
        "content-type": "application/json",
        "accept": "application/json"
    }

def copilot_base_url():
    if state.account_type == "individual":
        return "https://api.githubcopilot.com"
    return f"https://api.{state.account_type}.githubcopilot.com"

def copilot_headers(vision: bool = False, intent: str = "conversation-panel"):
    headers = {
        "Authorization": f"Bearer {state.copilot_token}",
        "content-type": "application/json",
        "copilot-integration-id": "vscode-chat",
        "editor-version": f"vscode/{state.vscode_version}",
        "editor-plugin-version": EDITOR_PLUGIN_VERSION,
        "user-agent": USER_AGENT,
        "openai-intent": intent,
        "x-github-api-version": API_VERSION,
        "x-request-id": str(uuid.uuid4()),
        "x-vscode-user-agent-library-version": "electron-fetch",
    }
    if vision:
        headers["copilot-vision-request"] = "true"
    return headers

def github_headers():
    h = standard_headers()
    h.update({
        "authorization": f"token {state.github_token}",
        "editor-version": f"vscode/{state.vscode_version}",
        "editor-plugin-version": EDITOR_PLUGIN_VERSION,
        "user-agent": USER_AGENT,
        "x-github-api-version": API_VERSION,
        "x-vscode-user-agent-library-version": "electron-fetch"
    })
    return h
