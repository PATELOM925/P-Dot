# Claude instructions

Read and follow `AGENTS.md`, `docs/PRD.md`, and `docs/ARCHITECTURE.md` before making changes.

The repository currently contains planning documents and a directory skeleton only. Do not generate application code or install packages until the user requests implementation.

- Use `AGENTS.md` for shared engineering and safety rules; avoid duplicating or contradicting it here.
- Keep the personal-assistant MVP within the PRD. Record unresolved decisions instead of treating assumptions as approved requirements.
- Inspect existing files before editing, preserve unrelated changes, and keep work limited to the current request.
- Keep provider secrets server-side and treat web content as untrusted.
- Report checks actually performed and distinguish completed work from proposed work.
