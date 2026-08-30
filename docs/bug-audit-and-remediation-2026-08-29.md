# HdrToSdr — Bug Audit ve Remediation Raporu 2026-08-29

## Yaşam döngüsü diyagramı (metin)

```text
Inspection → canonical source → eligible result → opaque source token
    → user confirmation → reserved job → revalidation → conversion
    → verifier → fingerprint-bound commit → verified opaque output ID → drag

Her geçişte fail-closed: cancelled/error/success terminaldir; commit ve drag
yalnızca doğrulama ve güncel dosya kimliği geçerliyse yapılır.
```

## Sahiplik ve state diyagramı (metin)

```text
Renderer/window
  └─ currentJobId, owner webContents.id, opaque sourceId/outputId
Main / ConversionService
  ├─ sourceTokens + windowTokens: canonical source, SHA/size, profile, owner
  ├─ jobs + activeJobByWindow: state, abort controller, staging/final path,
  │  processes, timers, sequence and terminalized flag
  ├─ HeavyOperationCoordinator: one inspection/conversion reservation,
  │  tracked children, abort and release ownership
  ├─ outputs: verified canonical output/root, fingerprint, owner, TTL
  └─ thumbnailInFlight + bounded thumbnail cache: owner and fingerprint
Filesystem/process boundary
  ├─ source: read-only, canonicalized and revalidated
  ├─ staging: private bounded-name file, cleaned on terminal paths
  ├─ final: hard-link commit, fingerprint checked before publication
  └─ ffprobe/ffmpeg/verifier/thumbnail children: bounded output and watchdogs
```

## Özet tablo

| ID | Status | Severity | Fixed | Test | Notes |
|---|---|---:|---:|---|---|
| BUG-001 | CONFIRMED | P0 | Yes | `electron/test/phase1-lifecycle.test.cjs` | Verifier cancellation shares the job abort path. |
| BUG-002 | CONFIRMED | P0 | Yes | `electron/test/phase1-lifecycle.test.cjs` | Verifier timeout and cleanup are bounded. |
| BUG-003 | CONFIRMED | P0 | Yes | `electron/test/phase1-lifecycle.test.cjs` | Reservation is synchronous before revalidation. |
| BUG-004 | CONFIRMED | P0 | Yes | `electron/test/phase1-lifecycle.test.cjs` | Allocation failure releases the reservation. |
| BUG-005 | CONFIRMED | P0 | Yes | `electron/test/phase1-lifecycle.test.cjs` | Accepted response precedes deferred events. |
| BUG-006 | CONFIRMED | P0 | Yes | `tests/test_inspector.py` | One source hash plus identity checks; bounded probe. |
| BUG-007 | CONFIRMED | P0 | Yes | `tests/test_inspector.py`, `tests/test_verify_contract.py`, `electron/test/b-executor.test.cjs` | Shared first-real-video policy, uppercase `V:0`/`0:V:0`, and selected-stream frame evidence are enforced across inspection, verification, and mapping. |
| BUG-008 | CONFIRMED | P0 | Yes | `electron/test/phase3-audit.test.cjs` | SHA/size fingerprint is checked before drag and thumbnail. |
| BUG-009 | CONFIRMED | P0 | Yes | `electron/test/phase3-audit.test.cjs` | Dimensions, frames, duration and audio contract are checked. |
| BUG-010 | CONFIRMED | P1 | Yes | `electron/test/phase4-audit.test.cjs` | Exact token boundaries reject `btX2390`. |
| BUG-011 | CONFIRMED | P1 | Yes | `electron/test/phase4-audit.test.cjs` | Async capability probes are coalesced and cached. |
| BUG-012 | CONFIRMED | P1 | Yes | `electron/test/phase4-audit.test.cjs` | Duration-based monotonic progress and bounded parsing. |
| BUG-013 | CONFIRMED | P1 | Yes | `tests/test_verify_contract.py` | Missing numeric fields fail safely or use format duration. |
| BUG-014 | CONFIRMED | P1 | Partial | `electron/test/phase3-audit.test.cjs` | Output scan is bounded and documented as evidence, not an unbounded guarantee. |
| BUG-015 | CONFIRMED | P1 | Yes | `tests/test_inspector.py`, `tests/test_verify_contract.py` | Generic HLG/PQ source re-gates reuse normalized stream plus selected-frame evidence and reject frame-only DOVI/HDR10+ markers. |
| BUG-016 | CONFIRMED | P1 | Yes | `electron/test/phase4-audit.test.cjs` | Oversize/truncated thumbnail data never reaches success. |
| BUG-017 | CONFIRMED | P1 | Yes | `electron/test/phase1-lifecycle.test.cjs`, `electron/test/process-tree-lifecycle.test.cjs` | Detached owned groups receive one TERM, bounded grace, and conditional KILL; cancel, verifier timeout, and runtime disposal leave no fixture descendants. |
| BUG-018 | CONFIRMED | P1 | Yes | `electron/test/phase3-audit.test.cjs` | Cleanup warning and bounded scavenging are explicit. |
| BUG-019 | CONFIRMED | P1 | Yes | `electron/test/conversion-ipc.test.cjs` | Token minting follows canonicalization and failure is safe. |
| BUG-020 | CONFIRMED | P1 | Yes | `electron/test/phase1-lifecycle.test.cjs` | Inspection and conversion use one coordinator. |
| BUG-021 | CONFIRMED | P1 | Yes | `electron/test/ipc-contract.test.cjs` | IPC duration is absent or a finite positive JSON number; eligible results require it and renderer formatting is numeric-only. |
| BUG-022 | CONFIRMED | P1 | Yes | `tests/test_inspector.py` | Strict 0/1 boolean parsing fails closed. |
| BUG-023 | CONFIRMED | P1 | Yes | `tests/test_classifier.py` | HLG level is compared exactly. |
| BUG-024 | CONFIRMED | P1 | Yes | `electron/test/phase5-edge.test.cjs` | Partial host initialization cleans once and preserves other listeners. |
| BUG-025 | CONFIRMED | P1 | Partial | `electron/test/phase5-edge.test.cjs` | Darwin Mach-O architecture and dylib portability gate is fixed; portable tool provisioning remains deferred. |
| BUG-026 | CONFIRMED | P1 | Yes | `tests/test_path_boundary.py`, `electron/test/path-policy.test.cjs` | Python/Node canonical path and symlink rules are aligned against one language-neutral parity corpus; runtimes remain independent. |
| BUG-027 | CONFIRMED | P2 | Yes | `tests/test_path_boundary.py`, `electron/test/path-policy.test.cjs` | Lower-case containment fallback is removed; canonical comparisons are component-wise and case-sensitive except explicit macOS aliases. |
| BUG-028 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | Deterministic doctor gives actionable local-tool failure without fallback. |
| BUG-029 | CONFIRMED | P2 | Yes | `electron/test/phase3-audit.test.cjs` | Policy is all source audio streams retained as AAC with channel/sample-rate checks. |
| BUG-030 | CONFIRMED | P2 | Yes | `electron/test/phase3-audit.test.cjs` | Privacy check is semantic metadata inspection, not raw payload `strings`. |
| BUG-031 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | NFKC, safe Unicode preservation, byte bound and file mode are covered. |
| BUG-032 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | Output root is 0700 and files are 0600. |
| BUG-033 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | `~/Movies` symlink escape is rejected explicitly. |
| BUG-034 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | Production bundle uses an allowlist and audit. |
| BUG-035 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | Symlinks and recursive cycles are rejected. |
| BUG-036 | CONFIRMED | P2 | Yes | `electron/test/workflow-integration-entry.test.cjs` | Outer startup rejection is swallowed only after safe logging. |
| BUG-037 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | Output records have TTL and a hard size bound. |
| BUG-038 | CONFIRMED | P2 | Yes | `electron/test/phase4-audit.test.cjs` | Thumbnail requests deduplicate, cache within bounds and clean owners. |
| BUG-039 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | Electron is exact-pinned in package and lockfile. |
| BUG-040 | CONFIRMED | P2 | Yes | `electron/test/phase5-edge.test.cjs` | Bundle hashing uses bounded chunks. |

