# Secret scan

Scanner: [gitleaks](https://github.com/gitleaks/gitleaks) v8.24.3, run locally on 20 November 2026 (America/Sao_Paulo). Config: `.gitleaks.toml`. CI runs the same scanner on every push and pull request (`.github/workflows/ci.yml`).

TruffleHog was not installed in this pass; gitleaks covered both the working tree and the git history.

## Working tree (`gitleaks detect --no-git`)

First run, without an allowlist, reported one finding:

- Rule: `generic-api-key`
- File: `vitest.config.ts`
- What it matched: the SHA-256 hex of the throwaway test device token `test-token-casa-0123456789`, stored as `TEST_TOKEN_SHA`. This is not a credential. The raw test token never leaves the test bindings.

`.gitleaks.toml` allowlists only that hash in that file, plus local build artifacts (`node_modules`, `dist`, `.wrangler`, `package-lock.json`). After that, a second working-tree scan reported **no leaks**.

## Git history (`gitleaks detect --log-opts="--all"`)

Run after the local commits in this package. **No leaks found.** There is no git remote.

## Notes

- Test fixtures such as `reply-secret-for-tests-only-0001` and `admin-token-for-tests-only-0001` are obviously fake and were not flagged.
- Do not weaken the allowlist to hide a real key. If a genuine secret is committed, rotate it and rewrite history before any publication.
