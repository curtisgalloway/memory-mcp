<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# memory-mcp — agent instructions

- Read [docs/design.md](docs/design.md) before changing behavior, and update it in the
  same change when behavior changes.
- Language: TypeScript on Cloudflare Workers. The archive job in `archive/` is Python 3,
  standard library only. Pin exact dependency versions.
- Run `npm run check` and `npm test` before committing; for `archive/`, run
  `uv run --with pytest pytest archive`.
- Never commit secrets, `.dev.vars`, `.env`, repo tokens, or anything under `deploy/`
  except `deploy/example.json`. The tracked `wrangler.jsonc` holds local-development
  values only; a real deployment's values belong in `deploy/<name>.json`.
- Never log note bodies or search queries.
- This repository is public. Keep machine names, addresses, home-directory paths and
  account identifiers out of code, documents, commit messages and issues.
- New terms go in [GLOSSARY.md](GLOSSARY.md) before they are used.
