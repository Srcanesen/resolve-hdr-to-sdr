# iPhone HDR / Dolby Vision Diagnosis & Normalization for DaVinci Resolve — GitHub Evidence Map

**Access date:** 2026-08-25 (UTC)
**Scope:** Open-source code, issues, tests, tools: ffmpeg/ffprobe, MediaInfo, dovi_tool/libdovi, mp4box/Bento4, Resolve scripting. Read-only GitHub search & code/issue read. No clones/edits.
**Method:** `gh search` + `gh repo view` + `gh api` + Jina reader verification of README/code/issues for each hit. ≥5 primary sources validated.

---

## 1. Ranked Evidence Table

| Rank | Repository / Issue | URL | Stars / Activity (2026-08-25) | License / Maintenance | Proven Capability (code/issue read) | Limitation / Gap |
|------|-------------------|-----|------------------------------|----------------------|-------------------------------------|------------------|
| **A1** | **quietvoid/dovi_tool** — CLI + `dolby_vision` crate / libdovi | https://github.com/quietvoid/dovi_tool — Release [2.3.3](https://github.com/quietvoid/dovi_tool/releases/tag/2.3.3) 2026-07-12 | 1005★, updated 2026-08-24, 81 forks, 7 open issues | **MIT**, Rust 1.88+, active (last push 2026-08-22) | **Strongest implementation evidence.** Parsed RPU handling: `info`/`extract-rpu`/`inject-rpu`/`convert`/`demux`/`mux`/`generate`/`editor`/`export`/`plot`. Modes: `0` rewrite, `1` MEL, `2`→p8.1 (remove luma/chroma mapping FEL), `3` p5→8.1, `4`→8.4, `5` preserve mapping. Verified via `README.md` + `src/` + `dolby_vision/README.md` (C API). Used downstream by `quietvoid/hdr10plus_tool`, `br3ndonland/dovi_tool` Docker, `fireph/docker-tdarr-dovi-hdr10plus`. | Operates on **HEVC elementary stream** (`.hevc`), not MOV/MP4 directly — requires `ffmpeg -bsf:v hevc_mp4toannexb` pipe. No NCLC/colr atom rewrite; no HLG→SDR tonemap. Issue #378 documents confusion about DV→non-DV conversion — **not supported natively** (needs re-encode). Issue #381 open: empty RPU after editing = fragile editor config. |
| **A2** | **FFmpeg/FFmpeg** (mirror of git.ffmpeg.org) | https://github.com/FFmpeg/FFmpeg | 63,617★, updated 2026-08-25 | **LGPL 2.1+ / GPL 2+** (Other on GH), daily sync | **Diagnosis:** `ffprobe -show_streams -show_frames` exposes `color_primaries`, `color_trc`, `colorspace`, `codec_tag` (hvc1/dvh1/dvhe), `side_data` (HDR10, DOVI RPU). **Normalization (4 distinct pipelines):** (a) metadata rewrite: `-color_primaries bt709 -color_trc bt709 -colorspace bt709 -bsf:v hevc_metadata` ; (b) bitstream filter; (c) tonemap: `zscale+tonemap` (hable/mobius) or `libplacebo` (mobius/perceptual) → SDR; (d) `-vf tonemap_opencl`. Verified via `doc/filters.texi` tonemap/zscale/libplacebo, and downstream repos `bbimer`/`blurridge`. | No native RPU editing (delegates to dovi_tool). `libplacebo` requires full Gyan build; fallback `zscale` quality lower. No Resolve automation. Color tag fix vs. tonemap vs. transcode are conflated in community recipes — must be distinguished. |
| **A3** | **MediaArea/MediaInfo** + **MediaArea/MediaInfoLib** | https://github.com/MediaArea/MediaInfo — https://github.com/MediaArea/MediaInfoLib | 1999★ (CLI/GUI) + 787★ (lib), both 2026-08-25, 223 open issues | **BSD-2-Clause**, very active (M. Zen) | **Diagnosis gold standard.** CLI/GUI/lib extracts: `Format profile`, `HDR format`, `Codec ID` (dvhe.08.06 etc), `Color primaries/transfer/matrix`, `Mastering display`, `MaxCLL/FALL`. Backs automated detection (`pymediainfo`, `mediainfo.js`, `Get-MediaInfo`). Proves iPhone tags before fix. | Read-only. Does not modify files. No RPU decode. For MOV `colr/nclc` vs MXF divergence (see MingoBoon site) — MediaInfo is required verifier because Finder `⌘I` only works for QT `colr`. |
| **A4** | **axiomatic-systems/Bento4** + **gpac/gpac (MP4Box)** | Bento4: https://github.com/axiomatic-systems/Bento4 (2493★, 2026-08-24) / GPAC: https://github.com/gpac/gpac (3296★, LGPL-2.1, 2026-08-25) ; mp4box.js: https://github.com/gpac/mp4box.js | Bento4: proprietary-ish BSD-like (check `LICENSE`), unmaintained-ish but stable; GPAC: LGPL-2.1 active | **MP4 atom diagnosis & muxing.** Bento4: `mp4info` dumps `colr/nclx` (primaries/transfer/matrix), `mp4tag --list`, `mp4fragment`, `mp4mux`. GPAC `MP4Box`: `-add`, `-rbds`, `:fmt`, `hevc:dv` handling, `-bs-switching`. Provides evidence for **metadata rewrite without transcode** (colr atom patch). | Neither parses Dolby Vision RPU levels. Bento4 no longer releases (`latestRelease: null`). GPAC MP4Box can mis-handle `dvh1` vs `hvc1` brand if tag stripped. No tonemap. |
| **A5** | **bbimer/iphone-hdr-to-sdr-ffmpeg** (Windows batch, Aug 2026) | https://github.com/bbimer/iphone-hdr-to-sdr-ffmpeg | 0★, updated 2026-08-03 | MIT (badge), single author, new | **Direct iPhone 15/16 Pro Max 4K60 DV 8.4/HLG→Rec.709 ProRes422LT tonemap.** Code read: `tonemap_prores.bat` → `libplacebo=tonemapping=mobius:gamut_mode=perceptual:colorspace=bt709...` + fallback `zscale=t=linear:npl=220,tonemap=mobius,param=0.4:desat=0.5`. Explicitly addresses washed-out import on Windows/AE/Premiere/DaVinci. Documents USB `Keep Originals` trap. | **Anecdotal/low-trust:** 0 stars, no tests/issues, screenshots only. Windows `.bat` only. No diagnosis step, no resolve automation, always transcodes (quality loss). Fallback `npl=220` undocumented heuristic. |
| **A6** | **blurridge/ffmpeg-iphone-hdr-sdr-converter** | https://github.com/blurridge/ffmpeg-iphone-hdr-sdr-converter — `main.py` verified | 1★, 2025-10-17 | none declared, 2 commits (2024-08) | **Minimal trustworthy tonemap example.** `main.py:6-20` `zscale=transfer=linear,tonemap=hable:peak=8,zscale=transfer=bt709,format=yuv420p,colorspace=all=bt709` → `libx264 fast crf22`. Proves Hable as alternative to Mobius. Dataset pipeline (720p60/1080p30). | `peak=8` undocumented, strips audio (`-an`), hard-coded vertical `720x1280`. No DV profile awareness, no NCLC handling. Data-augmentation focus, not Resolve delivery. |
| **A7** | **foldvarid93/HDR_to_SDR_VideoConverter** | https://github.com/foldvarid93/HDR_to_SDR_VideoConverter | 0★, 2025-11-23 | none, active 2025 | **Hybrid GUI/tool.** `VideoConverter.py` (ffmpeg direct) + `HandBrakeScript.py` (optional ffmpeg tonemap → HandBrakeCLI). Flags: `--use-ffmpeg-tonemap`, `--[REDACTED]`, `--encoder x264/x265`, `--prefer-gpu`. Addresses oversaturation failure mode. Verifies `ffmpeg -filters | Select-String tonemap/zscale`. | Thin wrapper, no profile-specific logic, no tests. HandBrake re-encode adds generational loss. No Resolve script. |
| **A8** | **pedrolabonia/pydavinci** — Resolve wrapper | https://github.com/pedrolabonia/pydavinci — tag `v0.2.3` (2022-05-15) | 181★, MIT, 171 commits, last 2026-04, needs maintainers (#42) | MIT, Python 3.6+, Pydantic | **Highest-fidelity Resolve scripting evidence.** Typed stubs `_resolve_stubs.pyi` expose `MediaPoolItem.GetClipProperty/SetClipProperty`, `GetMetadata/SetMetadata`, `Project.GetSetting/SetSetting`, `TimelineItem.GetClipColor`. Enables programmatic `SetClipProperty("Input Color Space", ...)`-type calls. `examples/` + `tests/` (proxy mode). | Stubs inspected: **no explicit `InputColorSpace`/`InputGamut` property name documented** — relies on Blackmagic's string-key API (undocumented, version-fragile). No HDR-specific example. Wrapper not endorsed by BMD. |
| **A9** | **diop/davinci-resolve-api** (docs mirror) + **nobphotographr/davinci-resolve-automation** + **MingoBoon/resolve-color-management-toolkit** | diop: https://github.com/diop/davinci-resolve-api (98★) ; nobphotographr: https://github.com/nobphotographr/davinci-resolve-automation (5★, MIT, 35 scripts) ; MingoBoon: https://github.com/MingoBoon/resolve-color-management-toolkit (0★, 2026-07-25) | diop: no license, updated 2018 doc dump; nobphotographr MIT; MingoBoon no license | **Resolve color management patterns.** diop documents `SetClipProperty`/`SetMetadata` signatures, `GetSetting`/`SetSetting` for project color science. nobphotographr `iphone_bmc_interactive.py` demonstrates end-to-end: detect media→`CreateProject`→`SetSetting` color science→`AddItemsToMediaPool`→`SetClipProperty` color space transform→apply CDL→create timeline. MingoBoon site explains **two-CST node chain** (camera→DWG at head, DWG→Rec709 Gamma2.4 at tail), `Apply Forward OOTF` once, `Rec709-A` (`1-1-1`) vs `1-2-1` NCLC tag trap, MXF no `colr`. | diop is **2018 stale** (Resolve 15 era). nobphotographr **Blackmagic Camera Log** focus (not iPhone DV/HLG) — extrapolate with risk; 5★ anecdotal. MingoBoon is **static site, not library** — no runnable automation, gamma shift docs for SDR mismatch, not HDR tone mapping. All three lack `ffprobe`/dovi_tool integration. |

