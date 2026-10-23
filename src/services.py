"""Alias: this module now lives in copilot_api.services."""
import importlib
import sys

sys.modules[__name__] = importlib.import_module("copilot_api.services")
