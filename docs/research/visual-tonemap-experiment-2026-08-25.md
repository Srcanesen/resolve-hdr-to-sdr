# Visual Tonemap Experiment — 2026-08-25

**Status:** Reversible diagnostic A/B/C only — no production change, no visual acceptance claim.
**Scope:** `Sample/1.MOV` only, opening ≤4 s segment, 3 Rec.709 SDR ProRes LT candidates + labeled contact sheet + verifier. No `Sample/` modification, no `Output/spike/*` overwrite, no ClipDock/vault/canonical/source-report change, no `scripts/convert-hlg-to-sdr.sh` change.
**Invariant:** Source read-only; every new artifact under `Output/diagnostic/` is separately named and non-overwriting (`-n` guard + preflight).

## 1. Objective

Generate a small, reversible A/B/C visual test to surface a usable HLG→SDR tone-map direction after the reported HLG spike visible failure. Metrics and tags are not ground truth; **on-screen human judgment decides**. No operator is declared correct and no converter recommendation is made here.

## 2. Local Host Evidence (no installs)

- `ffmpeg 8.1.2` / `ffprobe 8.1.2` (`/opt/homebrew/bin/ffmpeg`), Apple clang 21.0.0
- `ffmpeg -hide_banner -h filter=libplacebo` → unavailable; `filter=zscale` → unavailable (host has no libplacebo/zscale)
- `ffmpeg -hide_banner -h filter=tonemap` → supports `tonemap {none,linear,gamma,clip,reinhard,hable,mobius}`, `peak`, `desat`, `param`
- `ffmpeg -hide_banner -h filter=scale` → verified before run:
  `grep -E '^[[:space:]]+(in_transfer|out_transfer|in_primaries|in_color_matrix)` all present (integer enums through transfer 18, including `arib-std-b67` and `linear`, primaries `bt2020`, matrix `bt2020nc`)
- `ffmpeg -hide_banner -h filter=colorspace` → `all/bt709`, `space/bt709`, `range/tv`, `primaries/trc` available; validated via prior spike `colorspace=bt709` which produces tagged output on this host
- `Pillow 12.3.0` used for contact-sheet composition; `drawtext` unavailable so labeling was done via Python PIL instead of FFmpeg text filters (avoids unsupported filter)

Filter-option verification was run immediately before conversion and passed (see `Output/diagnostic/` logs).

## 3. Source Fingerprint (pre == post)

| Source | Size | SHA-256 | Probe |
|---|---|---|---|
| `Sample/1.MOV` | 18,423,719 | `46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593` | `1920×1080` coded → `1080×1920` display (-90°), `yuv420p10le`, `bt2020nc/arib-std-b67/bt2020`, `tv`, HEVC Main10, 16.375 s / 491 decoded frames, `DV 8.4` compat 4 HLG base, VFR |

- `shasum -a 256 Sample/1.MOV` pre-run: `46dad3...88593`
- `shasum -a 256 Sample/1.MOV` post-run: `46dad3...88593` — **unchanged**
- `Sample/2.MOV` not used (task scoped to `1.MOV` only)

## 4. Exact Filter Graphs (only locally supported options)

Common preconditions for all three: explicit HLG input color state + linear-light conversion → diagnostic tonemap → Rec.709 output state, stripped container metadata, explicit Rec.709 SDR tagging.

Common suffix & encode flags (all candidates):
```
-map_metadata -1 -map 0:v:0 -map 0:a? 
-c:v prores_ks -profile:v 1 -pix_fmt yuv422p10le -vendor ap10
-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
-c:a aac -b:a 128k -fps_mode passthrough -movflags +write_colr -n
-ss 0 -t 4  (bounded opening segment, max 4.0 s, passthrough timestamps)
```

**Candidate A — hable peak=2 desat=0:**
```
scale=in_color_matrix=bt2020nc:in_transfer=arib-std-b67:in_primaries=bt2020:out_transfer=linear,
tonemap=hable:peak=2:desat=0,
colorspace=bt709,format=yuv422p10le
```
→ `Output/diagnostic/1_hlg_hable_p2_d0_4s.mov`

**Candidate B — mobius peak=1 desat=0:**
```
scale=in_color_matrix=bt2020nc:in_transfer=arib-std-b67:in_primaries=bt2020:out_transfer=linear,
tonemap=mobius:peak=1:desat=0,
colorspace=bt709,format=yuv422p10le
```
→ `Output/diagnostic/1_hlg_mobius_p1_d0_4s.mov`

**Candidate C — reinhard peak=1 desat=0:**
```
scale=in_color_matrix=bt2020nc:in_transfer=arib-std-b67:in_primaries=bt2020:out_transfer=linear,
tonemap=reinhard:peak=1:desat=0,
colorspace=bt709,format=yuv422p10le
```
→ `Output/diagnostic/1_hlg_reinhard_p1_d0_4s.mov`

Each graph was verified locally (`scale`/`tonemap` option check) before execution. No libplacebo/zscale path was available, so this remains a `scale+tonemap+colorspace` fallback with no perceptual gamut mapping, no BT.2408 handling, and no Dolby Vision RPU trim — quality ceiling is deliberately limited.

