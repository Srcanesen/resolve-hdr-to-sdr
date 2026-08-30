# Portable macOS FFmpeg/FFprobe + Legal Media Fixtures — Decision Report

**Date (UTC):** 2026-08-29
**Owner:** Research only — no download/install/code edit. One reusable report.
**Scope:** (A) How to ship macOS `ffmpeg`/`ffprobe` with `libplacebo`+`MoltenVK` relocatable on Intel+Apple Silicon without absolute Homebrew `dylibs`; compare universal vs per-arch, static vs bundled `dylib`/`rpath`/`codesign`, pinned provenance. Verify `libplacebo` capability; never recommend binary lacking required filters. (B) Legally redistributable or deterministically generated fixtures for generic HLG, static PQ/HDR10 (MDCV+CLLI), Dolby Vision, HDR10+, `attached_pic`/`audio-first`/`rotation`/`VFR`.
**Host baseline inspected (primary):** `tools/ffmpeg` → `ffmpeg-full 9.0.1_1` arm64 bottle `ffmpeg version 9.0.1 --enable-libplacebo --enable-libzimg` (`tools/PROVENANCE.txt`, `otool -L`, `codesign -dv`, `ffmpeg -hide_banner -h filter=libplacebo`) on 2026-08-29.
**Access dates for web primaries:** 2026-08-29 unless noted. All URLs are official/primary; no HTML dump.

> **Evidence tier:** FACT = locally inspected file/cmd or official primary URL. INFERENCE = interpretation needing live CI verification. COMMUNITY = anecdote (not used for gating).

---

## 0. Recommendation — Minimum Viable Path (what to do first)

### A — Portable tools: self-build **static universal** `ffmpeg`/`ffprobe` with `libplacebo`+Vulkan, single universal fat binary, Developer-ID/Hardened-Runtime-ready, hash-pinned provenance

- **Build from source on GitHub Actions** (not Homebrew bottle, not evermeet/osxexperts). Two arch builds cross-compiled then `lipo`-ed to universal; all non-system deps **statically linked** (`--enable-static --disable-shared --pkg-config-flags=--static`). Only `/usr/lib`+`/System/Library` remain as absolute loads — passes `bundle-audit.cjs: auditDarwinPortability`.
- **Vulkan exception (Apple dynamic boundary):** `vulkan-loader`+`MoltenVK` (`1.4.2` pinned) are the *only* bundled `dylibs`, placed adjacent to binary under `tools/` and referenced via `@rpath`/`@loader_path` relative (or `@executable_path`). Everything else static. `libplacebo` itself is static.
- **One universal artifact** (not per-arch) for GitHub Release: `ffmpeg`+`ffprobe` each `Mach-O universal x86_64 arm64`. Smaller ops surface, single download, audit requires both slices. Per-arch is rejected (see §1c).
- **Provenance:** FFmpeg source `9.0.1` PGP-signed (`ffmpeg-devel@ffmpeg.org` `B4322F04D67658D8`, SHA `cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635` per `ffmpeg-full.rb`), plus pinned SHAs for `libplacebo` HEAD+`shaderc`+`Vulkan-Headers/Loader`+`MoltenVK 1.4.2` (`molten-vk` bottle pins to `1.4.2`) + `x265 4.3` ABI. Publish `SHA256SUMS`+`SHA256SUMS.sig` per Release asset; store under `tools/PROVENANCE.txt` (overwrite symlink with regular files).
- **Codesign:** After any `install_name_tool -add_rpath`/`-change` (sizes grow), re-sign every Mach-O with `codesign --force --options runtime --timestamp -s "Developer ID ..."` (or adhoc for CI-internal). Hardened Runtime required for Notarization (`codesign --verify --deep --strict`). Notarization ticket `stapler staple` for Release DMG/ZIP.

**Why this is the minimum:** Every known public static macOS binary *today* either lacks `libplacebo` (evermeet, osxexperts — verified no `--enable-libplacebo`) or is dynamic Homebrew with 83 absolute `/opt/homebrew` loads (fails audit, arm64-only, adhoc). No trustworthy pinned prebuilt satisfies `libplacebo`+universal+static. Self-build is the only evidence-backed portable path that is hash-pinned, relocatable, and `libplacebo`-capable.

> Concrete CI template: `macos-15` (arm64) runner builds **both** arches via `CFLAGS="-arch arm64 -mmacosx-version-min=11.0"` and `CFLAGS="-arch x86_64 ..."` + `--arch=x86_64` for FFmpeg, or two jobs then `lipo -create arm64/ffmpeg x86_64/ffmpeg -output universal/ffmpeg`. Mirror `z8kh8E6t-rEv62qT7/mpv-macbuild` approach (source static deps, Vulkan excepted, `lipo` universal, artifact upload before runtime audit). Do not use `brew install ffmpeg-full` bottle in Release.

### B — Fixtures: **synthetic `lavfi`+`libx265`+`hevc_metadata` BSF for everything that is semantically valid; `dovi_tool generate`/`inject-rpu` (and `hdr10plus_tool` if needed) for dynamic metadata; never commit proprietary RPU/samples**

- **Commit to repo (MIT):** tiny synthetic matrices for generic HLG, static PQ/HDR10+MDCV+CLLI, plus structural edge cases (`attached_pic`, `audio-first`, `rotation`, `VFR`). All generated deterministically via `tools/ffmpeg` itself — no network, lawful, ~1 s each (~1–3 MiB).
- **Do NOT commit:** real Dolby Vision `RPU.bin`, HDR10+ JSON, or fetched official samples (Dolby/EBU). Generate Dolby Vision fixtures on-demand at test time via `dovi_tool generate` from committed JSON generator configs + injector pipe; treat HDR10+ the same. Cache fetched samples in CI `actions/cache` (gitignored), never in `Sample/`.
- **Licensing consequence:** Only the synthetic generators and generator JSONs are redistributable (MIT). Any `RPU.bin` derived from `dovi_tool generate` is a *derived* binary blob — keep it ephemeral; its source JSON is the redistributable artifact. Official Dolby samples (if ever fetched from `dolby.com`/`professionalsupport.dolby.com`) are **not** redistributable without Dolby license — fetch-at-test-time only.

---

## 1. Part A — Portable FFmpeg/FFprobe on macOS

### 1a. Current local evidence (FACT — inspected 2026-08-29)

| Check | Output | Verdict |
|---|---|---|
| `tools/ffmpeg` symlink | `tools/ffmpeg -> /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` | Not a regular file — fails `tool-doctor.cjs:checkTool` + `bundle-audit.cjs:walkBundleFiles` (symlink banned) |
| `file tools/ffmpeg` | `Mach-O 64-bit executable arm64` (thin) | Missing `x86_64` slice — fails `DARWIN_REQUIRED_ARCHITECTURES ['x86_64','arm64']` (`architectureFailure`) |
| `otool -L tools/ffmpeg` | 83 loads; `/opt/homebrew/Cellar/ffmpeg-full/9.0.1_1/lib/*.dylib`, `/opt/homebrew/opt/libplacebo/lib/libplacebo.360.dylib`, `/opt/homebrew/opt/...` + `/System/Library`, `/usr/lib/libSystem.B.dylib` | Absolute Homebrew loads — fails `isAllowedDarwinDylibDependency` (only `/usr/lib`, `/System/Library`, `@rpath`, `@loader_path`, `@executable_path` allowed) |
| `codesign -dv` | `Signature=adhoc`, `TeamIdentifier=not set`, `flags=0x2(adhoc)` | Ad-hoc, not Developer ID + Hardened Runtime — would fail Gatekeeper/Notarization after distribution |
| `ffmpeg -hide_banner -h filter=libplacebo` | `Filter libplacebo ... tonemapping {auto,clip,st2094-40,st2094-10,bt.2390,bt2446a,spline,reinhard,mobius,hable,gamma,linear} ... gamut_mode {clip,perceptual,...} ... apply_dolbyvision ... peak_detect` | `libplacebo` present + `bt.2390`+`spline` required tokens present — **this host is the only libplacebo-capable path** but not distributable |
| `MoltenVK dep before install` | `VK_ERROR_INCOMPATIBLE_DRIVER` before `molten-vk 1.4.2`, success after (`tools/PROVENANCE.txt:1.4.2`) | Proves `libplacebo` Vulkan path needs `vulkan-loader`+`MoltenVK` on macOS |

