# Repository guidance

- Read `docs/TECHNICAL.md` before changing architecture or data contracts.
- Never read, copy, commit or upload runtime files under either module's `data`, `temp` or `exports` directory unless the project owner explicitly requests a local-only diagnostic.
- Use synthetic data in committed tests. Real WeChat screenshots and OCR transcripts are private fixtures and remain gitignored.
- Keep the web server dependency-light and compatible with Node.js 20+.
- Keep the desktop helper compatible with Windows PowerShell 5.1 and Windows 10/11.
- Update `docs/API.md` and `docs/DATA_MODEL.md` whenever their contracts change.
- Run `npm test` and `npm run check:secrets` before committing.
- Do not add credentials to code, examples, documentation, issues or commit messages.
