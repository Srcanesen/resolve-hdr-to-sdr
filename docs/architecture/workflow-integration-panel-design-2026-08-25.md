# Workflow Integration Panel Design — 2026-08-25

**Type:** Architecture decision — architecture only, no code/stack choice.
**Date (UTC):** 2026-08-25
**Status:** Decided. Standalone HdrToSdr; Resolve is host/drop target only. No change to canonical report and source reports.
**Invariant:** Source file is never touched; every output is a separate, non-colliding, privacy-stripped new file.

---

## 0. Summary

- HdrToSdr is a standalone project, separate from ClipDock. Resolve Workflow Integration only hosts the panel and receives the output — the source never has to enter Resolve.
- The user accepted direction B visually, but this is only a 4-second Take-A diagnostic segment. Full-length outputs, both takes, broad HLG/PQ/DV support, or an exact Premiere match have not been proven.
- Flow: drop source → path validation → inspect → closed classification/uncertain → explicit conversion → verified separate output → user drags to Resolve.
- Classification is closed: anything outside `hlgKnownLocal` visibly fails, never converts.
- Candidate B is only valid on known local iPhone DV 8.4 HLG-based samples, as a versioned experimental local calibration profile; no general algorithm claim.

**Sources:** `README.md` (Purpose/Independence); `docs/product-scope-decision-2026-08-25.md` (Decision/Uncertainty); `docs/research/conversion-spike-2026-08-25.md` §14-17 (v4/v5 falsification and contract); `docs/research/visual-tonemap-experiment-2026-08-25.md` §1-10 (4s B diagnostic); `docs/research/adobe-tonemap-match-research-2026-08-25.md` §1-8 (Premiere pipeline and layering suggestion); `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §1,§8,§11 (flow and drag/API limits); `docs/research/source-reports/01-resolve-sdk-capability.md` §1-5 (no auto-fix in SDK); `docs/research/source-reports/09-workflow-integration-drag-drop.md` (inbound/outbound drag evidence matrix); `docs/research/local-sample-inspection-2026-08-25.md` §6 (fingerprints of two samples).

---

## 1. Status and Scope Boundary

- **Standalone HdrToSdr.** Separate project from ClipDock, with a separate identity and install root. ClipDock drag code is read-only reference only. — `README.md` (Status, Canonical Report); `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §1 (Independence).
- **Direction B acceptance is limited.** User preferred diagnostic B; this is an opening segment of ≤4 s on `Sample/1.MOV`, one direction among three candidates A/B/C. Full duration `Sample/1.MOV`, the entirety of `Sample/2.MOV`, broad HLG/PQ/DV, or a frame-exact Premiere tonemap match have not been proven. — `docs/research/visual-tonemap-experiment-2026-08-25.md` §1, §5, §9 (scope: only 1.MOV, ≤4s, human decision); `docs/research/conversion-spike-2026-08-25.md` §14-17 (v4 falsified with +30 code, v5 quantitatively accepted ≠ visual correctness); `docs/research/adobe-tonemap-match-research-2026-08-25.md` §0-1 (Premiere pipeline is color-managed, no public EETF; luma match ≠ appearance match).
- **Research stage preserved.** This document freezes architecture only, not codec/CST/algorithm/stack choices. Broad format support is not claimed. — `docs/product-scope-decision-2026-08-25.md` (Decision, Remaining Out of Scope).

---

## 2. Product Flow

```
drop source → path validation → inspect → closed classification/uncertain → explicit conversion → verified separate output → user drags to Resolve
```

1. **Drop source.** User drops the HDR source onto the panel (or selects via dialog). No processing without path validation in the main process.
2. **Path validation.** Canonicalization, root containment, regular-file check — visible error on failure. — `docs/research/source-reports/09-workflow-integration-drag-drop.md` (A3, `isSafeMediaFile`).
3. **Inspect.** Container/bitstream metadata and base signal are reported without touching the source. Raw paths are not shown in the UI.
4. **Closed classification / uncertain.** Result is visible. Unsupported/uncertain → conversion disabled, explicit message.
5. **Explicit conversion.** User explicitly triggers (`Fix` vs `HDR → SDR` distinction remains in architecture, no automation). Proceeds only if `hlgKnownLocal` and candidate B are eligible.
6. **Verified separate output.** Source hash unchanged, frame count exact, duration within tolerance, tagged Rec.709 SDR, privacy-stripped — output is not presented until the verifier passes. — `docs/research/conversion-spike-2026-08-25.md` §6, §9, §13.
7. **User drags to Resolve.** Output file is dragged by the user. Source is never modified. — `docs/product-scope-decision-2026-08-25.md` (In Scope 1-4).