**Conclusion:** Existing `tools/` is a **development symlink to a Homebrew keg**, not a relocatable Release artifact. It must be replaced by two *regular files* copied dereferenced into `build/workflow-integration/<id>/tools/{ffmpeg,ffprobe}` (`build-workflow-integration.cjs:copyDereferencedFile` checks `isFile`, `X_OK`, `sha256File` equality).

### 1b. Candidate source verification — who actually has `libplacebo`?

| Source | URL (primary) | `--enable-libplacebo`? | Vulkan/MoltenVK? | Universal `x86_64+arm64`? | Static / relocatable? | Provenance trust | Recommendation |
|---|---|---|---|---|---|---|---|
| **evermeet.cx (Tessus)** | `https://evermeet.cx/ffmpeg/` + `https://evermeet.cx/ffmpeg/info/ffmpeg/snapshot` (config + info API, 2026-08-29) | **No** — config lists `--enable-libzimg` etc. but no `--enable-libplacebo`, verified `configuration: ... --enable-libzimg --enable-libzmq ...` without placebo | No | No (snapshot is Intel era; Apple Silicon separate page historically, not universal fat) | Claims static (`--pkg-config-flags=--static`) but Intel-only, no placebo — **fails libplacebo gate** | Owner-signed `ffmpeg-X.Y.Z.7z.sig` (PGP `tessus` extra-version), no SLSA, single maintainer | **REJECT** — do not recommend. Lacks required filters; cannot be fixed without owner rebuild. |
| **osxexperts.net** | `http://www.osxexperts.net/` + `https://www.osxexperts.net/ffmpeg9arm.zip` (attempt 2026-08-25 `tools/PROVENANCE.txt`) | **No** — `ffmpeg -h filter=libplacebo` reported `unavailable` (`zscale` alone), config lacks `--enable-libplacebo` | No | No (separate `ffmpeg9arm.zip` for arm, Intel `ffmpeg8.0.zip`) | Claims static, but test `d0c06c5...c67af9` zip proved no placebo | No hash published on page; single maintainer, no sig | **REJECT** — same reason, plus weaker provenance. |
| **BtbN / Gyan** | `https://github.com/BtbN/FFmpeg-Builds` (README `win64`/`linux64` only) | N/A (no macOS target) | N/A | No | N/A | Daily auto-build, retention 14 days/2y — not applicable | **REJECT — not a macOS provider.** |
| **`eugeneware/ffmpeg-static` npm** | `https://github.com/eugeneware/ffmpeg-static` + `https://raw.githubusercontent.com/eugeneware/ffmpeg-static/master/README.md` (`download-binaries/index.sh` delegates macOS to evermeet/osxexperts) | **Depends** — macOS arm64delegates to osxexperts (no placebo), Intel to evermeet (no placebo) → **no placebo** | No | No (per-arch `darwin-x64`+`darwin-arm64` separate npm tarballs) | Static per-arch but same upstream deficit | npm `ffmpeg-static@6.1.1` pinned, but transitive deps unpinned single-maintainer zips | **REJECT** — inherits upstream no-placebo, plus npm is not a notarizable Release channel. |
| **Homebrew `ffmpeg-full` bottle** | `https://raw.githubusercontent.com/Homebrew/homebrew-core/master/Formula/f/ffmpeg-full.rb` (2026-08-29) + local `/opt/homebrew` | **Yes** — `depends_on "libplacebo"` + `--enable-libplacebo` + `--enable-libzimg`, plus `molten-vk 1.4.2` separate | Yes via `molten-vk` formula | **No** — bottles are per-arch per-OS: `arm64_tahoe`, `arm64_sequoia`, `arm64_sonoma`, `sonoma` (x86_64) each its own `sha256` | **Dynamic** `--enable-shared` — 83 absolute `/opt/homebrew` loads verified | Bottle SHAs pinned per platform (`4e281c... tahoe`, `84785c... sequoia`, `a12d53f... sonoma`, `628003... sonoma x86_64`) + `url ... sha256 cf38e0e...` source — strong provenance *but* bottle is not relocatable | **REJECT for Release** — keep only for local dev `tools/PROVENANCE.txt` path. Cannot be bundled without `install_name_tool` rewrite (see 1d). |
| **Self-build static universal** | `https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz` (`cf38e0e28c7...`) + `https://code.videolan.org/videolan/libplacebo` + `https://github.com/KhronosGroup/MoltenVK` `1.4.2` | **Yes** — configure with `--enable-libplacebo --enable-libzimg --enable-videotoolbox --enable-audiotoolbox` etc. | Yes — `--enable-vulkan` or MoltenVK-bundled (see `mpv-macbuild` pattern) | **Yes** — via `lipo -create` from two arch builds | **Yes** — `--enable-static --disable-shared --pkg-config-flags=--static`, `otool -L` shows only `/usr/lib`+`/System/Library` (+ single `@rpath` for MoltenVK if exception) | Fully pinned: FFmpeg PGP `B4322F04D67658D8`, libplacebo tag, MoltenVK tag, loader tag; CI artifact SHA + `SHA256SUMS.sig` | **ACCEPT — recommended** |

**Rule enforced:** Any candidate where `ffmpeg -hide_banner -h filter=libplacebo 2>&1 | grep -q "Filter libplacebo"` fails, or where `tonemapping` token set lacks `bt.2390`+`spline`+`perceptual`, must be rejected with reason shown above. evermeet/osxexperts/BtbN-style binaries lacking placebo are **not portable replacements** for this project.

### 1c. Universal single bundle vs per-arch bundles

| Dimension | **Universal fat binary** (recommended) | Per-arch (`darwin-arm64` + `darwin-x64`) |
|---|---|---|
| **Audit** (`bundle-audit.cjs: auditDarwinPortability`) | Requires both slices: `file -b` must match `x86_64`+`arm64`, `lipo -archs` must include both; `architectureFailure` fires if one missing | Each binary is thin one arch — would *fail* current audit which asserts `DARWIN_REQUIRED_ARCHITECTURES`. Need forked allowlist or two audits. |
| **File size** | ~2× single-arch (~180–250 MiB universal `ffmpeg`) | ~90–130 MiB each — half the download if user picks correctly |
| **Distribution on GitHub Release** | One asset `ffmpeg-9.0.1-universal-macos.zip` — users never pick wrong arch | Two assets; user must know `uname -m`; Electron auto-update must branch; double the notarization/stapling |
| **Codesign/Notarization** | One `codesign` invocation per binary, one notarization ticket stapled to fat binary; `codesign --verify --deep --strict` sees both archs | Two signings, two tickets; CI must handle both, error surface doubled |
| **Runtime risk** | Rosetta not invoked; single code path; `DYLD` fallback identical | Intel Macs fetch wrong arm64 asset → `Bad CPU type in executable` (no Rosetta for foreign-→-native speedup loss) |
| **CI build cost** | Two arch builds then `lipo` (extra step) | Same two builds but no `lipo` |
| **Precedent** | `quietvoid/dovi_tool` ships `universal-macOS.zip` (2.3.3); `WayneKoorts/ffmpeg-macos-universal-binary-builder` (`lipo -info output/ffmpeg` shows `x86_64 arm64`); `z8kh8E6t-rEv62qT7/mpv-macbuild` ships `macos-15-arm64` but notes universal packaging path | `eugeneware/ffmpeg-static` per-arch npm — explicitly *not* universal and inherits no-placebo — anti-pattern for single-download Release |