No additional `NEW-###` finding is reported: the remaining observations are recorded against the supplied BUG IDs or as explicit manual deferrals below.

---

## BUG-001 — Verifier aşamasında iptal gerçekte çalışmıyor olabilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `electron/conversion-service.cjs` passes the job abort signal through `_runManagedOperation` to `_runVerifier`; tracked verifier children are killed during terminal cleanup and the commit turn checks cancellation.
- Reproduction: `electron/test/phase1-lifecycle.test.cjs` covers `cancel during verifier` and asserts one cancelled terminal event.
- Root cause: The original verifier path was not bound to the job’s cancellation/finalization lifecycle.
- Fix: Shared abort controller, process tracking, idempotent terminalization, staging cleanup and a cancellation check immediately before commit.
- Tests: `electron/test/phase1-lifecycle.test.cjs` pass under the final Electron suite.
- Residual risk: No live Resolve host cancellation test was performed.
- External references: https://nodejs.org/api/child_process.html#child_processkill

## BUG-002 — Verifier timeout’u olmadığı için iş sonsuza kadar takılabilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `_runManagedOperation` applies verifier total and stall timers; timeout/stall aborts the job and clears timers/listeners.
- Reproduction: `electron/test/phase1-lifecycle.test.cjs` uses a never-settling verifier and checks timeout, abort and one terminal event.
- Root cause: Verifier completion previously depended only on child completion.
- Fix: Verifier watchdog with safe `verification_timeout`/`verification_stalled` reasons and centralized cleanup.
- Tests: `electron/test/phase1-lifecycle.test.cjs` pass; `npm run check` reports 146 Python and 216 Electron tests passed, including `electron/test/process-tree-lifecycle.test.cjs` real parent/grandchild coverage.
- Residual risk: Process-group behavior is covered by `electron/test/process-tree-lifecycle.test.cjs` real parent/grandchild fixtures (TERM, grace, conditional KILL, cancel/verifier-timeout/app-quit disposal); OS-level zombie reaping remains a short-lived platform boundary.
- External references: https://nodejs.org/api/child_process.html#child_processchild_process_spawn_command_args_options

## BUG-003 — Eşzamanlı iki `startJob()` çağrısı tek-iş kilidini aşabilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `startJob()` calls `reserveOperation()` and inserts the job before its first await; `HeavyOperationCoordinator` owns the single active slot.
- Reproduction: `electron/test/phase1-lifecycle.test.cjs` starts two jobs while revalidation is held and accepts only one.
- Root cause: An asynchronous revalidation gap existed before reservation.
- Fix: Synchronous operation reservation and guaranteed release on every pre-run failure.
- Tests: `electron/test/phase1-lifecycle.test.cjs` pass.
- Residual risk: None known for the tested in-process race.
- External references: None.

## BUG-004 — Output path allocation hatasında aktif iş kilidi sızabilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `startJob()` wraps output-root, allocation and staging setup in `_prepareJob`; `_dropUnstartedJob()` removes maps, cleans staging and releases the reservation.
- Reproduction: `electron/test/phase1-lifecycle.test.cjs` injects allocation failure and asserts no job or active operation remains.
- Root cause: Allocation/setup exceptions could occur outside complete job cleanup.
- Fix: Single pre-run cleanup path with idempotent reservation release.
- Tests: `electron/test/phase1-lifecycle.test.cjs` pass.
- Residual risk: A real disk-full/mount-removal run was not performed.
- External references: None.

## BUG-005 — Terminal event renderer `jobId` almadan önce kaybolabilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `_prepareJob()` returns the accepted `jobId` before scheduling `_runJob()` with `setImmediate`; event payloads carry that ID and sequence.
- Reproduction: `electron/test/phase1-lifecycle.test.cjs` checks that no queued/terminal event precedes the accepted response, including immediate executor failure.
- Root cause: Work could begin before the IPC start response reached the renderer.
- Fix: Defer event emission and process start until after acceptance is returned.
- Tests: `electron/test/phase1-lifecycle.test.cjs` pass.
- Residual risk: Renderer behavior in a real packaged host was not manually exercised.
- External references: None.

