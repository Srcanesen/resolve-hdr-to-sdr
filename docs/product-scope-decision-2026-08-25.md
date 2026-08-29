# Product Scope Decision — 2026-08-25

**Type:** Scope clarification, not implementation approval — updated to record user-explicit scope expansion (metadata-driven HDR→SDR, not iPhone-only).
**Status:** Decided. No architecture, codec/CST/algorithm, or stack selection made. No complete format support claimed.

## Decision

- Product is primarily a **metadata-driven drag/drop HDR→SDR Rec.709 converter**, not iPhone-only.
- **DaVinci Resolve Workflow Integration is only the host surface and destination** for dragging the generated file.
- **Source need not enter Resolve.** Resolve is not the processing environment.
- **iPhone samples remain initial test material only**, not a product input restriction.

## In Scope (First Scope)

1. **Source drop into panel** — user drops HDR source into the converter panel.
2. **Inspect** — diagnose/report without modifying source, based on inspectable container/bitstream metadata and base signal (e.g., `colr`/`nclx`, VUI, `mdcv`/`clli`, `dvvC`/`dvcC`, RPU header) — no silent assumption from missing tags.
3. **Convert to separate Rec.709 SDR output without touching source** — creates a new Rec.709 SDR file; source file is never modified.
4. **Drag output to Resolve** — user drags the generated output to Resolve Media Pool / timeline.

## Bounded Supported-Target Intent — Intended Classes, Not Proven Implementation

- **Intent (not claim of complete support):** The product **intends** to **classify** HDR inputs among **HLG**, **PQ / HDR10 (PQ base + static metadata)**, and **Dolby Vision** (via `dvvC`/`dvcC`/RPU and base-signal compatibility ID) by **inspectable metadata / base signal**, then create a **separate Rec.709 SDR output** per class.
- **Bounded:** These three families are **intended classification targets only**. No codec/CST/algorithm/stack is selected, no implementation exists, and **no support for all variants, profiles, levels, or transfers is claimed**. Research-only status is preserved.
- **Distinction preserved:** Intended class ≠ proven implementation. Visual/output acceptance and later architecture remain gated.

## Uncertainty Handling — Fail-Visible, Not Silent

- For **missing / contradictory / unknown metadata** (examples: `colour_primaries`/`transfer_characteristics`/`matrix_coefficients` = `Unspecified` / `2/2/2`, `colr nclx` vs VUI vs RPU mismatch, `full_range` conflict, absent or unrecognized `dvvC`/`dvcC`/RPU, unknown transfer/primaries or Dolby Vision profile), the product **must not silently apply a conversion**.
- Required behavior: **report uncertainty** (what is missing or contradictory), **surface it to the user**, and **require explicit user decision or defer to later supported handling**. Silent fallback or assumed tone-map is prohibited.
- This preserves source immutability and separate-output invariants while keeping unknown cases visible.

## Out of Scope (First Scope)

- **Do not automate Resolve color management / CST / timeline correction** in first scope.
- No automation of project color settings, Input Color Space assignment, RCM/YRGB toggles, or timeline LUTs.

## Reference and Gating

- **Existing ClipDock drag is only read-only reference** for Workflow Integration seams (e.g., `webContents.startDrag` pattern). No ClipDock code, dependency, or modification in this scope. Do not touch ClipDock.
- **Resolve project color settings are not a pre-architecture blocker.**
- **Conversion visual/output acceptance and later host drag smoke remain required** — local visual verification of conversion output and smoke test of dragging the output into the Resolve host remain evidence gates before any architecture/implementation decision.
- **Do not choose codec/CST/algorithm/stack**, write code, or modify canonical/source reports in this decision.

## What Remains Out of Scope / Not Claimed

- **No complete support claimed** for HLG, PQ/HDR10, or Dolby Vision — only bounded intent to classify those families and produce Rec.709 SDR output where metadata is inspectable and unambiguous.
- **No codec / CST / algorithm / stack choice**, no code, no canonical/source research report edits (including no edits to `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` or `docs/research/source-reports/*`).
- **No ClipDock changes** — ClipDock remains read-only reference for drag seams.
- iPhone-origin files stay as **initial test material only**; the product is not limited to iPhone inputs.

## Separate Project Invariant

HdrToSdr remains an **independent, separate project from ClipDock** with its own identity and install location. Source immutability and **separate Rec.709 SDR output** flow are invariant. Unknown-metadata cases remain fail-visible and unsupported until later architecture explicitly handles them.