**Verdict:** Universal wins for this project. The Electron Workflow Integration plugin is itself `WorkflowIntegration.node` which `bundle-audit` also asserts `x86_64+arm64`; matching that with universal `ffmpeg`/`ffprobe` keeps one Release DMG/ZIP that passes Gatekeeper on both Intel (legacy) and Apple Silicon without user decision. Only if Release asset size cap (<100 MiB) becomes a hard limit should per-arch be reconsidered — and then the audit must be split intentionally, not silently.

### 1d. Static vs bundled dylibs / `rpath` / `codesign` — what the OS actually enforces

**Primary Apple facts (2026-08-29):**

- **Dynamic loader search:** `otool -L` lists `LC_LOAD_DYLIB` install names. Allowed portable forms inside an app/bundle are only `@rpath/`, `@loader_path/`, `@executable_path/` relative loads plus `/usr/lib`/`/System/Library` system libs. Any absolute `/opt/homebrew` or `/Users/...` load fails relocatable audit and fails on consumer machines without Homebrew. Source: Apple Dynamic Library Usage Guidelines — `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`/`DYLD_FALLBACK_LIBRARY_PATH` search, plus `install_name_tool(1)` `-change old new`, `-rpath old new`, `-add_rpath new`, `-delete_rpath` — requires binary was linked with `-headerpad_max_install_names` to grow install names.
- **Notarization/Hardened Runtime (current Apple policy):** Notary requires: code-sign all Mach-Os, **Developer ID Application/Installer** certificate (not ad-hoc/Apple Development), enable **Hardened Runtime** (`--options runtime`), secure timestamp, link against macOS 10.9+ SDK, no `get-task-allow=true`. After notarization, ticket must be stapled. Ad-hoc `Signature=adhoc` locally is fine for dev but fails notarized distribution. See `https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution` (2026-08-29).
- **Re-signing after `rpath`:** Changing install names/`rpath` invalidates the existing `CodeDirectory`. You must `codesign --force --sign ...` every modified Mach-O *and* the top bundle. `codesign --verify --deep --strict` then checks the `Sealed Resources` tree.

**Three strategies compared:**

| Strategy | How it works | `bundle-audit` | Size | Codesign burden | When it fails | Trust |
|---|---|---|---|---|---|---|
| **(A) Fully static** (recommended) | `./configure --enable-static --disable-shared --pkg-config-flags=--static --extra-ldflags="-headerpad_max_install_names"` + static deps (x265, aom, dav1d, zimg, harfbuzz, etc.). No `*.dylib` shipped beside binary. | `otool -L` shows only `/usr/lib`+`/System/Library` — **PASSES** without `rpath` | Largest single binary (~2× dynamic+deps) | Minimal: sign the two Mach-Os once; no dylib loop | GPL-v3 obligations for static GPL libs (must publish `ffmpeg`+deps source offer + `LICENSES` in Release notes) — not a failure, but compliance work |
| **(B) Bundled dylibs via `@rpath`** | Keep Homebrew-style dynamic `ffmpeg` but `install_name_tool -change /opt/homebrew/opt/libplacebo/lib/libplacebo.360.dylib @rpath/libplacebo.360.dylib` for each of the 83 deps, then copy each `*.dylib` into `tools/lib/` and `install_name_tool -add_rpath @loader_path/lib ffmpeg`. One `rpath` loop per dep. | Would PASS *after* rewrite + shipped libs — but initial audit **FAILS** before rewrite | Binary + ~80 dylibs (~150 MiB total) | Heavy: must re-sign **every** `.dylib` + `ffmpeg`/`ffprobe` after each `install_name_tool`; missing one → `code object is not signed` | `headerpad` insufficient → `install_name_tool` error `larger ...`; `LC_RPATH` count limit; transitive deps have their own absolute deps (recursive closure easily missed → `dyld: Library not loaded: /opt/homebrew/...`) |
| **(C) Hybrid — static + Vulkan exception** (practical minimum) | Static everything *except* `vulkan-loader`+`MoltenVK` (Apple GPU boundary). Those two bundled as `@rpath/libvulkan.1.dylib`+`@rpath/libMoltenVK.dylib`. Mirror `mpv-macbuild`: *"Vulkan is the only non-plugin third-party dynamic runtime exception: vulkan-loader and MoltenVK are source-built, bundled into `mpv.app`, and also copied into the FFmpeg install-prefix artifact."* | PASSES: only `/usr/lib`+`/System/Library`+`@rpath` (+ optional single `@loader_path`) | Static size minus Vulkan pair (~5 MiB) | Light: sign two dylibs + two binaries; same as static plus two | Need `VULKAN_SDK`/`VK_ICD_FILENAMES` pointing to bundled `MoltenVK_icd.json` if loader needs ICD discovery (otherwise `VK_ERROR_INCOMPATIBLE_DRIVER`) |

**Verdict: Choose (A) if you can statical-link Vulkan via `--enable-vulkan-static`; otherwise (C). Never (B) from Homebrew bottle** — the 83-dep closure is fragile, audit-failing-by-default, and not hash-pinned (Homebrew `*.dylib` versions float with `brew upgrade` — x265 ABI `216→217` broke `tools/ffmpeg` already per `PROVENANCE.txt: 2026-08-25`). The project already requires `molten-vk 1.4.2` provenance; keeping just that pair dynamic and everything else static is the least-risk hybrid.

**Minimum `rpath` recipe (if (C)):**

```bash
install_name_tool -add_rpath @loader_path ffmpeg         # binary looks beside itself
install_name_tool -add_rpath @executable_path ffmpeg     # fallback when launched as tool
install_name_tool -change /opt/homebrew/opt/molten-vk/lib/libMoltenVK.dylib @rpath/libMoltenVK.dylib ffmpeg
install_name_tool -id @rpath/libMoltenVK.dylib libMoltenVK.dylib
codesign --force --options runtime --timestamp -s "Developer ID Application: ..." --prefix com.hdrtosdr. ffmpeg libMoltenVK.dylib libvulkan.1.dylib
codesign --verify --deep --strict ffmpeg && otool -L ffmpeg
```

After any `install_name_tool`, always `codesign --force ...` — otherwise `codesign --verify` fails and Gatekeeper rejects.

### 1e. Trustworthy pinned provenance

| Artifact | Pin | How to verify (shell:false) | Why trusted |
|---|---|---|---|
| FFmpeg source | `9.0.1` `ffmpeg-9.0.1.tar.xz` SHA `cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635` (`ffmpeg-full.rb` `sha256`) + PGP sig `B4322F04D67658D8` (`https://ffmpeg.org/ffmpeg-devel.asc`, `https://ffmpeg.org/download.html` Releases) | `gpg --verify ffmpeg-9.0.1.tar.xz.asc` + `shasum -a 256` | Official FFmpeg Releases, signed by `ffmpeg-devel@ffmpeg.org` |
| `libplacebo` | Git tag `v7.351.0` (or HEAD SHA pinned in `mpv-macbuild` with cherry-picks `!850`+`!852` for PQ black-level) — record full SHA in `PROVENANCE.txt` | `git rev-parse HEAD` vs `PROVENANCE.txt` | `code.videolan.org/videolan/libplacebo` primary, plus reproducible CI checkout |
| `shaderc`/`SPIRV-Cross`/`Vulkan-Headers`/`Vulkan-Loader` | SDK tag pinned (e.g., `vulkan-sdk-1.4.313.0`) — same tag for headers+loader+registry | `vulkaninfo --summary` tag match | Khronos official |
| `MoltenVK` | `1.4.2` (`molten-vk` Homebrew bottle pin matches CI) or `KhronosGroup/MoltenVK` tag `v1.4.2` | `otool -L libMoltenVK.dylib` + `plutil -p MoltenVK_icd.json` | Apple Metal translation layer, primary GitHub |
| `x265` | `4.3` (`multicoreware/x265` tag 4.3) — ABI `217` current | `x265 --version` vs `PROVENANCE.txt` | Noted ABI drift `216→217` broke Homebrew |
| Release artifact itself | Per-asset `SHA256SUMS` + `SHA256SUMS.sig` in GitHub Release notes, plus `build/workflow-integration/<id>/tools/{ffmpeg,ffprobe}` entry in `BUNDLE_FILE_ALLOWLIST` with `sha256File` logged by `build-workflow-integration.cjs:copyDereferencedFile` | `shasum -a 256 tools/ffmpeg tools/ffprobe` vs `SHA256SUMS` | Reproducible `tools/PROVENANCE.txt` stored alongside regular files (not symlinks) |

