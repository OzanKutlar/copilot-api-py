"""Alias: this module now lives in copilot_api.utils."""
import importlib
import sys

sys.modules[__name__] = importlib.import_module("copilot_api.utils")
