# Local Sample Inspection — 2026-08-25

**Date (UTC):** 2026-08-25
**Scope:** Read-only forensic inspection of two MOV samples under `Sample/`
**Invariant:** No alter/copy/transcode/editor. Paths basename+hash only.
**Canonical:** `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` (§3,§4,§5,§6)

---
## 1. Path Resolution — `Sample` vs `sample`

- APFS case-insensitive (`diskutil info /` → APFS). `Sample` and `sample` same inode `26959157`; no symlink/duplicate.
- `ls -li` identical: `1.MOV` `26959183` (18423719 B), `2.MOV` `26959184` (20313976 B). Single truth `Sample/`.

---

## 2. Deterministic Fingerprint

| Basename | Size (bytes) | SHA-256 | Inode |
|---|---|---|---|
| `1.MOV` | 18423719 | `46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593` | 26959183 |
| `2.MOV` | 20313976 | `2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a` | 26959184 |

Method: `shasum -a 256` pre/post; `stat -f %z`. Validation post==pre (see §12). No bytes altered.

---

## 3. Tool Availability (no installs)

| Tool | Availability | Version / Evidence | Role |
|---|---|---|---|
| `ffprobe` | ✅ | `8.1.2` `/opt/homebrew/bin/ffprobe` Apple clang 21.0.0 | primary four-layer |
| `ffmpeg` | ✅ implicit | `8.1.2_1` | hevc_mp4toannexb pipe |
| `MediaInfo` | ❌ not found | `which` fails | HDR_Format — **gap** |
| `mp4box` (GPAC) | ❌ not found | not found | isom diso — **gap** |
| `Bento4` | ❌ not found | not found | box dump — **gap** |
| `ExifTool` | ❌ not found | not found | QuickTime keys — **gap** (python fallback) |
| `dovi_tool` | ❌ not found | not found | RPU — **gap** (ffprobe fallback) |
| `shasum`/`stat`/`python3`/`strings` | ✅ | `/usr/bin/shasum` `python3 3.14.7` | hash/box |

No network/install.

---

## 4. Commands Executed (read-only)

1. `ls -ld Sample sample; ls -li Sample; diskutil info /`
2. `shasum -a 256; stat -f`
3. `ffprobe -show_format -show_streams -show_chapters` ×2
4. `ffprobe -show_frames -read_intervals %+#1 -select_streams v:0` (RPU)
5. `ffprobe -show_packets -select_streams v:0` (VFR)
6. `python3` stts/box walk + `strings` grep dvvC/hvcC/colr/nclc/mebx/mdcv
7. `python3` keys snippet + exhaustive counts
8. post `shasum` re-check

---

## 5. Fields Inspected (four-layer)

| Layer | Fields | Method |
|---|---|---|
| A Container | ftyp/qt, moov size, colr nclx/nclc 9/18/9, hvcC/dvvC/mdcv/clli, keys/ilst | ffprobe + python box |
| B Codec VUI | color_space/transfer/primaries/range/pix_fmt/chroma/profile/level | ffprobe stream color_* |
| C Dolby | dv_profile/level/rpu/el/bl/compat_id + frame RPU header | ffprobe DOVI side_data |
| D System | creation_time, make/model/software/location, amve, Display Matrix | ffprobe tags + keys |
| E Timing | r/avg_frame_rate, time_base, nb_frames, packet duration, stts | ffprobe + stts parse |
| F Absence | mdcv/clli/prof null | strings+side_data |

---

## 6. Normalized Results — Side-by-Side

### 6.1 Format & System

| Field | 1.MOV | 2.MOV |
|---|---|---|
| `format_name` | `mov,mp4,m4a,3gp,3g2,mj2` | same |
| `major_brand` | `qt` | `qt` |
| `file size` | `18423719` | `20313976` |
| `duration` | `16.375 s` | `18.565 s` |
| `bit_rate` | `9000900` | `8753665` |
| `ftyp` | `qt 0 qt` offset0 size20 | same |
| `moov` | `18404147 size19572` | `20291523 size22453` |
| `creation_time` | `2026-08-24T13:06:47Z` / `16:03:48+0300` | `2026-08-24T12:43:43Z` / `15:43:43+0300` |
| `make/model/software` | `Apple / iPhone 17 Pro Max / 26.5.2` | same |
| `location ISO6709` | `location metadata present (exact coordinate redacted)` | `location metadata present (exact coordinate redacted)` |