Homebrew *bottle* SHAs (`4e281c... tahoe`, `84785c... sequoia`, `a12d53f... sonoma`, `628003... sonoma x86_64`) are *not* Release provenance — they pin a dynamic bottle, not a relocatable artifact.

### 1f. Exact capability probes — reject alternatives and gate Release

```bash
# 1 — libplacebo gate (must pass)
ffmpeg -hide_banner -h filter=libplacebo 2>&1 | grep -q "Filter libplacebo" \
  && ffmpeg -hide_banner -h filter=libplacebo 2>&1 | grep -q "bt.2390" \
  && ffmpeg -hide_banner -h filter=libplacebo 2>&1 | grep -q "perceptual" \
  && ffmpeg -hide_banner -h filter=libplacebo 2>&1 | grep -q "peak_detect"
# non-zero → REJECT candidate (evermeet/osxexperts fail here)

# 2 — tone path sanity (candidate must still pass for pure HLG/PQ graphs)
ffmpeg -hide_banner -h filter=zscale 2>&1 | grep -q "Filter zscale"
# these are *informational*; only placebo gate is hard

# 3 — universal fat
lipo -archs tools/ffmpeg | grep -q "x86_64" && lipo -archs tools/ffmpeg | grep -q "arm64"
file -b tools/ffmpeg | grep -q "Mach-O.*x86_64.*arm64\|Mach-O.*arm64.*x86_64"  # via parseMachOFileOutput
lipo -info tools/ffmpeg  # expected: Architectures in the fat file: tools/ffmpeg are: x86_64 arm64

# 4 — relocatable (no absolute Homebrew)
otool -L tools/ffmpeg | grep -v "^tools/ffmpeg:" | grep -v "/usr/lib" | grep -v "/System/Library" | grep -v "@rpath" | grep -v "@loader_path" | grep -v "@executable_path"
# must be empty — bundle-audit.cjs:isAllowedDarwinDylibDependency

# 5 — codesign valid after any rpath
codesign --verify --deep --strict --verbose=2 tools/ffmpeg tools/ffprobe
codesign -dv --verbose=4 tools/ffmpeg 2>&1 | grep -E "Identifier|Authority|TeamIdentifier|Signature"
spctl --assess --type execute --verbose=4 tools/ffmpeg  # Gatekeeper assess (needs Developer ID)

# 6 — Vulkan runtime present for libplacebo
ffmpeg -hide_banner -f lavfi -i "color=color=black:size=16x16:rate=30:duration=0.1,format=yuv420p10le,hwupload,libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709" -frames:v 1 -f null - 2>&1
# must not contain VK_ERROR_INCOMPATIBLE_DRIVER / VK_ERROR_INITIALIZATION_FAILED

# 7 — bundle audit (must pass on Release host = darwin)
node scripts/bundle-audit.cjs /absolute/path/to/build/workflow-integration/com.hdrtosdr.app
node scripts/tool-doctor.cjs  # checks tools/ffmpeg+ffprobe are regular executable files, not symlinks

# 8 — provenance hash lock
shasum -a 256 tools/ffmpeg tools/ffprobe | tee SHA256SUMS
# compare to SHA256SUMS in Release notes / tools/PROVENANCE.txt
```

**CI gate order:** `tool-doctor` (no symlink) → `libplacebo` token check (reject evermeet/osxexperts) → `lipo` universal → `otool -L` relocatable → `codesign --verify` → `bundle-audit` → Vulkan smoke.

### 1g. Uncertainties / open risks (A)

- **No prebuilt universal+placebo macOS binary is known today** with hash-pinned provenance. If one appears (e.g., `ffmpeg.org` lists a new macOS static with `--enable-libplacebo`), re-run the 8 probes above and re-evaluate; today evermeet/osxexperts both fail the placebo gate.
- **`--enable-vulkan-static` on macOS:** FFmpeg `./configure` may refuse `--enable-vulkan-static` with MoltenVK (loader is dylib). Then hybrid (C) is forced — two dylibs remain. Verify on `macos-15` runner; `mpv-macbuild` explicitly documents Vulkan as the *only* exception for this reason.
- **`MACOSX_DEPLOYMENT_TARGET`:** Static universal needs min target pinned (e.g., `11.0` Big Sur per `WayneKoorts` builder, `10.9+` for notarization). Mixing targets across deps yields `ld: building for macOS 13 but linking against dylib built for 11`.
- **GPL-3.0 compliance for static Release:** `ffmpeg-full.rb` is `GPL-3.0-or-later` once `--enable-gpl --enable-version3 --enable-libplacebo` etc. are on. Static linking triggers source-offer obligation — add `THIRD_PARTY_LICENSES` + written offer in Release notes. Dynamic (B) would mitigate but was rejected for relocatability.
- **Apple Silicon `x86_64` CI:** `macos-13` Intel runners are sunset; `macos-14/15` are `arm64`. `x86_64` slice must be cross-built on arm64 (`--arch=x86_64`, `CFLAGS=-arch x86_64`, `nasm` etc.) or via `arch -x86_64` Rosetta — not native `lipo` of two native builds. `WayneKoorts` script shows `--arch=arm64 --enable-cross-compile --target-os=darwin` pattern for arm, plain for x86.
- **`libplacebo`+`MoltenVK` HEAD churn:** `mpv-macbuild` cherry-picks libplacebo MR `!850` (PQ black-level) + `!852` (HDR linear scaling). Pin to specific SHAs; otherwise tone mapping behavior drifts between Releases without version bump.

---

## 2. Part B — Legal Media Fixtures

### 2a. What must be covered (Project Scope)

| Category | Signal | Container signal | Probe (shell:false, `ffprobe -show_streams -of json`) |
|---|---|---|---|
| **Generic HLG** | `bt2020`/`arib-std-b67`/`bt2020nc` `tv` 10-bit | `colr nclx 9/18/9`, VUI `colour_primaries 9 / transfer 18 / matrix 9`, `video_full_range_flag 0` (`prototype/inspector.py: is_unspecified`, `ALLOWLIST`) | `color_primaries=bt2020 color_transfer=arib-std-b67 colorspace=bt2020nc color_range=tv pix_fmt=yuv420p10le` + `side_data` without MDCV/DV |
| **Static PQ/HDR10** | `bt2020`/`smpte2084`/`bt2020nc` `tv` 10-bit + `mdcv`+`clli` | Same as HLG but `transfer 16`, plus `side_data Mastering display metadata` (`red_x ... max_luminance`) + `Content light level` (`max_content`/`max_average`) | `color_transfer=smpte2084` + `side_data_list` contains both types |
| **Dolby Vision** | Profile 5/7/8.1/8.4 — `dvvC`/`dvcC` box + RPU NAL 62/63 per-frame | `codec_tag dvhe/dvh1` + `side_data DOVI configuration record` + RPU SEI | `side_data DOVI` + `dovi_tool info --summary RPU.bin` |
| **HDR10+** | PQ base + `hdr10plus` SEI (SMPTE ST 2094-40) per frame | `side_data HDR10+` or `AV_FRAME_DATA_DYNAMIC_HDR_PLUS` | `ffprobe -show_frames side_data` `HDR10+` |
| **Structural** | `attached_pic` (cover art), `audio-first`, `rotation` (`displaymatrix`/`rotate` tag), `VFR` (vsync `vfr` / `avg_frame_rate != r_frame_rate`) | `stream disposition attached_pic`, `streams[1].codec_type audio` first, `side_data Display Matrix`, `r_frame_rate`/`avg_frame_rate` diff | `stream.disposition.attached_pic`, `stream_tags rotate`, `side_data rotation`, `-show_entries stream=avg_frame_rate,r_frame_rate` |

