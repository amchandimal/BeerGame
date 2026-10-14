# Contributing

Use Node.js 24 and pnpm 11.25.0. Run `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm test` and `pnpm run test:mcp` (install Playwright Chromium first). See AGENTS.md for game invariants and design decisions. Keep changes focused and include reproduction steps and meaningful regression coverage. Never include credentials, student data or private session exports in issues or commits.

Contributions are accepted under the MIT License, the same license as this project. Only submit work you have the right to license. No copyright assignment is implied by contributing.

Check `pnpm run release:check` before proposing a release; legal/deployment TODOs are intentional blockers for public publication, not failing unit tests.