Transition rule: each step depends on PASS of the previous; silent fallback on uncertainty is forbidden. — `docs/product-scope-decision-2026-08-25.md` (Uncertainty Handling).

---

## 3. Deep Modules and Boundaries

No classes/factories. Each module is defined by responsibility and contract.

### 3.1 Host Panel Adapter

- **Responsibility:** Host panel inside Resolve Workflow Integration, keep `sandbox:true, contextIsolation:true, nodeIntegration:false`. Render the inbound drop area and the outbound drag trigger. Do not hold raw paths; only show opaque IDs.
- **Boundary:** Renderer has no file access; all paths go to main via IPC. No Resolve automation beyond the Workflow Integration lifecycle (`Initialize/GetResolve/CleanUp/RegisterCallback`). — `docs/research/source-reports/01-resolve-sdk-capability.md` §1; `docs/research/source-reports/09-workflow-integration-drag-drop.md` (A1-A2, C5, E).

### 3.2 Workflow Coordinator

- **Responsibility:** Step orchestration (validate → inspect → classify → convert → verify → present). State machine, progress/cancel/retry, produce error messages in one place.
- **Boundary:** Does not call `ffprobe`/`ffmpeg` or filesystem directly; works through inspector, registry/executor, and repository. Defines UI text but never leaks raw paths.

### 3.3 Metadata Inspector / Classifier

- **Responsibility:** Collect container/bitstream metadata and base signal via parsing only (no pixel decode). Produce `InspectionEvidence`, reduce it to `ClassificationResult`.
- **Boundary:** Does not convert, does not write files, never recommends conversion when uncertain. All evidence is visible.
- **Contract:**
  - `InspectionEvidence` — input: canonical source path. Fields: `colr/nclx` (primaries/transfer/matrix/range), VUI (`colour_primaries/transfer/matrix/range/chroma_loc`), `dvvC/dvcC` presence and `dv_bl_signal_compatibility_id`/profile/level, RPU header summary (present/absent, no claim beyond at most 1×1 defaults), `mdcv/clli/prof` absence, `ftyp/major_brand`, size, SHA-256 (for allowlist comparison), duration/frame count (decode frame count), `r_frame_rate/avg_frame_rate/time_base`, `pix_fmt/codec/profile/level`, conflict flags (`2/2/2`, `colr≠VUI`, `range mismatch`). Source: `docs/research/local-sample-inspection-2026-08-25.md` §5-6; `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §5.
  - `ClassificationResult` — input: `InspectionEvidence`. Output: closed enum `{ hlgKnownLocal, pqHdr10Unsupported, dolbyVisionUnsupported, uncertain }` + `reason` (list of missing/conflicting/unknown fields) + `evidenceRef` (summary of displayed evidence). Decision is deterministic, pure function. — `docs/product-scope-decision-2026-08-25.md` (Uncertainty); `docs/research/local-sample-inspection-2026-08-25.md` §9-10.

### 3.4 Profile Registry / Executor

- **Responsibility:** Hold versioned experimental local calibration profiles (including candidate B). Return and execute a profile only for `hlgKnownLocal`, reject non-allowlisted.
- **Boundary:** No general default, no automatic profile selection, no RPU path. Execution follows the separate-output contract and preserves the source hash.
- **Contract:**
  - `ConversionRequest` — input: `ClassificationResult == hlgKnownLocal` + canonical source path + versioned profile ID (e.g., `local-b-v5`) + canonical target root + desired output name draft. Target must not exist, must be canonical, non-colliding.
  - `ConversionResult` — output: `outputId` (opaque), canonical output path (known only to main/repo), `verified` flag, `timing` (source/output duration and decode frame count), `tags` (Rec.709), `privacyScan` (PASS/FAIL). Concrete error code on failure. — `docs/research/conversion-spike-2026-08-25.md` §6, §9.

### 3.5 Output Store

- **Responsibility:** Create a separate destination under the closed output root, reject collisions/overwrites, clean up partial output, present verified output with an opaque `outputId`. Never leak raw paths to the UI.
- **Boundary:** Does not move/modify source, does not write outside the root, does not give raw paths to renderer. Re-validates canonical path + root containment + regular file on every access.
- **Contract:** `outputId` is opaque; the store keeps `outputId → canonical path` mapping in main. On collision: `output already exists; refusing to replace`. — `docs/research/conversion-spike-2026-08-25.md` §2, §6; `docs/research/source-reports/09-workflow-integration-drag-drop.md` (A3, C5).

### 3.6 Resolve Drag Adapter

- **Responsibility:** Present the verified output as an OS drag (`webContents.startDrag` `file/files + icon`). Target is Resolve Media Pool / timeline only; no project/timeline/color management automation.
- **Boundary:** No project automation via `AddItemListToMediaPool` / `AppendToTimeline` in the initial scope (only user drag). `icon` must not be empty on macOS. — `docs/research/source-reports/09-workflow-integration-drag-drop.md` (C1-C4, D); `docs/research/source-reports/01-resolve-sdk-capability.md` §2-3 (no CST/OFX automation).
- **Contract:** Input: list of `outputId` (single/multiple). Main resolves `outputId → path`, re-validates each with `isSafeMediaFile` + canonical + regular file, then calls `startDrag`. Renderer sees only `outputId`.

### Module Interaction

```
Host Panel Adapter → Workflow Coordinator → Metadata Inspector/Classifier
                                         → Profile Registry/Executor → Output Store → Resolve Drag Adapter