Current local samples `Sample/1.MOV`+`2.MOV` are **private HLG DOVI 8.4** only (`hvc1` + `dvvC` + `RPU`) — unsuitable as committed fixtures (privacy; not redistributable without consent). Treat as ignored via `.gitignore: Sample/**`.

### 2b. Where synthetic `ffmpeg` generation is semantically valid (commit these)

**All synthetic generation is lawful and deterministic** given pinned `ffmpeg 9.0.1`+`libx265 4.3`. Use `lavfi` `testsrc2`/`color`+`setparams`+`format`+`hevc_metadata` BSF to emit correctly-tagged streams, so `ffprobe` sees container+bitstream coherence.

```bash
# HLG 10-bit generic — 1 s, 1280x720, 30 fps, tagged, no RPU
tools/ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=1,format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc" \
  -c:v libx265 -x265-params "level-idc=51:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited" \
  -pix_fmt yuv420p10le -colorspace bt2020nc -color_primaries bt2020 -color_trc arib-std-b67 -color_range tv \
  -bsf:v hevc_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9:video_full_range_flag=0 \
  -movflags +write_colr -n /tmp/hlg-1s.mov
# verify: no MDCV/CLLI, no DOVI, pix_fmt 10-bit
tools/ffprobe -v error -select_streams v:0 -show_entries stream=color_space,color_transfer,color_primaries,color_range,pix_fmt,codec_tag_string:stream_side_data=side_data_type -of json /tmp/hlg-1s.mov

# Static PQ/HDR10 — 1 s, 1000-nit MDCV+CLLI (both required for v1 gate per 2026-08-28 report)
tools/ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=1,format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc" \
  -c:v libx265 -x265-params "level-idc=51:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400" \
  -pix_fmt yuv420p10le -colorspace bt2020nc -color_primaries bt2020 -color_trc smpte2084 -color_range tv \
  -bsf:v hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9:video_full_range_flag=0 \
  -master_display "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)" -max_cll "1000,400" \
  -movflags +write_colr -n /tmp/pq-1s.mov
# verify both side_data present
tools/ffprobe -v error -show_frames -select_streams v:0 -show_entries frame=side_data -of json /tmp/pq-1s.mov | jq '.frames[0].side_data'
tools/ffprobe -v error -show_streams -of json /tmp/pq-1s.mov | jq '.streams[0].side_data_list'

# attached_pic — synthetic SDR with cover art (mjpeg attached)
tools/ffmpeg -f lavfi -i "color=color=red:size=320x240:rate=30:duration=1" -i /tmp/cover.jpg \
  -map 0:v -map 1 -c:v libx264 -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:v:1 mjpeg -disposition:v:1 attached_pic -n /tmp/attached-1s.mkv
tools/ffprobe -v error -show_streams -of json /tmp/attached-1s.mkv | jq '.streams[] | {index,codec_name,disposition}'

# audio-first — mov with audio stream 0, video stream 1
tools/ffmpeg -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000:duration=1" -f lavfi -i "testsrc2=size=640x360:rate=30:duration=1" \
  -map 0:a -map 1:v -c:a aac -c:v libx264 -pix_fmt yuv420p -movflags +faststart -n /tmp/audiofirst-1s.mp4
tools/ffprobe -v error -show_streams -of json /tmp/audiofirst-1s.mp4 | jq '.streams[] | {index,codec_type}'

# rotation — 90° display matrix (ffmpeg -noautorotate must be tested)
tools/ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=30:duration=1" -c:v libx264 -pix_fmt yuv420p \
  -metadata:s:v:0 rotate=90 -movflags +faststart -n /tmp/rot90-1s.mp4
tools/ffprobe -v error -show_streams -of json /tmp/rot90-1s.mp4 | jq '.streams[0].tags.rotate'
tools/ffprobe -v error -show_frames -of json /tmp/rot90-1s.mp4 | jq '.frames[0].side_data[] | select(.side_data_type=="Display Matrix")'

# VFR — variable frame rate (vsync vfr + -re + timestamp jitter via setpts)
tools/ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=30:duration=3" -vf "setpts=N/FRAME_RATE/TB+random(1)*0.02" -vsync vfr -c:v libx264 -pix_fmt yuv420p -n /tmp/vfr-1s.mp4
tools/ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate,r_frame_rate,time_base,codec_name -of default=noprint_wrappers=1 /tmp/vfr-1s.mp4
tools/ffprobe -v error -show_entries packet=pts_time,duration_time -of csv /tmp/vfr-1s.mp4 | head
```

**Why these are sufficient:** HLG and PQ are defined purely by container `colr`/VUI plus `mdcv`/`clli` side data — no per-frame dynamic metadata — so `lavfi`+`x265`+`hevc_metadata` BSF is *semantically faithful*. Structural cases are container-level dispositions/tags that `ffmpeg` emits deterministically. All resulting files are MIT-committable (generated bytes, no third-party picture).

**Negative fixtures (must FAIL the narrow gates — prove gates):**

- `pq-no-mdcv-1s.mov` — `smpte2084` without `-master_display`/`-max_cll` → `has_mdcv==false||has_clli==false` → `pqHdr10Unsupported`/`uncertain` (not `pqSupported`).
- `pq-contradictory-1s.mov` — `smpte2084` + `bt709` primaries → `is_contradictory==true` → `uncertain` `canConvert=false`.
- `sdr-control-1s.mov` — `bt709` SDR → `uncertain`.

### 2c. Where synthetic is NOT valid — dynamic metadata requires `dovi_tool`/`hdr10plus_tool` or official samples

| Need | Why `lavfi` alone is insufficient | What is required (legal) | Redistributable? |
|---|---|---|---|
| **Dolby Vision RPU** (Profile 5/7/8.x, CMv2.9/CMv4.0 `L1`/`L2`/`L3`/`L5`/`L6`/`L8`) | RPU is a proprietary Dolby Vision enhancement-layer NAL (unspec 62/63, `dvcC`/`dvvC` box + per-frame SEI). `ffmpeg` can *preserve* RPU via `-c:v copy` but cannot *generate* valid RPU without Dolby authoring. `libplacebo apply_dolbyvision=true` can *consume* RPU, not author it. | `dovi_tool generate --xml metadata.xml` (CMv2.9/CMv4.0 XML from Dolby CMU) or `dovi_tool generate -j generator.json [--hdr10plus-json ...]` or `--madvr-file`, then `dovi_tool inject-rpu -i BL.hevc --rpu-in RPU.bin -o DV.hevc` piped from `ffmpeg -bsf:v hevc_mp4toannexb`. See `quietvoid/dovi_tool` README (`generate`/`inject-rpu`/`extract-rpu`/`convert` modes 0–4) | **Source JSON/XML (MIT or user-created) is commitable.** Generated `RPU.bin` is derivative — keep ephemeral in `/tmp`/`__pycache__`, not in git. `dovi_tool` itself is MIT (`1.88.0+` Rust toolchain, latest `2.3.3` universal-macOS with SHA per Release). Dolby spec `Profiles & Levels v1.3.2` + `ETSI TS 103 572` + `SMPTE ST 2094-10` are proprietary — do not vend spec PDFs. |
| **HDR10+ (ST 2094-40)** | Dynamic `hdr10plus` SEI is JSON-driven scene metadata (maxscl/average/max). `ffmpeg` `libx265` can *write* it with `-dhdr10-info hdr10plus.json` (via `x265` HDR10+ API) but the JSON must be authored/measured. | `hdr10plus_tool` (from `quietvoid/hdr10plus_tool` sibling) or `dovi_tool generate --hdr10plus-json` to derive L1 from HDR10+; inject via `x265-params dhdr10-info=...` or `hdr10plus_tool inject`. | JSON scene metadata is commitable if synthetic (e.g., single scene `MaxSCL`+`Average`); derived HEVC is ephemeral. Spec `ST 2094-40` proprietary. |
| **Official Dolby HDR10 test vectors** | `dolbylaboratories/dlb_mp4base` muxer samples, Dolby professional support files (`professionalsupport.dolby.com` "Best Practices Create Dolby Vision Profile 8.4 using DaVinci Resolve" 2026-01-08) — copyrighted Dolby | Fetch at CI `curl -L https://...` into cache, verify SHA, never commit. Use only as *read-only* input to `dovi_tool info`/`ffprobe` oracle. | **Not redistributable** without Dolby redistribution license. Treat as `Output/`-ignored fetch. |
| **EBU/ST 2086/P3 mastering vectors** | `tests/data` style YUV with known primaries — often CC-BY but check per-file | Link to source (e.g., `https://tech.ebu.ch/testsequences`), do not mirror. Synthetic `lavfi` is preferred. | Usually non-commercial; prefer synthetic. |

