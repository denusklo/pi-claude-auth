# Changelog

## Unreleased

### Fixed

- `auth.json` sync now takes the same `proper-lockfile` lock pi itself uses
  for that file, so a background sync can no longer interleave with a pi
  credential write (for example a `/login` completed by another pi process)
  and silently drop a provider credential pi just stored.
- A malformed `auth.json` is now preserved in an `auth.json.corrupt-*`
  sibling backup and left untouched instead of being reset to `{}` +
  `anthropic`, which wiped every other provider's credentials.
- `auth.json` writes are now atomic (temp file + rename), so a crash can no
  longer leave a partially-written file behind.

# [0.1.0](https://github.com/pankajudhas81/pi-claude-auth/compare/v0.0.1...v0.1.0) (2026-05-30)

## 0.0.1

### Features

- Initial release. Pi coding agent extension that authenticates against
  Anthropic using your existing Claude Code credentials — no separate login
  or API key needed.
- Reads OAuth credentials from the macOS Keychain (all
  `Claude Code-credentials*` entries) with automatic multi-account detection,
  falling back to `~/.claude/.credentials.json` on all platforms.
- Seeds and syncs credentials into pi's `~/.pi/agent/auth.json` so pi uses
  them with zero separate login. Background re-sync runs every 5 minutes.
- Refreshes expiring tokens directly via Anthropic's OAuth endpoint (zero LLM
  tokens consumed), falling back to the Claude CLI, and writes rotated tokens
  back to the Keychain or credentials file.
- Account switcher via `/login anthropic` when multiple Claude Code accounts
  are detected; selection persists across sessions.
- Diagnostic logging via `PI_CLAUDE_AUTH_DEBUG` with automatic secret
  redaction.