## BUG-006 — Inspection 20 saniye timeout + iki tam SHA-256 okuması büyük dosyalarda sahte hata üretebilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `prototype/inspector.py::_inspect_canonical` hashes once, compares pre/post `dev/ino/size/mtime_ns`, and runs bounded FFprobe with a separate timeout; the Electron adapter has bounded output and watchdogs.
- Reproduction: `tests/test_inspector.py` covers single hashing and mutation detection; timeout paths return safe failure codes.
- Root cause: Repeated full reads consumed time and made mutation protection depend on a second hash.
- Fix: One hash plus identity snapshots and bounded probe execution.
- Tests: `tests/test_inspector.py` and final `npm run check` pass.
- Residual risk: No physically slow external-volume measurement was performed.
- External references: https://ffmpeg.org/ffprobe.html#read-intervals

## BUG-007 — “İlk video karesi” yerine ilk paket taranıyor ve attached picture ana video seçilebilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `prototype/evidence.py` defines the first file-order `codec_type=video` stream with strict `attached_pic != 1` selection; inspector, verifier timing/HDR scans and source re-gates use it, while FFmpeg calls use uppercase `V:0`/`0:V:0`.
- Reproduction: `tests/test_inspector.py` and `tests/test_verify_contract.py` cover audio-first, attached-picture, default-disposition, and other-video frame metadata; `electron/test/b-executor.test.cjs` covers the conversion map.
- Root cause: Inspector, verifier and conversion previously had separate default/`v:0` selection behavior.
- Fix: The pure evidence helper and explicit uppercase selectors now make first-real-video and selected-frame evidence one internal contract; stream index is not exposed to the renderer.
- Tests: Focused regression tests and `npm run check` pass.
- Residual risk: FFprobe remains an external executable and malformed probe structures fail closed.
- External references: https://ffmpeg.org/ffprobe.html#Stream-specifiers

## BUG-008 — Verified output kimliği dosyanın gerçek içeriğine bağlı olmayabilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `ConversionService` records a SHA-256/size fingerprint after verification and hard-link commit; `resolveOutputForDrag()` and thumbnail generation recompute and compare it.
- Reproduction: `electron/test/phase3-audit.test.cjs` replaces a verified output with same-size bytes and asserts drag/thumbnail rejection.
- Root cause: A verified path alone did not identify the bytes subsequently consumed.
- Fix: Fingerprint-bound verification, commit and consumer revalidation.
- Tests: `electron/test/phase3-audit.test.cjs` pass.
- Residual risk: The record does not persist `dev/ino/mtimeNs`, but content SHA plus size is checked.
- External references: https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm

## BUG-009 — Verifier yanlış çözünürlük veya eksik/bozuk sesi başarılı kabul edebilir

- Status: CONFIRMED
- Severity: P0
- Evidence: `electron/verify_contract.py::verify_media_contract` checks presentation dimensions, exact decoded video frame count, duration, audio stream count, AAC codec and channel/sample-rate shape.
- Reproduction: `tests/test_verify_contract.py` covers altered timing/media contract; `electron/test/phase3-audit.test.cjs` checks verifier contract scope.
- Root cause: Verification compared too little of the output media contract.
- Fix: Dedicated JSON contract helper and documented all-audio-stream policy.
- Tests: `tests/test_verify_contract.py`, `electron/test/phase3-audit.test.cjs`, and `npm run check` pass.
- Residual risk: Rotation/SAR/DAR policy is limited to the implemented display-matrix handling.
- External references: None.

## BUG-010 — Capability token regex’i noktayı doğru kaçırmıyor olabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `electron/b-executor.cjs::hasExactToken` escapes each non-alphanumeric character and applies non-alphanumeric boundaries.
- Reproduction: `electron/test/phase4-audit.test.cjs` rejects `btX2390` and accepts `bt.2390`.
- Root cause: The prior escape expression did not reliably protect the dot token.
- Fix: Explicit character escaping and boundary matching.
- Tests: `electron/test/phase4-audit.test.cjs` pass.
- Residual risk: None known for the tested token grammar.
- External references: None.

## BUG-011 — `spawnSync` capability kontrolleri Electron main thread’ini dondurabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: Capability checks now use async `spawn`, bounded output/timeout, and a promise cache keyed by executable identity and profile.
- Reproduction: `electron/test/phase4-audit.test.cjs` asserts a thenable result, concurrent coalescing and no repeated completed probe.
- Root cause: Synchronous capability probes blocked the main event loop.
- Fix: Asynchronous probes, in-flight coalescing and executable-identity cache keys.
- Tests: `electron/test/phase4-audit.test.cjs` pass.
- Residual risk: Cache invalidation is identity-based; unusual filesystem timestamp granularity could require another probe.
- External references: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options

## BUG-012 — Progress göstergesi gerçek ilerlemeyi göstermiyor olabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `b-executor.cjs` parses `out_time_ms`, `out_time_us` and timecode records, calculates duration-based percentages, consumes split/long chunks and throttles reports; service preserves monotonic `0..99` progress.
- Reproduction: `electron/test/phase4-audit.test.cjs` covers 5000-line output, chunk parsing, duration ratio and throttled monotonic events.
- Root cause: Progress was approximate and the old total-buffer cap could stop parsing.
- Fix: Incremental record consumption, duration ratio, monotonic cap and throttle.
- Tests: `electron/test/phase4-audit.test.cjs` pass.
- Residual risk: FFmpeg progress semantics remain dependent on the selected input duration.
- External references: None.

## BUG-013 — Eksik timing alanları verifier inline Python’ını düşürebilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `electron/verify_contract.py` parses JSON values through finite-number validation, accepts format duration when stream duration is absent, and returns controlled failure for missing/`N/A` frame counts.
- Reproduction: `tests/test_verify_contract.py` covers `N/A` timing data and malformed contract inputs.
- Root cause: Direct numeric conversion could raise on missing or non-numeric FFprobe fields.
- Fix: Safe numeric parser, explicit fallback and fail-closed diagnostics.
- Tests: `tests/test_verify_contract.py` and final `npm run check` pass.
- Residual risk: A container with no usable frame count is rejected rather than inferred.
- External references: None.

