# Contributing

Thanks for helping.

## Contributor License Agreement (CLA)

All external contributions require signing the project's **Contributor License Agreement** before a pull request can be merged. The full text is in [`docs/CLA.md`](docs/CLA.md).

- You keep the copyright to your contribution.
- You grant the project maintainers a license to use and relicense it. This includes offering the code under commercial terms in addition to the open-source licenses.

A CLA bot (or an equivalent signed-off process) is not wired yet and should be added for pull requests. A legal review of the CLA text is optional and can happen before the first public release.

## Licenses

- Voice server (this repository's TypeScript, tools, tests and Worker config): GNU AGPL-3.0-only (`LICENSE`).
- Protocol document (`PROTOCOL.md`): Apache-2.0.

By contributing, you agree your contribution is licensed under the license of the directory or file it touches, plus the CLA grant.

## Ground rules

- **No secrets in commits.** No API keys, tokens, account ids, `.dev.vars`, or personal URLs. CI runs a secret scanner (gitleaks), and pull requests with secrets are closed. Rotate anything you leaked.
- **No personal data** in examples or tests. Use fictional names and `example.com`.
- **Privacy invariants must hold.** A pull request that breaks any of the following will not be accepted:
  - no ambient listening in the home version;
  - capture only after the wake word, the button, or a wrist pad (when fitted);
  - the mute switch always wins;
  - no audio or transcripts in logs;
  - the owner can skip memory (`MEMORY_ENABLED=false`); personal memory requires an explicit choice; the default example memory is fictional.
- Run `npm test` and `npm run typecheck`. New behaviour needs tests, using stubs and no network.
- Keep the wire protocol backward compatible, or bump its version and document the change in `PROTOCOL.md`. The pairing contract in `PROTOCOL.md` §2 is frozen: do not change it without coordinating with the firmware.
- Trademarks: do not use third-party characters, logos or brand names as product identity.

## Reporting security issues

Do not open a public issue. Until a dedicated security contact is published, use GitHub's private vulnerability reporting on this repository, or contact the maintainers privately.
