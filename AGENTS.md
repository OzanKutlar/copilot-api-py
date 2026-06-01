# AGENTS.md

## Build, Lint, and Test Commands

- **Install Dependencies:**  
  `pip install -r requirements.txt`
- **Start API Server:**  
  `python main.py start`
- **Authenticate GitHub:**  
  `python main.py auth`
- **Check Usage:**  
  `python main.py check-usage`

## Code Style Guidelines

- **Imports:**  
  Use standard Python `import` and `from ... import ...` statements.
- **Formatting & Linting:**  
  Adhere to standard PEP 8 formatting.
- **Typing:**  
  Use Python type hints where applicable.
- **Naming:**  
  Use `snake_case` for variables/functions, `PascalCase` for classes.
- **Error Handling:**  
  Use explicit error handling, utilizing `HTTPError` from `src.utils` for API errors.

---

This file is tailored for agentic coding agents. No Cursor or Copilot rules detected.
