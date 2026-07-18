# Repository guidance

- Read `docs/TECHNICAL.md` before changing architecture or data contracts.
- Never read, copy, commit or upload runtime files under `TutorPlatform/data` unless the project owner explicitly requests a local-only diagnostic.
- Use synthetic data in committed tests. Real WeChat screenshots and OCR transcripts are private fixtures and remain gitignored.
- Keep the web server dependency-light and compatible with Node.js 20+.
- Update `docs/API.md` and `docs/DATA_MODEL.md` whenever their contracts change.
- Run `npm test` and `npm run check:secrets` before committing.
- Do not add credentials to code, examples, documentation, issues or commit messages.

## Parallel work coordination

- Treat `codex/web-first-rebuild` as the integration branch. Feature work uses a dedicated branch and worktree; feature tasks do not merge, deploy, or push unless the project owner explicitly requests it.
- The integration task owns cross-module contracts and final assembly. Domain tasks own implementation and tests only inside their assigned boundary.
- Shared HTTP payloads, persisted fields, parser output, and location output are contracts. A domain task must update `docs/API.md`, `docs/DATA_MODEL.md`, and its handoff note when changing one.
- Do not copy parser rules into UI, routes, or map code. Do not copy map-provider calls into parser, UI, or order persistence code.
- Every feature branch keeps `docs/handoffs/<stream>.md` current with its branch, base commit, owned paths, contract changes, commands run, commit hash, known risks, and integration instructions.
- Requirements may arrive directly in a domain task. If they stay inside that domain, implement them there. If they affect another domain, record the dependency in the handoff instead of editing the other domain silently.
- The integration task reviews handoffs and contract tests before cherry-picking or merging. Conflicts are resolved against documented contracts, not by duplicating logic.
