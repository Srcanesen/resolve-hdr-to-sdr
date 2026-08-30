# Release checklist

**Current status: source-alpha; binary releases disabled.** Do not publish a
binary artifact until every item below has an owner and evidence.

## Source change gate

- [x] Full-history `npm run guard:repo` passes.
- [x] `npm audit --audit-level=high` passes.
- [x] `npm run check` passes without Resolve, real media, `doctor`, or bundle execution.
- [x] `git diff --check` passes.
- [x] README, `CHANGELOG.md`, and version metadata describe the same status.

Evidence: `npm run guard:repo` scans current tracked plus full-history patch content — PASS; a prospective snapshot including all non-ignored files also passed. `npm run check` — PASS with 146 Python and 216 Electron tests including process-tree lifecycle coverage (stale 121/181 corrected). `npm audit --audit-level=high` — PASS with 0 vulnerabilities. `npm run doctor` — PASS (repo-local `ffmpeg`/`ffprobe`, no PATH fallback). `npm run bundle:resolve` — EXPECTED FAIL only due to current `arm64`/Homebrew non-portable `tools/ffmpeg`/`tools/ffprobe` (thin `arm64`, ad-hoc, 83 absolute `/opt/homebrew` dylibs); `WorkflowIntegration.node` universal `x86_64+arm64` / `codesign --verify --deep --strict` / Developer ID team `9ZGFBWLSYP` provenance passes. Resolve `-nogui` 21.0.3.7 scratch clip/timeline smoke — PASS with Resolve/fuscript residue 0 (no GUI visual/drop claimed). Media integration (bounded, no-GUI): generic HLG / static PQ / attached-picture / audio-first / VFR PASS; dynamic DV / HDR10+ NOT_RUN tool_unavailable; rotation NOT_RUN; residue 0. `git diff --check` — PASS. Portable candidate is non-release and binary gate stays unchecked.

## Binary release gate (not currently enabled)

- [ ] Portable macOS `ffmpeg`/`ffprobe` inputs are provisioned, license-reviewed,
      architecture-verified, and checksummed.
- [ ] Bundle validation passes on a clean supported macOS host, including
      runtime dependencies and codesigning/notarization decisions.
- [ ] No `Sample/`, `Output/`, `build/`, `.DS_Store`, secret-shaped file, or
      local tool binary is in the source or release payload.
- [ ] A human has completed the required calibrated Rec.709 visual review.
- [ ] Release notes identify known limitations and do not claim Resolve/media
      validation that was not actually run.

Evidence: current bundle remains EXPECTED FAIL only due to `arm64`/Homebrew non-portable tools; portable candidate is non-release and binary gate stays unchecked; no GUI visual/drop or binary readiness claimed.

Until the binary gate is complete, publish source changes only; do not create a
binary release or imply that the opt-in local gates ran in CI.
