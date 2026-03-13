# Project Rules

## Legacy Policy

- Do not preserve legacy compatibility, legacy config fields, or migration fallbacks during normal development unless the task explicitly requires it.
- Prefer simplifying the current implementation over supporting obsolete layouts or deprecated project structure.
- For this project specifically, do not reintroduce filesystem-based `instances/` layout handling for new behavior unless explicitly requested.