### 6.2 Video Stream (HEVC)

| Field | 1.MOV | 2.MOV |
|---|---|---|
| `codec` / `tag` | `hevc` / `hvc1` | same |
| `profile` | `Main 10` | same |
| `pix_fmt` | `yuv420p10le` | same |
| `1920x1080` coded `1920x1088` | ✅ | ✅ |
| `level` | `120` | `120` |
| `color_range` | `tv` (MPEG narrow) | `tv` |
| `color_space` | `bt2020nc` (mat 9) | same |
| `color_transfer` | `arib-std-b67` (HLG 18) | same |
| `color_primaries` | `bt2020` (pri 9) | same |
| `chroma_location` | `left` | same |
| `r_frame_rate` | `30/1` | `30/1` |
| `avg_frame_rate` | `100600/3413` ≈29.47 | `30/1` |
| `time_base` | `1/600` | `1/600` |
| `nb_frames` | `503` | `557` |
| `bit_rate` video | `8486235` | `8530410` |

### 6.3 Container Boxes

| Box | 1.MOV | 2.MOV |
|---|---|---|
| `colr` | `nclc 9/18/9` (0009/0012/0009) | same |
| `hvcC` | 1× 134B | same |
| `dvvC` | 1× 32B `01001025...` | same |
| `dvcC` | 0 | 0 |
| `mdcv`/`clli`/`prof` | 0 | 0 |
| Conflict | none — colr matches VUI | same |

### 6.4 Dolby Vision

| Field | 1.MOV | 2.MOV |
|---|---|---|
| `DOVI record` | `dv 1.0 profile8 level4 rpu1 el0 bl1 compat4 none` | identical |
| Compat | `4=HLG` → 8.4 | same |
| RPU SEI | present NAL 62/63 | present |
| Frame-0 Metadata | `rpu_type2 format18 bl_range0 bl10 vdr12 nlq none 1x1` + polynomial+mmr | same |
| `amve` | `314 lux x15635/50000 y16450/50000` | same |
| `Display Matrix` | `rotation -90` portrait | same |

### 6.5 Non-Video Tracks

| Track | 1.MOV | 2.MOV |
|---|---|---|
| `aac LC 48kHz` | `120327 bps 769 frames` | `120664 bps 873 frames` |
| mebx orientation | 1 | 1 |
| mebx detected-face | 492 | 557 |
| mebx live-photo-info | — | 557 (only 2.MOV) |
| mebx scene-illuminance | 492 | 557 |
| mebx segment-identifier | 1 | 1 |
| keys lens/meta | 5-key + 8-entry ilst | same |

### 6.6 Timing / VFR

| Field | 1.MOV | 2.MOV |
|---|---|---|
| `stts` entries | `12` (20/60 ticks) | `1` (557×20) |
| packet `duration_time` uniq | `0.031667,0.033333,0.066667,0.100000` (19,20,40,60) **VFR** | `0.033333` single **CFR** |
| `avg` vs `r` | `29.47 ≠30` VFR | `30==30` CFR |
| `ctts`/`sdtp`/`has_b_frames` | present / 2 | present /2 |

---

## 7. Verdict
Test line
Capture class Both iPhone native DV84 HLG base high confidence.
Not pure HLG not PQ not Log not SDR.
Byte-preserving HDR master passes gate.
Model 17 Pro Max synthetic fixture inference.
## 7. Four-Layer Verdict vs Canonical

HDR system BT2100 HLG - match.
Codec VUI 9 18 9 range0 - match.
Container qt nclc 9 18 9 dvvC amve no mdcv - match.
Dolby 8.4 compat4 BL RPU - match.