```
Coordinator is the sole orchestrator; inspector and executor never call each other; the store owns all file writing/presentation.

---

## 4. Closed Classification

Only four outcomes exist. Conversion is disabled on unsupported/uncertain.

| Result | Condition | Evidence requirement | Behavior |
|---|---|---|---|
| `hlgKnownLocal` | Exact fingerprint on allowlist + known HLG base evidence (`9/18/9` `bt2020nc`/`arib-std-b67`/`bt2020` `tv`, `hvc1` + `dvvC` profile 8 compat 4 HLG, RPU present) — only known local iPhone DV 8.4 HLG-based samples. B eligibility only here. | Within `InspectionEvidence`, SHA, size, `colr`/`VUI`/`dvvC`/`RPU` header, absence of `mdcv`/`clli` must match. | Allow conversion with B profile. |
| `pqHdr10Unsupported` | PQ base (`transfer 16 smpte2084`, `mdcv/clli` may be present) or `compat1` | VUI/colr PQ, presence of `mdcv`/`clli` | Visible failure, no conversion. |
| `dolbyVisionUnsupported` | Any DV outside allowlist (`dvvC`/`dvcC`/RPU profile/base/RPU details outside allowlist) | `dvvC`/`dvcC` profile, `compat_id`, RPU header conflict | Visible failure, no conversion. Show profile/base/RPU details in evidence. |
| `uncertain` | Missing/conflicting/unknown metadata (`2/2/2` Unspecified, `colr≠VUI`, `range` conflict, unrecognized transfer/primaries, no DV config) | List of missing/conflicting fields in `reason` | Visible failure, no conversion. No silent fallback. |

Rules: closed set; all unsupported/uncertain including `uncertain` visibly fail and never convert. Silent assumption is forbidden. — `docs/product-scope-decision-2026-08-25.md` (Uncertainty); `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §5-6; `docs/research/local-sample-inspection-2026-08-25.md` §9-10.

**Allowlist:** `Sample/1.MOV` `46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593` 18,423,719 B and `Sample/2.MOV` `2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a` 20,313,976 B — only these two fingerprints are known for `hlgKnownLocal`. Other paths, if determined later, are added with the same rigor; no broadening. — `docs/research/local-sample-inspection-2026-08-25.md` §2, §6; `docs/research/conversion-spike-2026-08-25.md` §3.

---

## 5. Candidate B — Versioned Experimental Local Calibration Profile

