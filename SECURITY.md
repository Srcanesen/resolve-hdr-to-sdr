# Security Policy

## Reporting a Vulnerability

Do not open a public issue for security-sensitive reports. Use GitHub’s private security advisory flow for this repository (Security → Report a vulnerability) if available, or open a minimal public issue without technical details and ask for a private channel.

## Scope

This project runs local, offline conversion with `ffprobe`/`ffmpeg` via absolute paths and spawns without a shell. No network service beyond the local `127.0.0.1` prototype server. Please include steps to reproduce, impact, and any relevant logs without including absolute local paths or secrets.

## Supported Versions

Only the current `main` branch is maintained. Dependency updates are minimal and security-driven (e.g., Electron patched updates).
