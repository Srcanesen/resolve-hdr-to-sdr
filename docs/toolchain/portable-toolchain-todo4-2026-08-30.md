# TODO 4 portable-toolchain attempt (2026-08-30)

## Verdict

**Candidate pass, release blocked.** A reproducible, repo-local build attempt
produced universal `x86_64 arm64` `ffmpeg` and `ffprobe` under
`build/portable-toolchain/out/tools/`. The candidate was never copied to
`tools/`, a bundle, or a release. The manifest remains explicitly
`releaseStatus: non-release` and `releaseEnabled: false`.

## Research and pin validation

The report's FFmpeg 9.0.1 SHA matched the official FFmpeg download. The
libplacebo `v7.351.0` tag and MoltenVK `v1.4.2` tag were confirmed at the
maintainer repositories. The build then downloaded and SHA-256 verified every
manifest entry before extracting any archive. The exact URLs, revisions, and
hashes are in `scripts/toolchain/portable-toolchain-manifest.json`.

The report's x265 4.3 reference was not found as an official tag in the
inspected MulticoreWare repository. x265 is not required by the tool contract
(the required encoder is libx264 and HEVC is decoded by FFmpeg), so it was not
guessed or added. The candidate uses a pinned official x264 stable commit,
static libplacebo, pinned Vulkan-Headers/fast_float sources, the official
MoltenVK 1.4.2 universal static archive, and the official glslang 16.5.0
universal static SDK. The FFmpeg detached signature was SHA-256 checked;
GPG signature verification was not claimed because GPG was unavailable on the
host.

## Build performed

`scripts/toolchain/build-portable-tools.sh` was run repeatedly and is
resumable from verified downloads and per-architecture prefixes. It:

- refuses non-Darwin/non-arm64 hosts, moving URLs, bad hashes, and existing
  mismatched cached downloads;
- builds x264 and libplacebo separately for arm64 and x86_64, then builds
  FFmpeg 9.0.1 for both and combines each executable with `lipo`;
- uses static third-party libraries, direct static MoltenVK linkage, and no
  Homebrew install/upgrade or global mutation;
- signs only the ignored candidate executables ad hoc after `lipo`.

The MoltenVK static archive required a macOS 12 deployment target, so the
manifest and build use `MACOS_MIN=12.0`.

## Evidence

| Gate | Result |
| --- | --- |
| Candidate regular files | PASS — both are regular executable files |
| `file` / `lipo -archs` | PASS — each is Mach-O universal with `x86_64 arm64` |
| `otool -L` | PASS — only `/usr/lib` and `/System/Library` dependencies; no Homebrew or user paths |
| `codesign --verify --deep --strict` | PASS — ad hoc signatures; not Developer ID/notarized |
| libplacebo help/options | PASS — `Filter libplacebo`, `bt.2390`, `spline`, `perceptual`, `peak_detect`, and color/range/format options |
| `ffmpeg -filters` | PASS — libplacebo present |
| `ffmpeg -encoders` | PASS — `libx264` and `libx264rgb` present; no VideoToolbox encoder |
| `ffmpeg -h encoder=libx264` | PASS — preset and CRF options present; exercised medium/CRF 18 contract |
| decoders / formats | PASS — H.264, HEVC, AAC, MOV, and MP4 present |
| ffprobe frame side-data | PASS — HLG/DV sample exposes display matrix, ambient viewing environment, and Dolby side-data; pinned PQ fixture exposes mastering-display and content-light metadata |
| candidate bundle audit | PASS — an ignored bundle copy with candidate tools passed `BUNDLE AUDIT OK: 31 allowlisted regular files` |
| actual repository bundle audit | EXPECTED FAIL — unchanged repo symlink tools remain arm64/Homebrew-dependent |
| `npm run test:media:integration` | PASS — generic HLG/PQ and VFR paths passed; rotation was explicitly not run because current MP4 readback does not preserve it; dynamic DV/HDR10+ tools were unavailable |
| `npm run check` | PASS — 136 Python and 203 Electron tests |
| `npm run doctor` / `git diff --check` | PASS — doctor passed; no whitespace errors |

Candidate output hashes recorded by the verifier:

```text
92ae9baeec875ada641123a3f28757398c1d2231c8ae3e8535b0dc5abe5d1d88  ffmpeg
a83e656be6135cdd36db9f27060be570660fc03d59a7c94eca569234e5c6a5da  ffprobe
```