**Minimal `dovi_tool` fixture recipe (commit JSON, generate RPU ephemerally):**

```bash
# 1 — committed generator JSON (assets/generator_examples/default_cmv40.json style)
cat tests/fixtures/dovi/p8_4_hlg_generator.json
# {"cm_version":"V40","profile":8,"dm_version":2,"rpu_generation":{...}}

# 2 — generate RPU (CI ephemeral)
dovi_tool generate -j tests/fixtures/dovi/p8_4_hlg_generator.json -o /tmp/RPU.bin
dovi_tool info -i /tmp/RPU.bin --summary  # verify L1/L5 present, bl_video_full_range_flag

# 3 — inject into synthetic PQ/HLG BL to produce DV test vector
tools/ffmpeg -i /tmp/pq-1s.mov -c:v copy -bsf:v hevc_mp4toannexb -f hevc - | \
  dovi_tool inject-rpu -i - --rpu-in /tmp/RPU.bin -o /tmp/dv-p84-1s.hevc
tools/ffmpeg -i /tmp/dv-p84-1s.hevc -c:v copy -c:a copy -movflags +write_colr /tmp/dv-p84-1s.mov
tools/ffprobe -v error -show_streams -of json /tmp/dv-p84-1s.mov | jq '.streams[0].side_data'
dovi_tool info -i /tmp/RPU.bin -s  # expected summary

# 4 — also test extraction path (what product does on real iPhone files)
tools/ffmpeg -i /tmp/dv-p84-1s.mov -c:v copy -bsf:v hevc_mp4toannexb -f hevc - | \
  dovi_tool extract-rpu -o /tmp/extracted-RPU.bin --summary -
```

If `RPU.bin` is random synthetic without proper `L1`/`L6` (`max_pq` etc.), `libplacebo apply_dolbyvision` will still run but `tonemapping` will use wrong `max_luminance` → not a valid product test. Pin `L1` to known `1000/400` nit grade in JSON.

**HDR10+ recipe (if added):**

```bash
quietvoid/hdr10plus_tool extract /tmp/pq-1s.hevc -o /tmp/hdr10plus.json
quietvoid/hdr10plus_tool inject /tmp/pq-1s.hevc --json /tmp/hdr10plus.json -o /tmp/pq-plus-1s.hevc
```

`hdr10plus_tool` is MIT, releases mirror `dovi_tool` pattern — pin version SHA likewise.

### 2d. Licensing matrix — what can be committed vs fetched

| Fixture source | License | Commit to `tests/fixtures/`? | Notes |
|---|---|---|---|
| Synthetic HLG/PQ `lavfi` 1-s clips | **MIT** (you generated) | **Yes** — ≤5 MiB each, deterministic | Document `ffmpeg -version` + `x265 --version` + command in `README.md`+`PROVENANCE.txt` beside fixture |
| `dovi_tool` generator JSON (CMv2.9/CMv4.0 config) | **MIT** | **Yes** | `dovi_tool docs/generator.md` schema; example `assets/generator_examples/default_cmv40.json` is MIT |
| Generated `RPU.bin` / injected `DV.hevc` | Derived binary | **No** — ephemeral `/tmp` | Keep source JSON as truth, hash the ephemeral in CI log |
| `quietvoid/dovi_tool` binary itself | **MIT** | No (tool, not fixture) | Pin universal-macOS `2.3.3` `SHA` per `releases/download/2.3.3/dovi_tool-2.3.3-universal-macOS.zip.sha256` |
| Dolby official samples (`dolby.com`, `professionalsupport.dolby.com`, `developer.dolby.com`) | **Proprietary — no redistribution without license** | **No** — fetch at test time, cached gitignored | Must accept Dolby EULA on download page; many samples are `© Dolby` |
| EBU/SVT/Netflix `vmaf` samples | Mixed CC-BY / research-only | **No** — link only | Check per-file `LICENSE`; prefer synthetic |
| Apple's HLS HDR reference (`developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf` example `.mov`) | **Apple Sample Code License** | **No** | Fetch-only, note license in `PROVENANCE.txt` |

### 2e. Recommended fixture matrix (minimum commit)

**Commit (git, MIT):**

1. `hlg-1s.mov` — `bt2020/arib-std-b67/bt2020nc tv yuv420p10le hvc1` 1280×720 30p 1 s (synthetic HLG)
2. `pq-1k-1s.mov` — `bt2020/smpte2084/bt2020nc tv yuv420p10le hvc1` + `mdcv` 1000 nit + `clli` 1000/400 (canonical HDR10)
3. `pq-4k-1s.mov` — same but 4000-nit `mdcv` (exercises knee strongly)
4. `pq-no-mdcv-1s.mov` — `smpte2084` **without** `mdcv`/`clli` (negative gate)
5. `sdr-control-1s.mov` — `bt709/bt709/bt709 tv yuv420p` H.264 (SDR control)
6. `attached-1s.mkv` — one `attached_pic` stream
7. `audiofirst-1s.mp4` — audio stream first
8. `rot90-1s.mp4` — `rotate=90`
9. `vfr-1s.mp4` — `vsync vfr` with pts jitter
10. `dovi-p84-generator.json` — `profile 8.4` CMv2.9 `L1`+`L5` generator config (source for `RPU.bin`)

**Ephemeral (CI-generated, not committed):**

- `/tmp/dv-p84-1s.mov` from `dovi_tool generate+inject-rpu` of `dovi-p84-generator.json`
- `/tmp/pq-plus-1s.hevc` from `hdr10plus_tool` if HDR10+ added (optional)

Total committed size <30 MiB; generation is offline, no network in `verify-spike.sh`.

### 2f. Verification probes (fixtures — copy-paste)

```bash
# HLG gate — must be hlgSupported, not uncertain
tools/ffprobe -v error -select_streams v:0 -show_entries stream=color_space,color_transfer,color_primaries,color_range,pix_fmt,codec_tag_string:stream_side_data=side_data_type -of json /tmp/hlg-1s.mov | jq .

# PQ gate — both MDCV+CLLI present
tools/ffprobe -v error -show_streams -of json /tmp/pq-1k-1s.mov | jq '.streams[0].side_data_list[] | .side_data_type'
tools/ffprobe -v error -show_frames -of json /tmp/pq-1k-1s.mov | jq '.frames[0].side_data[] | {type: .side_data_type, red_x, max_luminance, max_content}'

# DV — RPU present after inject
tools/ffprobe -v error -show_streams -of json /tmp/dv-p84-1s.mov | jq '.streams[0] | {codec_tag_string, side_data_list}'
dovi_tool info -i /tmp/RPU.bin -s  # must show profile 8.4, CMv2.9, rpu_present
tools/ffmpeg -i /tmp/dv-p84-1s.mov -c:v copy -bsf:v hevc_mp4toannexb -f hevc - | dovi_tool info -i - --summary -

# HDR10+ (if present)
tools/ffprobe -v error -show_frames -of json /tmp/pq-plus-1s.hevc | jq '.frames[0].side_data[] | select(.side_data_type=="HDR10+ Metadata")'

# structural
tools/ffprobe -v error -show_streams -of json /tmp/attached-1s.mkv | jq '.streams[] | select(.disposition.attached_pic==1)'
tools/ffprobe -v error -show_streams -of json /tmp/audiofirst-1s.mp4 | jq '.streams[0].codec_type'  # must be audio
tools/ffprobe -v error -show_entries stream_tags=rotate -of json /tmp/rot90-1s.mp4
tools/ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate,r_frame_rate -of json /tmp/vfr-1s.mp4
mediainfo --Inform="Video;%Format% %BitDepth% %HDR_Format/String% %colour_primaries% %transfer_characteristics% %matrix_coefficients%" /tmp/pq-1k-1s.mov
```