## BUG-014 — Çıktıda HDR side-data kontrolü yalnızca ilk paket/kare ile sınırlı olabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `scripts/verify-spike.sh` scans stream evidence and up to 32 initial output frames; README and script explicitly call this a bounded evidence window.
- Reproduction: `electron/test/phase3-audit.test.cjs` checks bounded HDR scanning and the absence of raw payload scanning.
- Root cause: A one-frame check could miss metadata appearing shortly after the first frame.
- Fix: Bounded 32-frame scan plus truthful limitation wording; no unbounded guarantee is claimed.
- Tests: `electron/test/phase3-audit.test.cjs`, `tests/test_verify_contract.py`, and `npm run check` pass.
- Residual risk: HDR side-data after the bounded window can remain undetected.
- External references: None.

## BUG-015 — Generic HLG kontrolü frame-level Dolby Vision metadata’yı kaçırabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `prototype/evidence.py::extract_evidence` combines selected-stream and selected-frame side data; both generic HLG and PQ source re-gates call the same normalized predicates and reject DOVI/HDR10+ markers found only on selected frames.
- Reproduction: `tests/test_inspector.py` and `tests/test_verify_contract.py` cover frame-only DOVI/HDR10+ and prove attached/other-video frames cannot inject evidence.
- Root cause: The shell verifier previously duplicated stream-only metadata extraction instead of using the inspection contract.
- Fix: `electron/verify_contract.py` imports the pure Python evidence helper, and `scripts/verify-spike.sh` delegates both generic/PQ source re-gates to it.
- Tests: Focused evidence/re-gate tests and `npm run check` pass.
- Residual risk: The source scan is bounded by FFprobe’s initial interval; this is an intentional bounded evidence policy.
- External references: https://ffmpeg.org/ffprobe.html#show-frames

## BUG-016 — Büyük thumbnail buffer’ı kesilip bozuk JPEG başarıyla döndürülebilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `_generateThumbnailDataUrl()` aborts and returns failure when the byte limit is exceeded, and `_decodeThumbnailBuffer()` requires a non-empty successful native-image/decode result.
- Reproduction: `electron/test/phase4-audit.test.cjs` covers oversized and undecodable thumbnail output.
- Root cause: A truncated buffer could previously be treated as a completed image.
- Fix: Over-limit rejection before decode, decode validation, bounded child lifetime and safe cleanup.
- Tests: `electron/test/phase4-audit.test.cjs` pass.
- Residual risk: Native decoder behavior still depends on the host Electron runtime.
- External references: https://www.electronjs.org/docs/latest/api/native-image

## BUG-017 — Ana conversion için timeout/stall watchdog ve app-quit cleanup eksik olabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: Inspector, converter, verifier, capability probes, and thumbnails spawn with `detached:true`, `shell:false`; coordinator-owned groups receive exactly one SIGTERM, a configurable bounded grace, and SIGKILL only when the owned group remains alive. Direct-child fallback is used only when POSIX group/PID proof is unavailable and never emits a negative PID on Windows.
- Reproduction: `electron/test/process-tree-lifecycle.test.cjs` uses real parent/grandchild fixtures for graceful TERM, TERM-ignoring escalation, converter cancellation, verifier timeout, app-quit disposal, repeated termination, and timer/map cleanup. `electron/test/phase1-lifecycle.test.cjs` retains watchdog and terminal-event coverage.
- Root cause: The previous path tracked direct children but had no process-group ownership or grace-period escalation, so shell descendants could survive.
- Fix: `HeavyOperationCoordinator` now owns per-child lifecycle records, listener/timer cleanup, idempotent TERM→grace→conditional KILL, and awaitable bounded disposal. All coordinator-owned spawns are enrolled; standalone capability/inspection/conversion paths use the same bounded fallback coordinator.
- Tests: Focused BUG-017 lifecycle tests and final `npm run check` pass; normal tests never launch Resolve.
- Residual risk: A process that is not created and enrolled through these internal spawn seams is outside the coordinator's ownership proof; OS-level process accounting can still report a short-lived zombie until reaped.
- External references: https://nodejs.org/api/child_process.html#child_processsubprocesskillsignal

## BUG-018 — Commit sonrası staging unlink hatası gizlenebilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `output-store.cjs::removeStaging` emits a generic warning, returns structured failure and invokes bounded scavenging; conversion keeps the committed hard link usable.
- Reproduction: `electron/test/phase3-audit.test.cjs` injects unlink failure and asserts warning plus safe scavenging.
- Root cause: Cleanup failure could be silently ignored after a successful commit.
- Fix: Explicit cleanup result, generic warning and exact private staging-name scavenger.
- Tests: `electron/test/phase3-audit.test.cjs` pass.
- Residual risk: A failed cleanup remains on disk until a later safe scavenger pass if the immediate retry also fails.
- External references: None.

## BUG-019 — Source token oluştururken canonicalization hataları yutulabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: IPC canonicalizes the submitted path before minting a token; failure returns `inspection_failed`, and conversion revalidates the stored canonical path before spawning.
- Reproduction: `electron/test/ipc-contract.test.cjs` covers shared source policy and canonicalization rejection.
- Root cause: Token creation could otherwise bind the submitted spelling after path validation failed.
- Fix: No token is minted from uncanonicalized input; safe generic errors are returned.
- Tests: `electron/test/ipc-contract.test.cjs` and final `npm run check` pass.
- Residual risk: Canonicalization and filesystem replacement are still OS-level race boundaries; rechecks narrow the window.
- External references: https://nodejs.org/api/fs.html#fspromisesrealpathpath-options

## BUG-020 — Inspection ve conversion aynı global operasyon koordinatörünü paylaşmıyor olabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `ipc-contract.cjs` reserves `inspection` through `ConversionService`; `startJob()` reserves `conversion` through the same `HeavyOperationCoordinator`.
- Reproduction: `electron/test/phase1-lifecycle.test.cjs` reserves inspection and asserts a conversion receives `busy`.
- Root cause: Separate inspection and conversion guards could permit competing heavy work.
- Fix: One coordinator, one active reservation, tracked processes and explicit idle/release cleanup.
- Tests: `electron/test/phase1-lifecycle.test.cjs` and final `npm run check` pass.
- Residual risk: None known for the tested in-process ownership policy.
- External references: None.