- **Character:** Versioned experimental local calibration profile (`local-b-v*` etc.). Eligible only on `hlgKnownLocal` (known local iPhone DV 8.4 HLG-based) samples. No general default/algorithm claim. — `docs/research/visual-tonemap-experiment-2026-08-25.md` §1-4; `docs/research/adobe-tonemap-match-research-2026-08-25.md` §2-5 (no general match recipe, only layering suggestion).
- **Eligibility:** If classification is not `hlgKnownLocal`, no profile is returned and execution is rejected.
- **Output contract (same as spike, preserved):** — `docs/research/conversion-spike-2026-08-25.md` §2, §6, §9, §13, §17
  - separate, non-existent target; same-path/symlink-parent collision and overwrite of existing output rejected (`-n` protection);
  - location/camera/creation metadata stripped (broad scan: `com.apple.quicktime.*`, `ISO6709`, location, creation_time/date);
  - Rec.709 SDR ProRes LT 10-bit (`yuv422p10le`, `tv`, `bt709/bt709/bt709`);
  - source hash unchanged (pre/post SHA identical, no unknown-basename bypass);
  - decoded frame count exactly equal, duration within tolerance (e.g., 0.050 s).
- **Filter detail:** Exact proven `ffmpeg` filter strings are not stated in this document. The executor validates filter capability at runtime, fails visibly if missing, and does not use a guessed graph. — `docs/research/conversion-spike-2026-08-25.md` §1b, §12; `docs/research/adobe-tonemap-match-research-2026-08-25.md` §2.1 (§14-17 libplacebo capability validation is preserved, but exact strings are not asserted).

---

## 6. Resolve — Host/Target Only, Single Integration Seam