Mechanical gate expectation: `hlg-1s.mov` → `hlgSupported` (`hlg-rec709-v1`); `pq-1k-1s.mov`+`pq-4k-1s.mov` → `pqSupported` (`pq-rec709-v1` per `2026-08-28` narrow gate); `pq-no-mdcv`+`sdr-control` → `uncertain`/`pqHdr10Unsupported` `canConvert=false`; `dv-p84` → `dolbyVisionUnsupported` in v1 (RPU allowlist rejects) — that rejection *is* the valid test.

### 2g. Uncertainties / open risks (B)

- **Dolby Vision IP:** `dovi_tool generate` synthesizes **valid-structured** but **not Dolby-certified** RPU. It is sufficient for testing `extract-rpu`/`info`/`apply_dolbyvision` paths, but not proof of Dolby Vision mastering correctness. Official Dolby Vision authored RPU (from Dolby CMU `xml`) is the gold reference — not redistributable.
- **HDR10+ royalty-free ≠ spec-open:** `ST 2094-40` still requires implementer to handle `MaxSCL` histogram vs `max_content` divergence; synthetic `hdr10plus.json` with single scene may under-exercise `scene_refresh_flag` logic that `dovi_tool export -d scenes` tests.
- **`attached_pic`/`rotation`/`VFR` edge on iPhone:** iPhone never emits `attached_pic`; `rotation` is via `displaymatrix` (not `rotate` tag) on some iOS versions — both forms should be probed (`side_data Display Matrix` + `tags.rotate`). VFR on iPhone is limited (`29.47 avg vs 30 r`) — synthetic jitter should match that range.
- **ffprobe MDCV exposure variance:** Local `9.0.1` exposes MDCV/CLLI on first decoded `frame side_data` even when `stream side_data_list` is absent — inspector must probe `-read_intervals %+#1 -show_frames` plus `-show_streams` to catch both (per `pq-hdr10-rec709-implementation-2026-08-28.md §2`).
- **Size vs fidelity:** 1-s `testsrc2` is not perceptual — it exercises *metadata* and *pipeline* correctness, not *tone-map visual* correctness. Human visual A/B still needs 4-s ProRes LT `yuv422p10le` per `adobe-tonemap-match` harness; that is diagnostic, not fixture.

### 2h. Implemented opt-in harness and local result

`scripts/media-integration.cjs` implements the bounded harness described by this
fixture plan; `npm run test:media:integration` is intentionally absent from
`npm run check`. It generates generic HLG and static PQ/HDR10 with x265
`master-display`/`max-cll` (MDCV/CLLI), then uses the real inspector,
`b-executor`, and verifier. Its structural MP4 recipe maps cover image, audio,
and main HEVC with `0:V:0`; it accepts the deterministic MP4 order emitted by
current FFmpeg (`audio, real-video, attached-video`) as the closest equivalent
to attached-picture/audio/main ordering. It records selected-stream frame
evidence, presentation dimensions, and audio preservation. Rotation and VFR
are read back; current FFmpeg/MP4 rotation loss is reported as
`rotation_metadata_not_preserved_by_ffmpeg_mp4`, never as a pass. VFR is passed
only when `avg_frame_rate` differs from `r_frame_rate` after readback. All files
are private temp files and are removed in `finally`; the JSON has no paths or
probe text.

Actual local run (2026-08-29): **BLOCKED** before fixture creation with exit
status `2`. The repository's `tools/ffmpeg` target is a symlink (and
`tools/ffprobe` is also a symlink), so the first sanitized reason was
`ffmpeg_not_regular`; all five required scenarios were `tool_unavailable`, both
Dolby Vision/HDR10+ scenarios were `not_run`/`tool_unavailable`, and cleanup
residue was `0`. No tools or samples were downloaded and no `Sample/` or
`Output/` file was created. This is a deterministic provisioning blocker; a
regular executable repo-local tool pair is required before the live HLG/PQ
PASS can be claimed.

---

## 3. Sources — Official URLs & Access Dates

1. **FFmpeg Download (official)** — `https://ffmpeg.org/download.html` — 2026-08-29 — FACT: *"FFmpeg only provides source code. Below are some links that provide it already compiled..."*; Releases `9.0.1` `9.0.1.tar.xz` + PGP `ffmpeg-devel.asc` `B4322F04D67658D8`.
2. **FFmpeg Source verification** — `https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz` + `.asc` + `https://ffmpeg.org/ffmpeg-devel.asc` — 2026-08-29.
3. **evermeet.cx (Tessus) FFmpeg static for macOS** — `https://evermeet.cx/ffmpeg/` + `https://evermeet.cx/ffmpeg/info/ffmpeg/snapshot` + `https://evermeet.cx/ffmpeg/ffmpeg-126221-g96d82d90c3f.7z.sig` — 2026-08-29 — FACT: configuration without `--enable-libplacebo`, Intel-era snapshot.
4. **osxexperts.net** — `http://www.osxexperts.net/` (build script dated `2026-08-09 16:36 UTC`) — 2026-08-29 — FACT: script builds static without `libplacebo`; local test `ffmpeg9arm.zip` lacks `libplacebo` (`tools/PROVENANCE.txt: d0c06c5...`).
5. **BtbN FFmpeg-Builds** — `https://github.com/BtbN/FFmpeg-Builds` README (`win64`/`linux64` only, no macOS) — 2026-08-29.
6. **eugeneware/ffmpeg-static** — `https://github.com/eugeneware/ffmpeg-static` + `https://raw.githubusercontent.com/eugeneware/ffmpeg-static/master/README.md` (`download-binaries/index.sh` delegates macOS to evermeet/osxexperts) — 2026-08-29.
7. **Homebrew `ffmpeg-full` formula** — `https://raw.githubusercontent.com/Homebrew/homebrew-core/master/Formula/f/ffmpeg-full.rb` (`sha256 cf38e0e...`, `depends_on "libplacebo"` + `--enable-libplacebo`, `bottle sha256 arm64_tahoe 4e281c...` etc.) — 2026-08-29.
8. **Apple Notarizing macOS Software** — `https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution` — 2026-08-29 — FACT: Developer ID + Hardened Runtime + timestamp + 10.9+ SDK required.
9. **Apple Hardened Runtime** — `https://developer.apple.com/documentation/security/hardened-runtime` — 2026-08-29.
10. **Apple Dynamic Library Programming Topics — Run-Path Dependent Libraries** — `https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/DynamicLibraries/100-Articles/RunpathDependentLibraries.html` + `https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/DynamicLibraries/100-Articles/DynamicLibraryUsageGuidelines.html` — 2026-08-29.
11. **`install_name_tool(1)`** — `https://www.unix.com/man-page/osx/1/install_name_tool/` — 2026-08-29 — FACT: `-change`, `-rpath`, `-add_rpath`, `-id`, requires `-headerpad_max_install_names`.
12. **FFmpeg `libplacebo` filter docs** — `https://ffmpeg.org/ffmpeg-filters.html#libplacebo` (§11.147, 11.147.1.6 peak detection, 11.147.1.7 tone mapping `bt.2390`/`spline`) — 2026-08-29.
13. **libplacebo Options** — `https://libplacebo.org/options/` — 2026-08-29 — FACT: `preset`, `gamut_mode {clip,perceptual,relative,saturation,absolute,desaturate,darken,warn,linear}`, per-opt presets.
14. **quietvoid/dovi_tool** — `https://github.com/quietvoid/dovi_tool` + `https://raw.githubusercontent.com/quietvoid/dovi_tool/master/README.md` (`generate`/`inject-rpu`/`extract-rpu`/`convert` modes 0–4, `info --summary`) + `https://github.com/quietvoid/dovi_tool/releases` (`2.3.3` `universal-macOS.zip`+`.sha256`, `1.88.0` MSRV) — 2026-08-29.
15. **ITU-R BT.2100-3** — `https://www.itu.int/rec/R-REC-BT.2100` (`BT.2100-3 02/2025` in force; `HDR` `HLG`/`PQ`) — 2026-08-29.
16. **Local primary:** `tools/PROVENANCE.txt` (2026-08-25 provenance, `ffmpeg-full 9.0.1_1` + `molten-vk 1.4.2`, `VK_ERROR_INCOMPATIBLE_DRIVER` evidence) — inspected 2026-08-29.
17. **Local primary:** `scripts/bundle-audit.cjs` (`BUNDLE_FILE_ALLOWLIST`, `DARWIN_RUNTIME_BINARIES`, `DARWIN_REQUIRED_ARCHITECTURES ['x86_64','arm64']`, `isAllowedDarwinDylibDependency`, `auditDarwinPortability`) — inspected 2026-08-29.
18. **Local primary:** `scripts/bundle-audit.cjs` + `build-workflow-integration.cjs:copyDereferencedFile` + `tool-doctor.cjs` (symlink ban, `sha256File`, `shell:false`) — 2026-08-29.
19. **Local primary:** `docs/research/pq-hdr10-rec709-implementation-2026-08-28.md` (MDCV/CLLI `ffprobe side_data`, `BT.2390` EETF, narrow `pqSupported` gate) — 2026-08-29.