## 5. Outputs (separately named, non-overwriting, ≤4 s)

| Candidate | File | Size | SHA-256 | Duration | Frames | Probe |
|---|---|---:|---|---:|---:|---|
| A hable p2 d0 | `1_hlg_hable_p2_d0_4s.mov` | 53,619,802 | `bd77c1c7ae96465e069af80623286a89ef10d42ac4b308f67ba5c635e0694fb0` | 4.000000 | 120 | `prores LT 1080×1920 yuv422p10le tv bt709/bt709/bt709` |
| B mobius p1 d0 | `1_hlg_mobius_p1_d0_4s.mov` | 53,880,372 | `53a6fb18699419df9c0eba73466a5b6798831fd30f7ad702e627bf35106190d6` | 4.000000 | 120 | `prores LT 1080×1920 yuv422p10le tv bt709/bt709/bt709` |
| C reinhard p1 d0 | `1_hlg_reinhard_p1_d0_4s.mov` | 53,827,923 | `22b2defd9acb7f2d092fca99c4f882b09d2f904040bcff192d0f560cffee676b` | 4.000000 | 120 | `prores LT 1080×1920 yuv422p10le tv bt709/bt709/bt709` |

All three are opening segment `ss=0 t=4`, timestamps preserved as reasonable via `-fps_mode passthrough` (output `4.000000 s`, start ~0, ≤4 s bound). No existing file was overwritten (`-n` + pre-existence check).

## 6. Metadata & Privacy Verification

Verifier: `Output/diagnostic/verify-diagnostic.sh` (executable, diagnostic-only)

Checks per candidate:
- non-empty (`-s` >0)
- `ffprobe` Rec.709 tags exactly `bt709/bt709/bt709`, `tv`, `yuv422p10le`, `prores` `LT`
- duration ≤4.05 s (allow mux rounding; observed 4.0)
- no `com.apple.quicktime.*`, `ISO6709`, `location`, `creation_time`/`creation_date`/`date created` in `ffprobe -show_format -show_streams` JSON **and** in `strings -a` raw-byte scan (broad regex `com[.]apple[.]quicktime[.]|iso6709|location|creation[ _-]?(time|date)|date[ _-]?created`)
- contact sheet `contact_sheet.png` exists, non-empty, PNG type

Result:
```
verify-diagnostic: PASS
A hable   — OK nonempty, OK bt709/bt709/bt709 tv yuv422p10le prores LT, OK duration 4.0 ≤4.05, OK no forbidden ffprobe, OK no forbidden strings, sha bd77...
B mobius  — OK ... sha 53a6...
C reinhard— OK ... sha 22b2...
contact_sheet.png — OK 1,768,795 B (1692×1176 RGB)
PASS: all diagnostic candidates nonempty, Rec.709 tagged, privacy-stripped, bounded ≤4 s, contact sheet present — visual acceptance still requires human on-screen judgment
```

Privacy note: `-map_metadata -1` stripped container location/camera/creation tags; data tracks (`mebx` face/metadata) not mapped (`-map 0:v:0 -map 0:a?` only). Remaining side data `Ambient viewing environment` is not in the forbidden pattern and is expected from FFmpeg side-data passthrough; forbidden creation QuickTime/ISO6709/location terms absent in both ffprobe and raw strings.

Existing `Output/spike/*` verified unchanged (SHA matches `conversion-spike-2026-08-25.md` v2):
- `1_sdr_rec709_proreslt_v2.mov` `3153562543a87ff754a361ce0f953aea6223f9cccc61fefaee274a6e1026d684`
- `1_sdr_rec709_proreslt.mov` `3153562543a87...` (identical)
- `2_sdr_rec709_proreslt_v2.mov` `13a9e4e6ee9cc96fdf4045f350181cd9b23c7a1ba98ca39bc5ca982f64551c47`
- `2_sdr_rec709_proreslt.mov` `13a9e4e6...` (identical)

## 7. Contact Sheet (comparison aid only, not ground truth)

- `Output/diagnostic/contact_sheet.png` — `1692×1176` RGB, `1,768,795 B`, SHA `f317edb58867c2ff2671f3b8787778acc6a39590c5691e2bb5081f28b23f2e63`
- Frames extracted at same timestamp (`-ss 1.0` → `png rgb48be 1080×1920` then downscaled) from each candidate: `frames/hable.png` (6.0 MB), `frames/mobius.png` (6.1 MB), `frames/reinhard.png` (6.1 MB)
- Composed via `make_contact_sheet.py` (Pillow) — 3 thumbnails scaled to 960 px tall (540×960) with 16 px gap, labels `A/B/C — {hable,mobius,reinhard} peak={2,1} desat=0`, top title + subtitle “Comparison Aid Only — human visual judgment decides — NOT ground truth”, footer with filter graphs
- PNG renders in any image viewer/QuickTime/Preview; screens comfortably side-by-side without scrolling

## 8. How to Compare (user instruction)

