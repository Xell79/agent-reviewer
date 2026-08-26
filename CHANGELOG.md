# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