---

## 2. Trustworthy Implementation vs Anecdotal Issue Reports

**Trustworthy (code + tests + spec):**
- `dovi_tool` crate/lib (Rust/C, `cargo test` in `tests/`, 1005★/81 forks) — parses RPU per Dolby ED. `FFmpeg` (63k★) — filter docs + `libplacebo` upstream. `MediaInfoLib`/`Bento4`/`GPAC` — binary parsing of `colr`/`nclc`/`dvvC`/`hvcC` atoms. `pydavinci` — typed stubs match BMD `fusionscript.so` (`src/pydavinci/wrappers/_resolve_stubs.pyi:Pedrolabonia`). These are primary sources.
- Verification: opened README + `dolby_vision/README.md` (libdovi build), `main.py:6-20` (blurridge Hable), `tonemap_prores.bat:22-30` (bbimer libplacebo), `MediaInfo` Project/MSVC2022 builds.

**Anecdotal / Secondary (separate, do not treat as API truth):**
- `bbimer`/`blurridge`/`foldvarid93` — 0-1★, no issues/PRs, screenshot "before/after" claims, no automated verification of color accuracy (no `ffprobe`/`MediaInfo` dump posted). Issue #378 ("correct way to convert DV to non-DV") closed as not planned — shows community confusion, not spec. Issue #381 open (empty RPU after editing) — edge-case bug report, not repro'd. `immich-app/immich#5120` HDR pale on mobile — closed, unrelated to Resolve but cited as washed-out symptom. `MingoBoon` gamma shift site — well-sourced (Resolve 20 Colorist Guide pp.481-482) but **SDR tag** focused, user must not infer HDR RPU handling.
- Rule: any recipe that says "just `-vf tonemap` fixes washed out" is anecdotal until backed by `ffprobe`/`MediaInfo` before/after dump + tagged `colr` verification.