Capture class iPhone native Camera HDR Video Dolby Vision Profile 8.4 HLG base high confidence inference.
Not pure HLG not PQ HDR10 not Log not SDR.
Byte-preserving HDR master passes ingest gate.
Model iPhone 17 Pro Max 26.5.2 future dated synthetic fixture inference.

## 8. Why Resolve Would Look Wrong (no CST prescribed)

- Washed flat likely RCM vs YRGB or Viewer Display mismatch. Test bypass RCM.
- Highlights hot likely Input Rec2020 vs Rec2100 HLG Scene vs ST2084. Test Input cycle.
- Flat vs Photos per-cut punch missing likely RPU ignored. Test QuickTime vs Resolve.
- Black pedestal likely Video vs Full Data Levels. Test Clip Attributes toggle.
- 1-1-1 vs 1-2-1 mismatch likely ColorSync tagging. Test Deliver tags A B.
- Crushed or CST inert likely duplicate transforms. Test disable all.
- 1.MOV stutter likely VFR. Test avg 29.47 vs r30.

## 9. Fact Inference Separation

Fact: sizes SHA inode ftyp qt HEVC Main10 yuv420p10le 1920x1080 bt2020nc arib-std-b67 bt2020 tv left hvc1 dvvC colr nclc 9 18 9 no mdcv amve314 rotation -90 mebx tracks AAC iPhone tags VFR vs CFR.

Inference: DV84 class high conf VFR cause indeterminate Resolve symptoms taxonomy not observed 26.5.2 fixture location plausible.

Community: universal HLG Scene CST not reproduced.

Not overstated: profile8 compat4 only RPU trim not claimed without dovi_tool dvhe string not claimed without MediaInfo.

## 10. Missing Evidence and Next Evidence

Gap MediaInfo why HDR_Format dvhe confirm minimal command mediainfo Video HDR_Format
Gap ExifTool why QuickTime tags command exiftool ColorSpace
Gap mp4box Bento4 why colr mdcv command mp4box diso
Gap dovi_tool why RPU L1 L2 command ffmpeg hevc_mp4toannexb pipe dovi_tool info
Gap Mid-frame RPU hidden SEI command ffprobe show_frames mid
Gap VFR conform why Resolve behavior command ingest into Resolve 21 timeline
Gap Synthetic date why provenance capture re-capture release iOS Keep Originals USB
Gap SDR control why gate prove capture SDR 1 1 1 same scene

Unresolved risk RPU vs VUI range relies on ffprobe bl_range0 invisible without dovi_tool.

## 11. Suggested Next Captures Settings (minimal matrix no CST)

1. HDR ON vs OFF pair same scene release iOS 26 HEVC 4K30 verify 9 18 9 plus dvvC vs 1 1 1
2. ProRes HDR vs Log SSD HLG no dvvC vs Log Rec2020
3. Transfer A B Unmodified Original USB Keep Originals vs Most Compatible Photos Export prove 10b to 8b
4. VFR stress walk low-light vs CFR tripod bright
5. Portrait -90 vs Landscape

Each screenshot Settings SHA256 plus ffprobe JSON side-car.

## 12. Validation

- SHA pre equals post 46dad3...88593 and 2780c7...4a82a identical after reads
- Tool versions recorded section 3
- Fields inspected section 5
- Result table section 6 side-by-side
- Fact inference section 9 split
- Next evidence sections 10 11
- No source mod mdat moov offsets unchanged tail0 mtime untouched no ffmpeg write
- Paths privatized basename only

---

## 13. Appendix Raw Summaries

- Top-level ftyp20 wide8 mdat 18404119 20291495 moov 19572 22453
- stsd hex hvc1 plus hvcC134 plus dvvC32 0000002064767643 plus colr nclc 9 18 9 plus amve
- Packets 1.MOV first10 pts negative B reorder 2.MOV pts 0 reorder no negative
- Side_data streams 0 DOVI record Display Matrix amve no Mastering MaxCLL

End No architecture CST recommendation. Next install missing tools re-run section 10.

