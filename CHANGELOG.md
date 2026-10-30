# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [3.0.0] - 2026-10-31

### Added

- Local Windows desktop client built with WinForms and WebView2.
- Unified local music library index with FLAC, MP3, M4A and other formats.
- Queue, repeat, shuffle, sleep timer and a 10-band equalizer.
- Immersive lyrics panel with local LRC, translation and timing support.
- Liked-song sync, local import, duplicate detection and archive reports.
- Versioned extension protocol with health checks, disable, rollback and safe mode.
- Local-only MCP bridge for AI playback and library control.
- Adjustable UI scale, multiple themes and full-bleed player footer.

### Security

- AI control binds to localhost and requires a local token.
- Account cookies and AI tokens are local-only.
- Build dependencies are fetched at build time rather than committed.

[3.0.0]: https://github.com/yrui-ql/local-sound-archive/releases/tag/v3.0.0