---

## 4. Conflicts / Uncertainty

- **Shipped binary provenance vs convenience:** Homebrew bottle has strongest hash provenance *but* fails relocatability. evermeet/osxexperts claim static but fail `libplacebo` capability — no amount of re-signing fixes a missing filter. Only self-build satisfies both.
- **Static GPL vs redistribution:** Fully static triggers GPL-3.0 source offer. Bundled-dylib hybrid eases GPL (LGPL deps remain dynamic) but was rejected for reliability. Owner must accept GPL disclosure if choosing static.
- **MoltenVK as dylib exception:** Apple's Vulkan-on-Metal *requires* `MoltenVK` dylib + ICD JSON. Pure static may be impossible; the two-dylib hybrid is the documented compromise (`mpv-macbuild`). Still needs `@rpath` + re-sign.
- **Fixture visual fidelity vs metadata fidelity:** Synthetic `testsrc2` proves *metadata* handling, not *perceptual* tone-map quality. Do not claim visual correctness from fixture pass; that needs `compare-to-reference.sh` + `signalstats YAVG` A/B on real HLG.
- **`libplacebo` default `peak_detect=true` vs deterministic `false`:** Default is perceptually smoother but non-bit-exact (scene-adaptive). CI hashing should pin `peak_detect` explicitly per profile or accept non-deterministic output hash.
- **Dolby licensing ambiguity:** `dovi_tool` MIT does not grant Dolby IP; distributing any file containing Dolby-authored RPU (even synthetic via `generate` with Dolby-like L1) may still be seen as Dolby-derived. Safer to commit only generator JSON.

---

## 5. Implication for the task — Next concrete steps

1. **CI build job** (`build-ffmpeg-universal-macos.yml`): checkout `ffmpeg 9.0.1`+`libplacebo`+`shaderc`+`vulkan`+`MoltenVK 1.4.2`, build x86_64+arm64, `lipo -create`, publish `ffmpeg`+`ffprobe` as regular files under `tools/` (no symlinks), write `tools/PROVENANCE.txt` with all SHAs+PGP. Gate with the 8 probes in §1f; fail job if any `otool -L` absolute remains.
2. **Re-sign + audit gate:** After `install_name_tool -add_rpath` (if hybrid), `codesign --force --options runtime --timestamp` every Mach-O, then `node scripts/bundle-audit.cjs <build-root>` + `node scripts/tool-doctor.cjs` must pass before Release publish.
3. **Fixture PR (no binary blobs):** Add `tests/fixtures/{hlg-1s.mov,pq-1k-1s.mov,pq-4k-1s.mov,pq-no-mdcv-1s.mov,sdr-control-1s.mov,attached-1s.mkv,audiofirst-1s.mp4,rot90-1s.mp4,vfr-1s.mp4,dovi-p84-generator.json}` via synthetic commands in §2b+`verify-spike.sh` derivation. Keep `Sample/**` gitignored; never commit `/tmp/RPU.bin`.
4. **Ephemeral DV path test:** In `python -m unittest` or `verify-spike.sh`, generate `/tmp/RPU.bin` from `dovi-p84-generator.json` via `dovi_tool generate`, inject, then probe `ffprobe`+`dovi_tool info --summary` — ephemeral only.
5. **Release notes:** Include `SHA256SUMS`+`SHA256SUMS.sig`, `THIRD_PARTY_LICENSES`, and `PROVENANCE.txt` verbatim; note `HLG→SDR` profile is `bt.2390 perceptual` and `PQ→SDR` is `bt.2390 perceptual` with `peak_detect` default — no visual claim.

---

## 6. Risks / Unknowns (only concrete)

- `evermeet.cx`/**osxexperts.net** single-maintainer shutdown risk — already seen as reason `eugeneware/ffmpeg-static` may disappear. Not a blocker because they are rejected.
- `MoltenVK` ICD discovery via `VK_ICD_FILENAMES`/`Vulkan` `layer` JSON — bundled loader may need `export VK_ICD_FILENAMES=@loader_path/MoltenVK_icd.json` or `vulkan-loader` will `VK_ERROR_INCOMPATIBLE_DRIVER` at runtime even though `otool` looks fine. Test with the Vulkan smoke in §1f.
- `x265` ABI bump `216→217` already broke Homebrew `tools/ffmpeg` once (`PROVENANCE.txt`). Pinned static build avoids, but CI cache must key on `x265` SHA.
- `WayneKoorts` universal builder pins `MACOSX_DEPLOYMENT_TARGET=11.0` — if `libplacebo` requires 12.0+ Metal features, universal fat will fail Vulkan init on 11. Link-test required.
- `dovi_tool` `2.3.3` universal-macOS SHA differs per re-release; always fetch `*.sha256` alongside ZIP and verify — do not hardcode ZIP SHA without its `.sha256` companion.
- `ffprobe` `side_data` nesting changed between FFmpeg `8.1` (`side_data`) vs `9.0` (`side_data_list`+`side_data`): inspector must check both paths (`pq-hdr10-rec709-implementation-2026-08-28.md §2`) or PQ gate false-negatives.

---

## 7. Start Here

**File to touch first:** `scripts/build-workflow-integration.cjs` (`copyDereferencedFile` + `auditBundle` call site) and a new `scripts/build-ffmpeg-universal-macos.sh` (the pinned static+`lipo`+`codesign` recipe). Prove the 8 probes pass on `build/workflow-integration/com.hdrtosdr.app` *before* any `verify-spike.sh` or fixture work — if `bundle-audit` still reports `has a non-system absolute dylib dependency` or `must contain x86_64 and arm64`, no fixture work is portable.

---

*Handoff reminder: read-only researcher, no downloads/installs. All web facts cite primary/official URLs above; local facts cite `file:line` paths. High-impact conclusion (ship universal static) requires main-agent verification via the 8 `codesign`/`otool`/`lipo` probes before GitHub Release publish.*