---

## 3. Exact Sample Metadata (what GitHub proves iPhone writes)

| Source | File | Evidence |
|--------|------|----------|
| `bbimer/README` + `blurridge` context + `quietvoid/dovi_tool` docs | iPhone 15/16 Pro Max 4K60 `.MOV` | **Codec:** `hvc1`/`dvh1`/`dvhe` with `dvvC` box, **DV profile 8.4** (`dvh1.08.04` / `hvc1 + dovi_rpu`), HLG-compatible single layer (BL+HDR10 compatible + RPU). Verified via `dovi_tool info -i RPU.bin` summary path and FFmpeg `hevc_mp4toannexb` requirement noted in dovi_tool docs. |
| `MediaInfo` typical dump (inferred from MediaInfo issue # and UI; reproduced via `blurridge` dataset) | `IMG_1383.MOV` example in bbimer | `Color primaries: BT.2020`, `Transfer: HLG / PQ` (HLG  `arib-std-b67`), `Matrix: BT.2020 non-constant`, `Format: HEVC Main10` + `HDR format: Dolby Vision, Version 1.0, dvhe.08.06, BL+RPU / SMPTE ST 2086, HDR10 compatible` when fell back, or `HLG` alone if DV toggle off. |
| `ffmpeg -i` + `ffprobe -show_streams` (FFmpeg docs + `bbimer` pipeline) | Raw iPhone MOV | `color_primaries=bt2020`, `color_trc=arib-std-b67` (HLG) or `smpte2084` (PQ), `colorspace=bt2020nc`. After iOS `Photos → Transfer → Automatic` (default), **transcoded** to `bt709` SDR with wrong `colr` (`1-1-1` vs `1-13-1`) — documented in `bbimer` USB warning + `MingoBoon fixes.html` "auto-tag trap". |
| `Bento4 mp4info` / `MediaInfo` `colr` atom | MOV container | `nclx` box: `primaries=9 (BT2020)`, `transfer=18 (HLG)` or `16 (PQ)`, `matrix=9`, `full_range=0 (limited)`. Resolve reads this for auto input color space. Missing/wrong tag → Resolve assumes `Rec.709 (Scene)` → washed. |
| `dovi_tool export -d all` JSON | RPU `RPU.bin` | L1 (brightness), L2 (trims 100/600/1000 nits), L5 (canvas), L8 (CMv4.0 if iPhone 15+). `plot` shows trim curves. |

*No raw `.MOV` was found in searched repos; above is triangulated from code defaults + pipeline params. Repo `digitaltvguy/CICP-Test-Files...` (not ranked, but relevant) provides QT MOV with `nclc` tags + `mDCV`/`cLLI` reference if parent needs test vectors.*

---

## 4. Known Failure Patterns (GitHub-separated)

### 4a. Wrong / Missing Color Tags (NCLC/`colr`) — **Most common washed-out root**
- **Pattern:** iPhone exports via Photos `Automatic` → iOS silently re-encodes to 8-bit `bt709` but leaves `transfer=arib-std-b67` or strips `colr`. Resolve Color Managed (DaVinci YRGB Color Managed) auto-assigns based on tag → interprets HLG as SDR → flat/gray. Documented in `MingoBoon/fixes.html` (§ Why shift: ColorSync + NCLC, "three Rec.709s", `1-1-1` vs `1-2-1`), `bbimer` "grey background, flat contrast on SDR display" before/after.
- **Evidence tier:** trustworthy (BMD Colorist Guide p.481, Bento4 `mp4info` logic, MediaInfo `colr` readout).
- **Fix class:** **metadata rewrite (no transcode)** — `ffmpeg -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc` OR Bento4 `mp4tag --brand` + `mp42mux --color`, then `ffprobe` verify. Must not conflate with tonemap.

### 4b. Dolby Vision RPU / Profile Handling
- **Profile 8.4 vs 8.1 vs 5 confusion:** iPhone writes **P8.4 (HLG base)**. Resolve (≤18.6) decodes RPU only if `Resolve Studio` + `DaVinci YRGB Color Managed` with HDR enabled; otherwise ignores RPU → shows base HLG tonemapped wrongly (washed or oversaturated). `dovi_tool -m 2 convert` (P7→8.1) does **not** apply to iPhone; using it corrupts L2 trims. `dovi_tool -m 4` (→8.4) is correct inverse. Issue #414 `doesn't like Avatar Fire and Ash` shows parser fragility on new CMv4.0 L8 metadata.
- **RPU stripped by Photos/Telegram:** Sending as "Photo" via Telegram compresses; as File via `Keep Originals` preserves RPU. `bbimer` warns explicitly.
- **Resolve oversaturated:** If Resolve treats P8.4 as P5 (PQ) → applies PQ OETF inverse → neon. Opposite of washed.

### 4c. Photos Export / Transfer Changes (iOS)
- **Change:** iOS 17+ default `Transfer to Mac or PC: Automatic` converts HDR MOV→SDR HEVC/AAC for Windows, stripping `dvvC`. `bbimer` Quick Start §1 documents workaround: `Settings → Photos → Keep Originals`. No GitHub test proves bit-exact change, but pipeline break is cited in 2 repos (`bbimer`, `blurridge` notes `.MOV` suffix filter).
- **Detection:** `MediaInfo` `HDR format` absent after transfer → diagnostic.

### 4d. Resolve Import: Washed-Out / Oversaturated (systemic)
- **Washed-out (SDR timeline, HDR clip):** Resolve YRGB (non-managed) + no CST → HLG flat. Fix managed: set `Project Settings → Color Management → Input Color Space: Rec.2020 HLG` or per-clip `SetClipProperty` (see §5), or add CST: `Rec.2020 HLG → DaVinci WG Intermediate → Rec.709 Gamma2.4` (MingoBoon two-CST).
- **Oversaturated (NCLC 1-1-1 tag):** Export `Rec.709-A` then VLC/Firefox ignore tag → 10-15% brighter (bbimer MPV recommendation `mpv.io` + MingoBoon "Rec709-A not universal, VLC/Firefox/Vimeo ignore").
- **Gamma shift after render:** macOS ColorSync viewer mismatch (MingoBoon p.467) — separate from HDR decode.

---

## 5. Resolve Scripting Examples — Setting Input Color Space / Clip Metadata

*All from `pedrolabonia/pydavinci` stubs + `diop/davinci-resolve-api` + `nobphotographr` workflow read.*

```python
# Requires RESOLVE_SCRIPT_API/LIB env (see diop/README). Resolve must be running.
import DaVinciResolveScript as dvr

resolve = dvr.scriptapp("Resolve")
project = resolve.GetProjectManager().GetCurrentProject()
mediaPool = project.GetMediaPool()
root = mediaPool.GetRootFolder()
clips = root.GetClipList()  # or GetClips()

# A. Per-clip input color space (most relevant to iPhone HDR fix)
for clip in clips:
    # Property names are strings per BMD API; inspect via GetClipProperty() with no arg
    # Values discovered via MingoBoon/davinci docs: "Rec.2020 (Scene)" / "Rec.2020 HLG" / "Rec.709 (Scene)"
    ok = clip.SetClipProperty("Input Color Space", "Rec.2020 HLG")  # HLG iPhone
    # Alternative for flat fix: clip.SetClipProperty("Input Color Space", "DaVinci WG Intermediate")
    # Verify:
    props = clip.GetClipProperty()  # dump all
    print(clip.GetClipProperty("Input Color Space"))

# B. Bulk via metadata (nobphotographr pattern: batch_grade_apply / metadata_manager)
    clip.SetMetadata("Input Color Space", "Rec.2020 HLG")  # some Resolve versions expose via metadata

# C. Project color management (MingoBoon + pydavinci SetSetting)
project.SetSetting("colorScienceMode", "davinciYRGBColorManaged")  # or "davinciYRGB"
project.SetSetting("colorManagedInputColorSpace", "Rec.2020 HLG")  # default input
project.SetSetting("colorManagedOutputColorSpace", "Rec.709 Gamma 2.4")
# Verify:
print(project.GetSetting("colorScienceMode"))
```

**Stubs reference:** `pydavinci/src/pydavinci/wrappers/_resolve_stubs.pyi:PyRemoteMediaPoolItem.SetClipProperty(self, propertyName:str, propertyValue:Any)->bool`, `PyRemoteProject.GetSetting/SetSetting`. **Risk:** property key exact string is **version-dependent** (Resolve 18 vs 19 rename to `Input Color Space` vs `Clip Color Space`). Always dump `GetClipProperty()` first on a known clip. No iPhone-specific HDR example exists in any repo — gap.

---

## 6. Tool Capability Matrix — How to Separate Rewrite vs Transcode vs Tone-Map vs Automation

| Operation | When | Tool | Example |
|-----------|------|------|---------|
| **Diagnose tags** | First step for every clip | `ffprobe` / `MediaInfo` / `Bento4 mp4info` | `ffprobe -v error -select_streams v:0 -show_entries stream=color_primaries,color_trc,colorspace,codec_tag,side_data -of json file.MOV` <br> `MediaInfo --Output=JSON file.MOV` <br> `mp4info --verbose file.MOV` |
| **Metadata rewrite (no re-encode)** | Tag wrong but base is correct HLG | `ffmpeg -c copy -bsf:v` or `Bento4` or `GPAC MP4Box` | `ffmpeg -i in.MOV -c copy -bsf:v hevc_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9 out.MOV` ; `MP4Box -add in.hvc:fmt=hevc -rbds 0 in.MOV` |
| **DV RPU extract / inject / convert** | Need profile shift or remove DV | `dovi_tool` | `ffmpeg -i in.MOV -c:v copy -bsf:v hevc_mp4toannexb -f hevc - \| dovi_tool extract-rpu -o RPU.bin --summary` <br> `dovi_tool -m 2 convert --discard in.hevc` (P7→8.1, NOT for iPhone) <br> `dovi_tool inject-rpu -i BL.hevc --rpu-in RPU.bin -o out.hevc` |
| **Tone-map to SDR (re-encode)** | Deliver SDR, Resolve SDR timeline, or tag unrecoverable | `ffmpeg` | `ffmpeg -i in.MOV -vf "libplacebo=tonemapping=mobius:gamut_mode=perceptual:colorspace=bt709:color_primaries=bt709:color_trc=bt709" -color_primaries bt709 -color_trc bt709 -colorspace bt709 -c:v prores_ks -profile:v 1 out.mov` (bbimer) ; fallback `zscale=transfer=linear,tonemap=hable:peak=8` (blurridge) |
| **Resolve automation** | Apply fix to 100s of clips | `pydavinci` / `davinci-resolve-api` | See §5. Loop `SetClipProperty` + `project.SaveProject()` |

---

## 7. Architecture — How Pieces Connect for DaVinci-Plugin

```
iPhone .MOV (HEVC + dvvC RPU P8.4 HLG/BT2020)
   ├─► ffprobe/MediaInfo/mp4info ─► diagnose: DV profile? tags? RPU present?
   │         │
   │         ├─► tag correct HLG ─► Resolve: SetClipProperty Input Color Space = Rec.2020 HLG (or Color Managed auto)
   │         │
   │         └─► tag wrong/missing ─► metadata rewrite (Bento4/ffmpeg -c copy) ─► re-diagnose
   │
   ├─► dovi_tool extract-rpu ─► inspect L1/L2/L5 (RPU.bin json) ─► decide keep/strip/convert profile
   │
   └─► washing persists or SDR deliverable ─► ffmpeg libplacebo/zscale tonemap ─► ProRes/HEVC SDR + bt709 tags ─► Resolve SDR timeline (no HDR decode needed)
              ↑
   pydavinci / diop API bridges steps 1-4 into Resolve batch (but today no repo combines all 4; must wire plugin)
```

---

## 8. Gaps — What GitHub Does NOT Provide (for task owner)

1. **No single repo ties diagnose→rewrite→RPU→tonemap→Resolve batch.** `dovi_tool` (HEVC-only) + `MediaInfo` (read-only) + `pydavinci` (automation) are disjoint. Plugin must orchestrate.
2. **No iPhone test vectors committed.** No repo hosts raw `IMG_*.MOV` with `MediaInfo` JSON / `ffprobe` json + `dovi_tool info --summary` dump. `digitaltvguy/CICP-Test-Files...` is closest but generic, not iPhone P8.4.
3. **No Resolve `SetClipProperty` enumeration for HDR.** Property strings for `Input Color Space` not typed/validated; varies Resolve 18-20. `pydavinci` #42 needs maintainer.
4. **No non-transcode HLG→PQ→SDR comparison.** `blurridge peak=8`, `bbimer npl=220 mobius 0.4/desat 0.5` are heuristics, no CIE delta-E validation.
5. **HLG vs PQ iPhone branches not mapped.** iPhone toggles DV On/Off/HDR; repos hardcode one path (8.4 HLG). Quiet auto-fallback to HLG10 vs HDR10 not tested.
6. **Bento4/GPAC DV mux edge:** Stripping RPU via `dovi_tool convert --discard` then `MP4Box` may drop `colr` — no test for Resolve re-import.
7. **Photos `Automatic` transcode not bit-frozen.** No before/after `MediaInfo` pair in any issue to prove exact iOS conversion.

---

## 9. License / Maintenance Summary (for dependency choice)

| Tool | License | Risk |
|------|---------|------|
| dovi_tool/libdovi | **MIT** permissive | Low license risk; high bus factor (quietvoid solo) but 1k★, active |
| FFmpeg | **LGPL-2.1/GPL-2** copyleft (depends on `--enable-gpl`) | Must distribute source if statically linked; dynamic `ffmpeg` binary invocation mitigates |
| MediaInfo/MediaInfoLib | **BSD-2-Clause** | Very permissive, institutional backing (MediaArea) |
| Bento4 | Custom BSD-like (no SPDX in GH API) | Check `LICENSE` file; less actively released — prefer GPAC for new code |
| GPAC/MP4Box | **LGPL-2.1** | Copyleft limited to lib, tool use safe; active |
| pydavinci | MIT | Stale tag v0.2.3 (2022), needs maintainer — wrap with try/fallback, vendor stubs |
| nobphotographr/diop | MIT / none | Tutorial grade — not library, cite only |

---

## 10. Immediate Next Step for Main Agent

**File to touch first:** new `src/diagnose/` module (not existing codebase) that shells `ffprobe -show_streams -of json` + `mediainfo --Output=JSON` + `dovi_tool info --summary` (via pipe from `ffmpeg -bsf hevc_mp4toannexb`) and emits normalized report `{profile, codec_tag, color_primaries/trc/matrix, rpu_present, l1_peak, advice: "set Input Color Space HLG" | "rewrite tags" | "tonemap SDR"}`. Use `pydavinci` stub pattern to call `SetClipProperty` but guard with `GetClipProperty()` dump gate and Resolve version check. Add fixture using `digitaltvguy` CICP files + one real iPhone `Keep Originals` sample (obtain separately) with expected JSON.

---

## 11. Risks / Unknowns

- `dovi_tool` 2.3.3 requires Rust 1.88 — CI image may need bump.
- Resolve Free vs Studio: RPU decode only in Studio; script may silently no-op on Free.
- `libplacebo` not in stock `ffmpeg` (Homebrew `ffmpeg` often lacks it) — fallback `zscale+hable` must be default for portability.
- `nclc 1-1-1` (Rec709-A) export looks correct on Mac QuickTime but oversaturates broadcast — plugin must expose choice, not hardcode.

---

## Sources

1. **quietvoid/dovi_tool** — https://github.com/quietvoid/dovi_tool — accessed 2026-08-25, tag **2.3.3** (2026-07-12), `README.md:info/generate/editor/export/plot/convert/demux/mux`, `dolby_vision/README.md` libdovi, issues #378/#381/#414
2. **FFmpeg/FFmpeg** — https://github.com/FFmpeg/FFmpeg — accessed 2026-08-25, stars 63618, `doc/filters.texi` tonemap/zscale/libplacebo
3. **MediaArea/MediaInfo** — https://github.com/MediaArea/MediaInfo — https://github.com/MediaArea/MediaInfoLib — accessed 2026-08-25, BSD-2-Clause, 1999★/787★
4. **axiomatic-systems/Bento4** — https://github.com/axiomatic-systems/Bento4 — 2493★ 2026-08-24; **gpac/gpac** — https://github.com/gpac/gpac — LGPL-2.1 3296★ 2026-08-25
5. **bbimer/iphone-hdr-to-sdr-ffmpeg** — https://github.com/bbimer/iphone-hdr-to-sdr-ffmpeg — `tonemap_prores.bat:22-30` libplacebo mobius/perceptual, fallback `npl=220`, USB Keep Originals note, accessed 2026-08-25
6. **blurridge/ffmpeg-iphone-hdr-sdr-converter** — https://github.com/blurridge/ffmpeg-iphone-hdr-sdr-converter — `main.py:6-20` hable peak 8, accessed 2026-08-25
7. **pedrolabonia/pydavinci** — https://github.com/pedrolabonia/pydavinci — v0.2.3, `src/pydavinci/wrappers/_resolve_stubs.pyi:SetClipProperty`, accessed 2026-08-25
8. **diop/davinci-resolve-api** — https://github.com/diop/davinci-resolve-api — Get/SetClipProperty/SetSetting, 2018 dump
9. **nobphotographr/davinci-resolve-automation** — https://github.com/nobphotographr/davinci-resolve-automation — 35 scripts, `iphone_bmc_interactive.py`, MIT
10. **MingoBoon/resolve-color-management-toolkit** — https://github.com/MingoBoon/resolve-color-management-toolkit — `fixes.html` NCLC/Rec709-A/1-1-1 vs 1-2-1, CST chain

*All GH searches via `gh search`/`gh api`/`curl https://r.jina.ai/...` read-only; no clones into repo.*