1. Open `Output/diagnostic/contact_sheet.png` first for labeled side-by-side of the same ~1.0 s frame.
2. Then open each candidate MOV separately in QuickTime/Preview/Resolve viewer at 100% on a calibrated SDR display (prefer same display/brightness):
   - `Output/diagnostic/1_hlg_hable_p2_d0_4s.mov` (A)
   - `Output/diagnostic/1_hlg_mobius_p1_d0_4s.mov` (B)
   - `Output/diagnostic/1_hlg_reinhard_p1_d0_4s.mov` (C)
3. Compare same ≤4 s opening segment for: highlight roll-off, skin-tone saturation (desat=0 retains), shadow lift, banding. Scrub to ~1 s to match contact-sheet frame.
4. Decide only by on-screen human acceptance; **do not use file size/hash/PSNR/bitrate as appearance proof**. Note which label you prefer, if any.
5. No file is a final recommendation and no change to the main converter is implied.

## 9. Known Limitations & Non-Claims

- **Human decides:** Metadata, hashes, sizes, and passing verifier do NOT prove visual correctness. No operator is claimed correct; no recommendation is made and `scripts/convert-hlg-to-sdr.sh` is unchanged.
- **Quality ceiling:** Host has no `libplacebo`/`zscale`; fallback `scale+tonemap` + `colorspace=bt709` has no perceptual gamut handling, no BT.2408/HLG Scene adaptation, no Dolby Vision RPU/per-frame trim, no scene-referred grading. Results are diagnostic only.
- **VFR note:** `Sample/1.MOV` is VFR (average 29.47 vs 30); output 4 s segment at 30 fps passthrough is a bounded diagnostic; full-length VFR conformance was not re-tested here.
- **Privacy scope:** Broad pattern check; “passing” means no forbidden bytes were found, not an exhaustive privacy audit.
- **Not elaborate HDR support:** Only HLG `bt2020nc/arib-std-b67/bt2020` class was accepted; PQ/DV general handling remains unimplemented and unclaimed.

## 10. Reversibility & Changed Paths

- **Created only:**
  - `Output/diagnostic/1_hlg_hable_p2_d0_4s.mov`
  - `Output/diagnostic/1_hlg_mobius_p1_d0_4s.mov`
  - `Output/diagnostic/1_hlg_reinhard_p1_d0_4s.mov`
  - `Output/diagnostic/frames/hable.png`, `mobius.png`, `reinhard.png`
  - `Output/diagnostic/contact_sheet.png` (1.7 MB, 1692×1176)
  - `Output/diagnostic/verify-diagnostic.sh`
  - `Output/diagnostic/make_contact_sheet.py` (build aid)
  - `docs/research/visual-tonemap-experiment-2026-08-25.md` (this note)
- **Not changed:** `Sample/1.MOV` bytes/hash, `Output/spike/*`, `scripts/convert-hlg-to-sdr.sh` / `verify-spike.sh`, `docs/research/conversion-spike-2026-08-25.md`, `docs/research/local-sample-inspection-2026-08-25.md`, canonical/source reports, vault, ClipDock.
- **To revert:** `rm -rf Output/diagnostic` and `rm docs/research/visual-tonemap-experiment-2026-08-25.md`.

## 11. Validation Commands Executed

```bash
# filter option pre-check
ffmpeg -hide_banner -h filter=scale 2>&1 | grep -E 'in_transfer|out_transfer|in_primaries|in_color_matrix'
ffmpeg -hide_banner -h filter=tonemap 2>&1 | grep -E 'tonemap|peak|desat'

# source hash pre/post
shasum -a 256 Sample/1.MOV

# conversions (each with -n non-overwrite + -fps_mode passthrough + -map_metadata -1)
ffmpeg -hide_banner -ss 0 -t 4 -i Sample/1.MOV -map_metadata -1 -map 0:v:0 -map 0:a? \
  -vf "scale=in_color_matrix=bt2020nc:in_transfer=arib-std-b67:in_primaries=bt2020:out_transfer=linear,tonemap=hable:peak=2:desat=0,colorspace=bt709,format=yuv422p10le" \
  -c:v prores_ks -profile:v 1 -pix_fmt yuv422p10le -vendor ap10 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 128k -fps_mode passthrough -movflags +write_colr -n Output/diagnostic/1_hlg_hable_p2_d0_4s.mov
# (mobius peak=1, reinhard peak=1 same template)

# tags/privacy/duration
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=color_space,color_transfer,color_primaries,color_range,profile,pix_fmt,width,height,duration,nb_read_frames -of json <candidate>
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 <candidate>
strings -a <candidate> | grep -Ei 'com[.]apple[.]quicktime[.]|iso6709|location|creation[ _-]?(time|date)'

# contact sheet extraction
ffmpeg -hide_banner -ss 1.0 -i <candidate> -frames:v 1 frames/<name>.png
python3 Output/diagnostic/make_contact_sheet.py  # → contact_sheet.png 1692×1176

# verifier
Output/diagnostic/verify-diagnostic.sh  # → PASS
```
