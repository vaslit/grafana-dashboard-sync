# Project Rules

## Legacy Policy

- Do not preserve legacy compatibility, legacy config fields, or migration fallbacks during normal development unless the task explicitly requires it.
- Prefer simplifying the current implementation over supporting obsolete layouts or deprecated project structure.
- For this project specifically, do not reintroduce filesystem-based `instances/` layout handling for new behavior unless explicitly requested.

## Release Workflow

- For user-visible extension changes that are intended to be built, installed, or shipped, bump the extension version in `package.json` and `package-lock.json`.
- Before starting repo-tracked code changes, create a pre-change snapshot commit when commit workflow is requested for the task.