- **Role:** Resolve is host surface and drop target only. Source never has to enter Resolve. The first scope has a single integration seam: user dragging the output file. — `README.md` (Purpose); `docs/product-scope-decision-2026-08-25.md` (Decision 2-4).
- **No automation:** No CST/project/timeline/color management automation. `SetClipProperty(Input Color Space)`, `SetSetting(colorScienceMode)` and CST OFX injection are undocumented and version-fragile; not attempted. — `docs/research/source-reports/01-resolve-sdk-capability.md` §2-5; `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §11.
- **Entry and drag validation:** Canonical path, root containment (`relative+isAbsolute`) and regular-file re-validation are mandatory on every intake and every drag. Symlink/dir/missing are rejected. Raw paths are not given to renderer; opaque `outputId` is used. — `docs/research/source-reports/09-workflow-integration-drag-drop.md` (A3, A4, C1, C5).
- **Evidence required for live host drag smoke test:**
  - On macOS 15 × Resolve Studio 21.0.3 (hosted Electron version): drag to Media Pool accepted, drag to timeline (Edit page, open timeline) accepted, drag did not fail when `icon` was non-empty. — `docs/research/source-reports/09-workflow-integration-drag-drop.md` (E1-E4).
  - Evidence log: Resolve version/build, macOS version, target (Media Pool vs timeline), single/multiple files, outcome (added to bin / added to timeline / visual confirmation), `icon` presence.
  - Version limit: Workflow Integrations menu does not exist in Free; plugins are not supported on Linux. — `docs/research/source-reports/01-resolve-sdk-capability.md` §1; `docs/research/source-reports/09-workflow-integration-drag-drop.md` (E5).

---

## 7. Error UX — Short, Concrete, No Verbose UI

Short message + state per condition. Progress/cancel/retry/open/show are present, no ornate UI.

| State | Message (example) | Action |
|---|---|---|
| invalid path | `File could not be read — path invalid or not a file.` | Choose again |
| `pqHdr10Unsupported` | `PQ/HDR10 is not supported in this version — not a local HLG sample.` | Close, conversion disabled |
| `dolbyVisionUnsupported` | `Dolby Vision profile is not supported in this version (outside allowlist — see profile/base/RPU details).` | Close |
| `uncertain` (unknown/conflicting metadata) | `Metadata is uncertain — missing/conflicting fields: {list} — no silent conversion.` | Close |
| collision | `Destination already exists — refusing to overwrite.` | Choose different name/root, retry |
| cancelled | `Conversion cancelled — partial output cleaned up.` | Retry |
| conversion error | `Conversion failed — {code}: filter capability missing / execution error.` | Retry, show log |
| verified output | `Verified — Rec.709 SDR ProRes LT, timing/frames matched, privacy scan clean.` | `Open` / `Show in Folder` / `Drag to Resolve` |

All errors are visible; no silent fallback. — `docs/product-scope-decision-2026-08-25.md` (Uncertainty); `docs/research/conversion-spike-2026-08-25.md` §6, §9 (negative tests).

Controls: progress bar, cancel, retry, open, show in folder. No color management/CST/timeline automation buttons.

---

## 8. Security / Privacy

- **Untrusted paths.** Every path from the renderer is re-validated in main (`lstat` symlink reject, `realpathSync` canonical, `statSync` regular file, `relative+isAbsolute` containment). — `docs/research/source-reports/09-workflow-integration-drag-drop.md` (A3).
- **Canonicalization / malformed-file rejection.** Same canonical source/destination, symlink-parent collision, existing destination, missing/unknown source, directory/symlink are rejected. — `docs/research/conversion-spike-2026-08-25.md` §6, §9.
- **No raw path in presentation.** Renderer and presentation layer see only `outputId` + file name; raw canonical paths are authority of main/store. — `docs/research/source-reports/09-workflow-integration-drag-drop.md` (C5).
- **Closed output root.** All outputs are under a closed, allowed root; no write outside the root, no `..` escape outside the root.
- **Staged partial-output cleanup.** Partial file is deleted on cancel/error; half file is not presented. Retry starts from clean state. — `docs/research/conversion-spike-2026-08-25.md` §2.
- **Shell-safe invocation.** `ffmpeg/ffprobe` are called with an argument array, no shell concatenation; paths are passed as arguments.
- **Location/camera/creation metadata stripping.** Verified with `-map_metadata -1` and broad scan (`com.apple.quicktime.*`, `ISO6709`, location, creation_time/date). Ancillary data except expected `Ambient viewing environment` etc. must not contain forbidden terms. — `docs/research/conversion-spike-2026-08-25.md` §6, §9; `docs/research/visual-tonemap-experiment-2026-08-25.md` §6; `docs/research/local-sample-inspection-2026-08-25.md` §6.1 (location redacted).
- **No telemetry.** Media/GPS telemetry is not sent or exported. — `docs/research/local-sample-inspection-2026-08-25.md` §12 (paths redacted).

---

## 9. Verification

### 9.1 Pure classifier tests

- **Scope:** `ClassificationResult` pure-function tests — evidence → result mapping for each enum, `reason` list, conflict flags. `hlgKnownLocal` passes only on allowlist SHA + `9/18/9` + `dvvC` 8.4 HLG evidence; all other combinations are `unsupported/uncertain` → visible failure.
- **Pass signal:** Expected enum + `reason` are verified for all closed-class branches; no silent conversion.

### 9.2 Executor integration (reuse spike verifier)

- **Scope:** Same checks as `scripts/verify-spike.sh`: source SHA exact match, decoded frame count exactly equal, duration delta within tolerance (0.050 s), Rec.709 tags (`bt709/bt709/bt709` `tv` `yuv422p10le` ProRes LT), privacy scan (ffprobe JSON + `strings` raw bytes). — `docs/research/conversion-spike-2026-08-25.md` §6, §9, §13, §17.
- **Pass signal:** PASS for `Sample/1.MOV` 491 frames / `Sample/2.MOV` 557 frames; negatives (same-path, symlink-parent, unknown source, missing output, tampered metadata, short duration, overwrite) visibly FAIL. — same §9, §13.

### 9.3 Workflow fake-adapter tests

- **Scope:** Fake for host panel adapter and Resolve drag adapter: fake IPC, fake `startDrag`, fake filesystem with canonical/containment/regular-file, opaque `outputId`, collision and cancel/cleanup flows.
- **Pass signal:** No raw path leak, symlink rejected, `refusing to replace` on collision, partial file cleaned on cancel, `startDrag` called only for verified `outputId`, `icon` not empty.

### 9.4 Manual Resolve smoke test

- **Scope:** Live host (§6) Media Pool and timeline drag acceptance, single/multiple files, `icon` requirement. — `docs/research/source-reports/09-workflow-integration-drag-drop.md` (E1-E8).
- **Pass signal:** Clip is visible in Resolve bin/timeline, file name and duration correct, user visually confirms. Free/Linux limits are documented.

---

## 10. Build Sequence — 4–6 Minimal Vertical Increments, Stop Before Live Drag Smoke

Each increment is small, vertical, verifiable. Stop before the live drag smoke test.

1. **Increment 1 — Path validation + closed skeleton.** Canonicalization, root containment, regular file, opaque `outputId` skeleton. PASS/FAIL with fake tests. No output.
2. **Increment 2 — Inspector/classifier (pure).** `InspectionEvidence` collection (ffprobe parsing) + closed classification. Pure tests for allowlist SHAs and `uncertain` branches. No conversion.
3. **Increment 3 — Store + profile registry skeleton (no execution).** Closed output root, collision rejection, accept `ConversionRequest` only for `hlgKnownLocal`, otherwise visible rejection. Execution not yet wired.
4. **Increment 4 — Executor + verifier integration.** Wire candidate B profile, write to separate destination, reuse `verify-spike` for source hash/frames/duration/Rec.709/privacy checks. Negatives (collision, tampered, duration) must FAIL. — `docs/research/conversion-spike-2026-08-25.md` §6, §9.
5. **Increment 5 — Workflow coordinator + error UX.** Progress/cancel/retry/open/show, concrete messages for all error cases (§7). Partial-output cleanup. Fake-adapter workflow tests.
6. **Increment 6 — Host panel adapter wiring (fake Resolve).** Panel drop area → IPC → validation → inspection → classification → conversion → verification → drag-ready. All paths with fake `startDrag`. No real Resolve call.

**Stop — before live drag smoke.** Stop after increment 6 before moving to the live Resolve smoke test. The live test (§6, §9.4) is a separate, manual evidence step; it does not change architecture. — `docs/research/source-reports/09-workflow-integration-drag-drop.md` (E1-E8).

---

## 11. Open Decisions / Boundaries Not Asserted

- **Runtime / packaging:** Electron/Node version, packaging, signing, auto-update not decided. — `docs/research/source-reports/01-resolve-sdk-capability.md` §1; `docs/research/source-reports/09-workflow-integration-drag-drop.md` (E).
- **Real Workflow Integration APIs / lifecycle:** `manifest.xml` identity, `WorkflowIntegration.node` version, `RegisterCallback` scope, Linux unsupported — to be verified on the live host; API keys are not invented in this document.
- **Module formats:** ESM/CJS, build target, file layout not decided.
- **Persistence:** Card store, settings, history persistence not defined.
- **Broad HLG/PQ/DV:** All HLG variants outside `hlgKnownLocal`, PQ/HDR10, Dolby Vision profiles not supported; no claim. — `docs/product-scope-decision-2026-08-25.md` (Remaining Out of Scope); `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §2-3.
- **RPU path:** Applying/preserving/regenerating RPU trims is not in this version; flags like `apply_dolbyvision` are not asserted. — `docs/research/adobe-tonemap-match-research-2026-08-25.md` §2.2-3.2; `docs/research/local-sample-inspection-2026-08-25.md` §10 (dovi_tool gap).
- **Hardware/display:** Calibrated SDR 100 nits, `1-1-1` vs `1-2-1` gamma trap, Viewer HDR, DeckLink, XDR vs SDR differences are not solved in this architecture; judged on the user's display. — `docs/research/adobe-tonemap-match-research-2026-08-25.md` §6-8.