## BUG-021 — IPC/Python response doğrulaması fazla yüzeysel olabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `inspection-adapter.cjs` now accepts duration only when it is absent or a finite positive JSON number; every convertible classification requires that numeric field. Renderer formatting occurs only at the UI edge.
- Reproduction: `electron/test/ipc-contract.test.cjs` rejects missing, string, NaN, Infinity, zero and negative durations while accepting an ordinary positive number.
- Root cause: Duration was emitted and validated as display-oriented text rather than a typed boundary value.
- Fix: Inspector normalization emits a positive numeric duration, IPC validators enforce the typed contract, and renderer formatting no longer parses strings.
- Tests: `electron/test/ipc-contract.test.cjs`, `tests/test_verify_contract.py`, `tests/test_inspect_cli.py` and `npm run check` pass.
- Residual risk: Containers without a usable duration remain intentionally non-convertible/fail closed.
- External references: None.

## BUG-022 — Python `bool("0")` yanlış DOVI flag’i üretebilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `prototype/inspector.py::_strict_flag` accepts booleans, integer 0/1 and string `"0"`/`"1"`; unknown values raise and parsing fails closed.
- Reproduction: `tests/test_inspector.py` covers strict flag handling through probe fixtures.
- Root cause: Python truthiness treats non-empty strings such as `"0"` as true.
- Fix: Explicit flag parser and controlled evidence-extraction failure.
- Tests: `tests/test_inspector.py` and final `npm run check` pass.
- Residual risk: Unsupported producer-specific flag encodings remain unsupported rather than guessed.
- External references: https://docs.python.org/3/library/stdtypes.html#truth-value-testing

## BUG-023 — Bilinen HLG profilinde `level` tam karşılaştırılmıyor olabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `prototype/classifier.py::_expected_hlg_match` requires `ev.level == EXPECTED_HLG["level"]`; missing or wrong level fails the allowlist match.
- Reproduction: `tests/test_classifier.py` changes the expected level and asserts rejection.
- Root cause: Presence of a level was weaker than the known-local profile contract.
- Fix: Exact normalized level comparison while retaining SHA and metadata gates.
- Tests: `tests/test_classifier.py` and final `npm run check` pass.
- Residual risk: The exact level remains a deliberately narrow local allowlist policy.
- External references: None.

## BUG-024 — Resolve host lifecycle yarıda başarısız olursa cleanup çalışmayabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `electron/main.cjs` calls partial cleanup after each lifecycle failure, guards `CleanUp()` with an idempotent flag and removes only its owned `before-quit` listener.
- Reproduction: `electron/test/phase5-edge.test.cjs` makes `SetAPITimeout` fail and checks one cleanup; it also checks an unrelated listener survives.
- Root cause: Partial host initialization and broad listener removal were unsafe.
- Fix: Ordered lifecycle guards, owned listener removal and exactly-once cleanup.
- Tests: `electron/test/phase5-edge.test.cjs`, `electron/test/lifecycle.test.cjs`, and `npm run check` pass.
- Residual risk: Actual Resolve SDK callback behavior was not exercised in a live host.
- External references: https://www.blackmagicdesign.com/developer/

## BUG-025 — “Self-contained bundle” taşınabilirlik doğrulaması eksik olabilir

- Status: CONFIRMED
- Severity: P1
- Fixed: Partial
- Evidence: The reproduced Darwin bundle contains a universal `WorkflowIntegration.node` (`file`: `Mach-O universal binary with 2 architectures` with `x86_64` and `arm64`; `lipo -archs`: `x86_64 arm64`) with `codesign --verify --deep --strict` **PASS** as `Developer ID Application: Blackmagic Design Inc (9ZGFBWLSYP)` (`Authority=Developer ID Certification Authority`, `flags=0x20000(runtime)`). In contrast, both `tools/ffmpeg` and `tools/ffprobe` are thin `arm64` Mach-O binaries (`file`: `Mach-O 64-bit executable arm64`; `lipo -archs`: `arm64`) with ad-hoc signatures (`CodeDirectory flags=0x2(adhoc)`) and `otool -L` reports **83 dylib dependencies each**, including absolute `/opt/homebrew/...` paths such as `/opt/homebrew/Cellar/ffmpeg-full/9.0.1_1/lib/libavcodec.63.dylib` and `/opt/homebrew/opt/libxcb/lib/libxcb.1.dylib`. Parent-observed bounded `file`/`lipo`/`otool`/`codesign` confirms local `codesign --verify` passes for the node but the current `ffmpeg`/`ffprobe` remain **NOT self-contained / NOT Intel-portable**.
- Reproduction: The prior allowlist audit passed the real bundle despite those observations. `electron/test/phase5-edge.test.cjs` now injects synthetic `file`/`lipo`/`otool -L` output and covers both a universal relocatable pass and thin/absolute-dependency rejection without Mach-O fixtures. Bounded `npm run bundle:resolve` now deterministically fails closed on the current tools, with sanitized reason.
- Root cause: The audit checked file shape, hashes and text leakage but never inspected Mach-O slices or load commands, so dereferencing a tool symlink falsely looked self-contained.
- Fix: `scripts/bundle-audit.cjs` now fails closed on Darwin unless `WorkflowIntegration.node`, `tools/ffmpeg`, and `tools/ffprobe` are Mach-O binaries containing both `x86_64` and `arm64`; only `/usr/lib`, `/System/Library`, and `@rpath`/`@loader_path`/`@executable_path` dependencies are accepted. Probes use bounded `execFileSync` argument arrays with `shell:false`, and parser/runner seams remain injectable. The audit gate is fixed, but portable universal/relocatable tools are still **BLOCKED/DEFERRED**; no binaries were downloaded, installed, or changed.
- Tests: `electron/test/phase5-edge.test.cjs` covers the gate; `npm run bundle:resolve` is expected to fail deterministically on the current arm64 Homebrew tools.
- Residual risk: A passing portability audit is mechanical — local `codesign --verify` is not a clean-host proof. Codesign/notarization and actual Intel/Apple Silicon/MoltenVK runtime behavior still require separate validation after portable universal tools are provisioned.
- External references: https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution

## BUG-026 — Inspection ve conversion symlink politikası farklı olabilir

