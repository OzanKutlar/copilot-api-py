"""Compatibility package. The code now lives in copilot_api/.

src/anthropic_translator.py stays here unchanged, and the config, utils and
services modules are aliases for their copilot_api counterparts, so anything
that still imports from src keeps working in server mode.
"""