---

## 12. ADR — Compact Decision

**Decision:** Standalone HdrToSdr Workflow Integration panel; closed classification (anything outside `hlgKnownLocal` visibly fails); candidate B as versioned experimental local calibration profile only on known local iPhone DV 8.4 HLG-based samples; output contract same as spike; Resolve is host/drop target only, no automation; raw paths never presented.

**Why:** Local evidence only firmly verifies two iPhone DV 8.4 HLG samples (`9/18/9` + `dvvC` 8.4 + RPU, no `mdcv`/`clli`, SHA pinned) — `docs/research/local-sample-inspection-2026-08-25.md` §6; broad support evidence is absent. Spike v4 was falsified with a systematic luma lift, v5 quantitatively accepted but visual correctness not claimed — `docs/research/conversion-spike-2026-08-25.md` §14-17. Premiere pipeline does not publish a public EETF, luma ≠ appearance — `docs/research/adobe-tonemap-match-research-2026-08-25.md` §1, §6. Resolve SDK documents no automatic HDR fix/CST/project automation — `docs/research/source-reports/01-resolve-sdk-capability.md` §1-5. Drag seam is empirical via OS DnD, API automation is separate — `docs/research/source-reports/09-workflow-integration-drag-drop.md`. Unknown metadata must not be silently converted — `docs/product-scope-decision-2026-08-25.md`.