- Status: CONFIRMED
- Severity: P1
- Evidence: `electron/source-path-policy.cjs` and `prototype/path_boundary.py` reject final/parent symlinks except documented macOS aliases and compare resolved canonical components case-sensitively. Conversion revalidates the same identity.
- Reproduction: `tests/test_path_boundary.py` and `electron/test/path-policy.test.cjs` consume the same `tests/fixtures/path-parity.json` corpus for alias, case and component-prefix cases; no runtime calls across languages are used.
- Root cause: The two implementations had no executable parity contract.
- Fix: A small language-neutral JSON corpus and parallel parity tests now pin equivalent normalization/equality behavior while keeping Python and Node independent.
- Tests: Python/Node path-policy tests and `npm run check` pass.
- Residual risk: Filesystem-specific symlink behavior beyond the explicit macOS aliases still depends on each host OS.
- External references: https://docs.python.org/3/library/pathlib.html#pathlib.Path.resolve

## BUG-027 — Case-insensitive containment fallback’i case-sensitive volume’da yanlış olabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: Canonical containment now uses component-wise `Path.relative_to()` only; Python/Node canonical equality preserves case after resolution and rewrites only explicit macOS aliases.
- Reproduction: `tests/test_path_boundary.py` and `electron/test/path-policy.test.cjs` reject a differently cased sibling and a component-prefix collision from the shared parity corpus.
- Root cause: A lower-case macOS compatibility fallback had been applied as a universal containment rule.
- Fix: The fallback was removed; alias handling is explicit and case-sensitive everywhere else.
- Tests: Path regression tests and `npm run check` pass.
- Residual risk: None known for the implemented canonical component policy.
- External references: https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html

## BUG-028 — Fresh clone için tool setup akışı tam otomatik olmayabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `scripts/tool-doctor.cjs` now checks only repo-local executable regular files and emits an actionable failure; README explicitly requires trusted manual provisioning and forbids PATH/download fallback.
- Reproduction: `electron/test/phase5-edge.test.cjs` runs the doctor against a temporary local tool root; `npm run doctor` passed for the current repo tools.
- Root cause: Fresh clone tool binaries are external provisioning inputs, not npm dependencies.
- Fix: Deterministic doctor and documented manual provisioning path were added; automatic download/install was intentionally not introduced.
- Tests: `electron/test/phase5-edge.test.cjs`, `npm run doctor` pass.
- Residual risk: A fresh clone still needs the verified FFmpeg/FFprobe binaries supplied manually.
- External references: None.

## BUG-029 — Bütün audio stream’lerini AAC 192k’ye çevirme ürün davranışı belirsiz

- Status: CONFIRMED
- Severity: P2
- Evidence: `b-executor.cjs` uses `-map 0:a?` and AAC 192k; `verify_contract.py` requires equal audio stream count, AAC output and channel/sample-rate preservation; README documents the policy.
- Reproduction: `electron/test/phase3-audit.test.cjs` checks audio-aware verifier scope; full suite passes.
- Root cause: The conversion and verification contract did not previously state or enforce a single audio policy.
- Fix: Explicit policy: retain all source audio streams in order, re-encode as AAC, preserve channel/sample-rate shape, and retain no track when source has none.
- Tests: `electron/test/phase3-audit.test.cjs`, `tests/test_verify_contract.py`, and `npm run check` pass.
- Residual risk: Codec-quality/channel-layout behavior beyond the checked channel/sample-rate shape is not a visual listening assessment.
- External references: None.

## BUG-030 — Privacy doğrulamasındaki ham `strings` taraması false positive üretebilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `scripts/verify-spike.sh` delegates privacy checking to `verify_contract.py::scan_semantic_privacy_tags`, which traverses FFprobe format/stream tag maps and no longer scans compressed bytes.
- Reproduction: `electron/test/phase3-audit.test.cjs` asserts absence of the raw `strings` scan and presence of semantic checks.
- Root cause: Searching compressed payload bytes conflated arbitrary encoded content with metadata keys.
- Fix: Semantic allowlisted tag-key scan for QuickTime, ISO6709, location and creation-time metadata.
- Tests: `electron/test/phase3-audit.test.cjs`, `tests/test_verify_contract.py`, and `npm run check` pass.
- Residual risk: The semantic check cannot prove absence of privacy data hidden outside FFprobe-exposed tag maps.
- External references: None.

## BUG-031 — Unicode/Türkçe çıktı adları gereksiz bozulabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `output-store.cjs::sanitizeBasename` applies NFKC, preserves safe Unicode letters/marks/numbers/emoji, removes separators/control characters and bounds UTF-8 bytes; profile suffixes remain deterministic.
- Reproduction: `electron/test/phase5-edge.test.cjs` covers CJK/emoji, separator/control rejection, bounded name and hardened file.
- Root cause: The old sanitizer was not an explicit Unicode/path-safety policy.
- Fix: Unicode-aware sanitizer, basename-only output construction and byte bound.
- Tests: `electron/test/phase5-edge.test.cjs` and `npm run check` pass.
- Residual risk: Collision handling is filename-based and intentionally chooses a suffix rather than merging names.
- External references: None.

## BUG-032 — Output izinleri gizlilik hedefiyle uyumsuz olabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `output-store.cjs` creates/hardens the output root to 0700 and staging/final files to 0600, with post-operation mode checks.
- Reproduction: `electron/test/phase5-edge.test.cjs` creates a permissive file, hardens it and asserts mode 0600; root logic is in `ensureOutputRoot()`.
- Root cause: Default directory/file permissions could expose local media to other users.
- Fix: Explicit private modes and fail-visible permission validation.
- Tests: `electron/test/phase5-edge.test.cjs` and final `npm run check` pass.
- Residual risk: Exact permission semantics remain platform/volume dependent; current validation is local macOS/POSIX-oriented.
- External references: https://nodejs.org/api/fs.html#fspromiseschmodpath-mode

