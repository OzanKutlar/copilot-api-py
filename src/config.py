"""Alias: this module now lives in copilot_api.config."""
import importlib
import sys

sys.modules[__name__] = importlib.import_module("copilot_api.config")