**Consequence:** Proceed with a narrow allowlist + fail-visible policy + verified separate output + user drag; broad formats, RPU, hardware/display claims left open.

---

## 13. Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| Single universal CST / Input Color Space (`Rec.2020/Rec.2100 HLG Scene` etc.) to fix all HLG/PQ/DV | Five branches diverge (capture mode, metadata conflict, transfer history, RCM vs YRGB, levels/viewer) — single CST silently breaks other branches. — `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §2, §6. |
| Silent fallback on missing/conflicting metadata (assume default HLG) | Product decision forbids silent conversion; uncertainty must be visible. — `docs/product-scope-decision-2026-08-25.md` (Uncertainty). |
| Claim of general HLG→SDR algorithm / default profile | Candidate B is only local calibration; no broad claim with evidence. — `docs/research/visual-tonemap-experiment-2026-08-25.md` §9; `docs/research/adobe-tonemap-match-research-2026-08-25.md` §0-2. |
| Apply RPU trims directly (`dovi_tool` + `apply_dolbyvision`) | iPhone 8.4 RPU may be minimal, Premiere discards RPU on the HLG path; extra dependency and double-conversion risk, no proven benefit. — `docs/research/adobe-tonemap-match-research-2026-08-25.md` §2.2-3.2; `docs/research/local-sample-inspection-2026-08-25.md` §10. |
| Resolve project/timeline/CST/color management automation | Undocumented/version-fragile in SDK, `SetClipProperty`/`SetSetting` keys not guaranteed; Free/Linux limits. — `docs/research/source-reports/01-resolve-sdk-capability.md` §2-5; `docs/research/source-reports/09-workflow-integration-drag-drop.md` (D, E). |
| Permanent `zscale+tonemap hable` fallback | Legacy quality, no perceptual gamut; behind libplacebo. — `docs/research/conversion-spike-2026-08-25.md` §1-2; `docs/research/visual-tonemap-experiment-2026-08-25.md` §9 (ceiling). |
| Proving verification via luma average/PSNR | Quantitative luma does not prove visual correctness; human judgment on a calibrated display is required. — `docs/research/conversion-spike-2026-08-25.md` §14-17; `docs/research/adobe-tonemap-match-research-2026-08-25.md` §6. |

---

## 14. Citation Index

- `README.md` — purpose, independence, flow (drop source → separate output → drag to Resolve), ClipDock as read-only reference.
- `docs/product-scope-decision-2026-08-25.md` — metadata-driven converter decision, fail-visible on uncertainty, automation out of scope.
- `docs/research/conversion-spike-2026-08-25.md` §1-17 — host/filter capability, conversion policy, fingerprints, v2/v3/v4/v5 evidence, §14 crossed luma comparison (§14), §17 v5 fix, verifier and negative tests.
- `docs/research/visual-tonemap-experiment-2026-08-25.md` §1-10 — 4 s B diagnostic, three candidates, contact sheet, verifier, quality ceiling.
- `docs/research/adobe-tonemap-match-research-2026-08-25.md` §0-9 — Premiere color-managed pipeline, Hue Preservation operators, libplacebo/RPU layers, gamut traps, sources.
- `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §1-13 — flow, why CST is not universal, transfer matrix, four-layer metadata model, version/matrix, drag/API limits, evidence checklist.
- `docs/research/source-reports/01-resolve-sdk-capability.md` §1-7 — no automatic HDR fix on Workflow Integration/API surface, LUT/CST gaps.
- `docs/research/source-reports/09-workflow-integration-drag-drop.md` — inbound/outbound drag capability matrix, sandbox, `isSafeMediaFile`, `startDrag` icon, experiments E1-E8.
- `docs/research/local-sample-inspection-2026-08-25.md` §1-13 — four-layer forensics of two MOVs, VFR/CFR, `dvvC` 8.4 HLG, absence of `mdcv`/`clli`, SHA.
- `docs/research/clipdock-outbound-drag-readback-2026-08-25.md` — ClipDock outbound drag read-only evidence (if present).

---

*End — architecture only; no code/setup/canonical-report change.*
