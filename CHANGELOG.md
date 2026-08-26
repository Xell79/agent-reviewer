# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-08-26

### Fixed

- Kilo auto-scan treats every named export as a plugin factory. Extra
  exports (`activeCountSnapshot`, selector helpers, `PLUGIN_VERSION`)
  were invoked with the plugin input, threw `tiers.map is not a
  function`, and logged `failed to load plugin` even while the real
  factory still registered. Helpers now live in `lib/least-connections.ts`
  (not a named export of the entrypoint). Only `AgentReviewerPlugin` +
  default remain public.

[0.2.1]: https://github.com/Xell79/agent-reviewer/releases/tag/v0.2.1

## [0.2.0] - 2026-08-26

### Added

- Least-connections balancing across concurrent permission reviews.
  `order` is the priority tie-breaker; a free lower-priority tier is
  chosen over a busy higher-priority one. Per-request, a tier is never
  retried. Approve and escalate stay first-definitive; cooldown rules
  unchanged.
- `tier.select` debug log with selected tier and compact active-count
  snapshot.

[0.2.0]: https://github.com/Xell79/agent-reviewer/releases/tag/v0.2.0

## [0.1.0] - 2026-08-26

### Added

- Release versioning: root `VERSION`, `PLUGIN_VERSION` in the plugin
  (logged on import / `plugin loaded`), and GitHub Releases on tags.
- `install.sh` reports repo `VERSION` vs dest `PLUGIN_VERSION`
  (`in sync` / `update available`). Does not copy `VERSION` or this
  changelog into the Kilo config dir.

### Changed

- Public snapshot of the gate (first-definitive chain, fail-closed,
  install checksum skip, operator-owned `agent-reviewer.json`).

[0.1.0]: https://github.com/Xell79/agent-reviewer/releases/tag/v0.1.0