## BUG-033 — `~/Movies` symlink olduğunda output root çalışmayabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `ensureOutputRoot()` rejects an application-controlled symlink at `~/Movies` or `HdrToSdr`, validates realpath containment and returns safe `output_root_unsafe` instead of redirecting.
- Reproduction: Output-root symlink rejection is covered by output-store tests and the implementation’s `lstat`/realpath checks.
- Root cause: Silently following a user-controlled output-root symlink could redirect private output.
- Fix: Explicit reject-and-report policy, with only documented macOS system aliases tolerated by the source/output helpers.
- Tests: Output-store tests and final `npm run check` pass.
- Residual risk: Users with symlinked `~/Movies` must choose a supported provisioning/layout rather than being redirected.
- External references: https://nodejs.org/api/fs.html#fslstatsyncpath-options

## BUG-034 — Production bundle gereksiz source/test dosyaları içeriyor olabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `scripts/bundle-audit.cjs::BUNDLE_FILE_ALLOWLIST` defines runtime files; build copies only the allowlisted runtime files and audits unexpected entries.
- Reproduction: `electron/test/phase5-edge.test.cjs` adds an unexpected file and asserts audit failure.
- Root cause: Recursive broad copying could include tests, caches and development assets.
- Fix: Explicit production allowlist plus post-build audit.
- Tests: `electron/test/phase5-edge.test.cjs` and `npm run check` pass.
- Residual risk: Any future runtime file must be deliberately added to the allowlist.
- External references: None.

## BUG-035 — Recursive symlink kopyalamada cycle koruması olmayabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: Build traversal rejects symlinks, tracks visited real directories, and the bundle audit rejects symlink entries/cycles.
- Reproduction: `electron/test/phase5-edge.test.cjs` creates a cycle and asserts a symlink audit failure.
- Root cause: Following directory links during recursive copy could recurse indefinitely or escape the source tree.
- Fix: No-symlink traversal and visited-directory guard.
- Tests: `electron/test/phase5-edge.test.cjs` and final `npm run check` pass.
- Residual risk: The real SDK/tool provisioning tree still requires the manual bundle step.
- External references: https://nodejs.org/api/fs.html#fslstatsyncpath-options

## BUG-036 — Startup shim hatayı tamamen yutuyor olabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `electron/main.cjs` logs only a safe startup stage and returns a generic failure; generated `main.js` catches the outer startup rejection to avoid an unhandled rejection while preserving the module export.
- Reproduction: `electron/test/workflow-integration-entry.test.cjs` verifies the outer rejection is handled; lifecycle tests verify generic startup failure.
- Root cause: Startup error handling needed a stable user-safe outcome without exposing stack/path data or leaving an unhandled rejection.
- Fix: Safe stage logging, generic startup result and narrowly scoped outer catch.
- Tests: `electron/test/workflow-integration-entry.test.cjs`, `electron/test/lifecycle.test.cjs`, and `npm run check` pass.
- Residual risk: The outer bundle entry intentionally does not surface raw startup diagnostics to the renderer.
- External references: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises

## BUG-037 — Output capability kayıtları oturum boyunca birikebilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `ConversionService` bounds output records at 128, expires them by TTL, prunes before lookup/drag and clears related thumbnail entries.
- Reproduction: `electron/test/phase5-edge.test.cjs` checks expiry and bounded retention.
- Root cause: Verified output identities had no session lifetime or size bound.
- Fix: Fixed TTL, bounded insertion order and cache cleanup on prune.
- Tests: `electron/test/phase5-edge.test.cjs` and `npm run check` pass.
- Residual risk: TTL is a policy bound; an output is intentionally unavailable after expiry.
- External references: None.

## BUG-038 — Thumbnail çağrılarında eşzamanlılık ve deduplication yok olabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `ConversionService` uses one in-flight promise per output/owner/fingerprint, bounded byte/entry cache, owner cleanup and fingerprint revalidation before/after decoding.
- Reproduction: `electron/test/phase4-audit.test.cjs` checks concurrent deduplication, cache bounds, owner cleanup and tamper invalidation.
- Root cause: Independent thumbnail requests could spawn duplicate decoders and retain stale bytes.
- Fix: Owner/fingerprint-scoped in-flight map, decode validation, bounded LRU-like eviction and cleanup hooks.
- Tests: `electron/test/phase4-audit.test.cjs` and final `npm run check` pass.
- Residual risk: The native image decoder remains host-provided and is mocked for deterministic tests.
- External references: https://www.electronjs.org/docs/latest/api/native-image

## BUG-039 — Electron sürümü lockfile dışı kurulumlarda kayabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `package.json` and `package-lock.json` both pin Electron to exact `41.10.3`; no range operator is used.
- Reproduction: `electron/test/phase5-edge.test.cjs` asserts package, root lock and installed package versions.
- Root cause: A dependency range could silently change the Electron runtime used by the host integration.
- Fix: Exact package and lockfile pin, documented in the developer bundle documentation.
- Tests: `electron/test/phase5-edge.test.cjs` and `npm run check` pass.
- Residual risk: A clean install still requires running the package manager with the lockfile policy; no Resolve host compatibility matrix was run.
- External references: https://www.electronjs.org/docs/latest/tutorial/electron-versioning

## BUG-040 — Build hash işlemi büyük binary’yi tek seferde RAM’e alıyor olabilir

- Status: CONFIRMED
- Severity: P2
- Evidence: `scripts/bundle-audit.cjs::sha256File` and the build script hash files using bounded read streams/chunks rather than whole-file `readFileSync` buffers.
- Reproduction: `electron/test/phase5-edge.test.cjs` verifies the chunked hash result against a known digest; bundle audit also exercises the path.
- Root cause: Whole-file hashing risks unnecessary memory use for bundled binaries.
- Fix: Chunked SHA-256 helper reused by bundle auditing and SDK/tool copy verification.
- Tests: `electron/test/phase5-edge.test.cjs` and `npm run check` pass.
- Residual risk: No multi-gigabyte binary stress run was performed.
- External references: https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm

## Fiziksel/manual deferrals — Final no-GUI bounded kanıtı sonrası güncel