The verifier's JSON contains the exact path-qualified hashes. The ignored
media outputs were also hashed: HLG MP4
`3fbdad4cb3a04402ee39305720cc91f76066f4184f0bc5014ea16488e616ba49` and PQ
MP4 `39e96fd16edefecf8b67991ac15e4ab8e7ec80b5ae7f93ed2f8c3485ae777c12`.

A real candidate HLG conversion using the current local graph
(`spline:tonemapping_param=0.45:gamut_mode=perceptual`, `eq=gamma=0.90`) and
current output contract (`libx264`, High, medium, CRF 18, yuv420p, AAC 192k,
MP4) passed. Output probe reported H.264/AAC and bt709/tv/yuv420p. A generic
PQ conversion using `bt.2390:gamut_mode=perceptual` also passed with the
candidate and produced the same SDR contract. MoltenVK initialized and
created/destroyed a Vulkan device on the Apple GPU; observed
`VK_ERROR_FEATURE_NOT_PRESENT` warnings were non-fatal primitive-restart
warnings, not initialization failures.

## Release blockers / risks

- The candidate is only ad hoc signed. Developer ID signing, hardened-runtime
  policy, notarization, and a clean-host runtime test were not available in
  this bounded run.
- PQ fixture generation used the already-installed local `ffmpeg-full`
  x265 solely as a temporary test input; the candidate itself intentionally
  has no x265 encoder. This is not a release fixture provenance claim.
- The candidate was not installed into the product. `npm run bundle:resolve`
  therefore continues to fail closed against the existing arm64 symlink and
  absolute Homebrew dylib dependencies. Source GitHub release state and the
  binary bundle remain unchanged/disabled.
- The build is pinned and functional on this host, but the official MoltenVK
  and glslang inputs were consumed as hash-pinned release archives rather than
  rebuilt from their full dependency source graphs. That distinction must be
  resolved before calling this a release-grade supply-chain build.

## Hardening (2026-08-30 — TODO 4 P2s, no rebuild)

- **Archive extraction (fail-closed):** `scripts/toolchain/build-portable-tools.sh` now
  validates every member before each `tar -xf`/`unzip -q` via bounded header-only
  Python (`tarfile`/`zipfile`). Rejected: FIFO, character/block devices, and
  every other unsupported tar member type, plus absolute paths, `..` traversal
  components, backslash escapes, and symlink/hardlink members whose targets would
  escape (absolute, `..`, backslash). Safe internal relative symlinks (e.g.,
  MoltenVK `dylib -> dynamic/dylib`, glslang `glslangValidator -> glslang`) are
  allowed. All three extraction helpers (`extract_single_root`, `extract_flat_archive`,
  `extract_wheel`) call `validate_tar_members`/`validate_zip_members` before extraction.
  `scripts/toolchain/verify-portable-tools.cjs` exposes the same validation and, when
  `--downloads` is given, fails closed if any downloaded archive contains an unsafe member.
  Synthetic coverage is provided by `electron/test/toolchain-hardening.test.cjs` using
  Python-generated malicious tar/zip (absolute, traversal, backslash, escaping symlink/hardlink)
  and valid archives, all offline without network.
- **Bounded hashing:** `verify-portable-tools.cjs::sha256` now uses `fs.openSync` +
  `fs.readSync` in a fixed `HASH_CHUNK_BYTES=1 MiB` loop with `Buffer.allocUnsafe`,
  never `readFileSync` whole binaries. Deterministic test in `toolchain-hardening.test.cjs`
  compares streaming vs direct hash on a >2 MiB file and asserts source contains
  no `hash.update(fs.readFileSync`.
- **Manifest deduplication (low-risk):** `build-portable-tools.sh` no longer duplicates
  SHA-256 literals. Hashes are resolved at extraction time via `manifest_sha_for`
  (`awk` on `manifest.rows` generated from `portable-toolchain-manifest.json`). Filename
  literals remain explicit to preserve extraction ordering and manual 3rdparty wiring;
  converting the entire plan to a manifest-driven loop would broaden scope and is
  documented as remaining low-risk duplication.
- **Preserved invariants:** No rebuild, no re-download, no `tools/` mutation; candidate
  `build/portable-toolchain/out/tools/{ffmpeg,ffprobe}` unchanged and still
  `candidate-pass-non-release` (see `portable-probe.json` hashes above); `npm run check`
  and candidate verifier continue to pass.