- **Gerçek Resolve Workflow Integration host smoke (GUI):** `Initialize('com.hdrtosdr.app')` → panel lifecycle ve `webContents.startDrag` → Media Pool/timeline drop yalnızca canlı Studio GUI'de doğrulanır. Mevcut kapsamda yalnızca fake lifecycle ve IPC testleri koştu; GUI paneli ise ayrı geçmiş koşumda `Workspace → Workflow Integrations` altında başarıyla açılmıştı — headless bridge deneyi bu GUI kanıtının yerini tutmaz.
- **Headless WorkflowIntegration bridge (undocumented, bounded deney — PARTIAL/NOT SUPPORTED):** Parent tarafından sahip olunan Resolve `-nogui` child'a karşı iki bounded koşum yapıldı (repo Electron **41.10.3** ve Resolve-bundled Electron, kurulu resmi `WorkflowIntegration.node`). Her ikisinde `Initialize('com.hdrtosdr.app')` **true**, ancak `SetAPITimeout`, `GetResolve`, `CleanUp` **başarısız**; her iki koşum da sahip olunan child'ı temizledi (**Resolve residue 0**, fuscript residue 0). Dokümansız sınır; **GUI host'ta ürün hatası olarak sınıflandırılmaz** — headless bridge davranışı ayrı bounded olgudur (`docs/no-gui-validation-research-2026-08-29.md:§7.2`).
- **Gerçek HLG pipeline (mekanik vs görsel ayrımı):** `Sample/1.MOV` üzerinde bounded no-GUI pipeline koşusu **mechanical PASS** verdi — inspector `hlgKnownLocal` / `hlg-local-b-v1`, gerçek `b-executor` conversion başarılı, verifier `exit 0/PASS` (source SHA + Rec.709 tags), temp çıktı silindi. Bu **mekanik yerel pipeline** kanıtıdır; kalibre Rec.709 ekranda görsel A/B doğrulaması hâlâ **deferred/human visual** olup mekanik doğrulama görsel kabul yerine geçmez (`docs/no-gui-validation-research-2026-08-29.md:§7.1`).
- **Portable bundle / clean-host:** `WorkflowIntegration.node` universal `x86_64+arm64`, Developer ID team `9ZGFBWLSYP`, `codesign --verify --deep --strict` **PASS** (yerel doğrulama, exact pinned SHA provenance). `tools/ffmpeg` ve `tools/ffprobe` her biri **arm64-only**, ad-hoc (`flags=0x2(adhoc)`) ve **`otool -L` ile 83 dylib** bağımlılığı arasında absolute `/opt/homebrew/...` yolları var. Yeni audit Darwin gate'i ile **fail-closed** reddeder; mevcut bundle **NOT self-contained / NOT Intel-portable** — expected fail only due to arm64/Homebrew non-portable tools. Portable universal/relocatable tool provisioning, codesign/notarization, MoltenVK/libplacebo runtime ve clean-host doğrulaması **blocked/deferred** (BUG-025); portable candidate is non-release and binary gate stays unchecked; no binary readiness claimed; komutlar bounded, residue 0.
- Tüm komutlar bounded, temp dosyalar ve yalnızca sahip olunan Resolve child yönetildi.

## Doğrulama

- `npm run check` — PASS; 146 Python and 216 Electron tests pass, including `electron/test/process-tree-lifecycle.test.cjs` real parent/grandchild coverage (corrects stale 121/181 and any claim that process-tree tests weren't run), plus synthetic BUG-025 portability cases and offline BUG-017 lifecycle tests.
- `node --test electron/test/process-tree-lifecycle.test.cjs electron/test/lifecycle.test.cjs electron/test/phase1-lifecycle.test.cjs` — PASS; detached owned groups receive one TERM, bounded grace, conditional KILL; cancel, verifier timeout, and app-quit disposal leave no fixture descendants.
- `npm run guard:repo` — PASS; scans current tracked plus full-history patch content; a prospective snapshot including all non-ignored files also passed (bounded `file`/`lipo`/`otool`/`codesign` probes, `shell:false`).
- `npm audit --audit-level=high` — PASS; 0 vulnerabilities.
- `npm run doctor` — PASS; repo-local `ffmpeg` ve `ffprobe` doğrulandı, PATH/download fallback kullanılmadı.
- Resolve `-nogui` 21.0.3.7 scratch clip/timeline smoke — PASS; bounded `-nogui` child with scratch project/clip/timeline creation; Resolve/fuscript residue 0 (owned child reaped; no GUI visual/drop verification claimed).
- Media integration (bounded, no-GUI) — PASS: generic HLG / static PQ / attached-picture / audio-first / VFR — PASS; dynamic DV / HDR10+ — NOT_RUN (tool_unavailable); rotation — NOT_RUN; residue 0, temp outputs removed; no calibrated Rec.709 visual A/B claimed.
- WorkflowIntegration provenance — PASS; exact pinned SHA / `codesign --verify --deep --strict` / Developer ID team `9ZGFBWLSYP` provenance passes for `WorkflowIntegration.node` (universal `x86_64+arm64`); `file`/`lipo -archs`/`otool -L` verified.
- `npm run bundle:resolve` — EXPECTED FAIL (Darwin gate fail-closed); current bundle fails only due to arm64/Homebrew non-portable `tools/ffmpeg`/`tools/ffprobe` (thin `arm64`, ad-hoc `flags=0x2(adhoc)`, 83 absolute `/opt/homebrew` dylibs); `WorkflowIntegration.node` itself passes universal/codesign/team checks. Portable candidate is non-release and binary gate stays unchecked.
- Gerçek HLG pipeline no-GUI (`Sample/1.MOV`, `hlg-local-b-v1`, gerçek b-executor, verifier exit 0/PASS, Rec.709 tags, source SHA, temp removed) — **MECHANICAL PASS**, görsel kabul değil.
- Headless bridge (repo Electron 41.10.3 + Resolve-bundled Electron, resmi node, `Initialize true` / `SetAPITimeout`+`GetResolve`+`CleanUp` fail, residue 0) — **PARTIAL/NOT SUPPORTED**; GUI paneli daha önce açıldı; no GUI drop verification claimed.
- `git diff --check` — PASS (whitespace hatası yok; bounded komutlar, temp/Resolve residue 0).
- Rapor yapısı — PASS; 40 benzersiz `## BUG-###` bölümü, 40 schema `Status` alanı ve yalnızca izin verilen status kümesi kullanıldı; binary readiness claim yok.
