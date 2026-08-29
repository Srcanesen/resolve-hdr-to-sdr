# iPhone HDR Video Transfer/Export Provenance — Capture-to-Resolve

**Date:** 2025-08-25 (accessed via jina.ai proxy; official URLs retain 2025-2026 published dates)
**Scope:** iPhone HDR = Dolby Vision 8.4 (HEVC 10-bit BT.2020 HLG-compatible) since iPhone 12, and HLG. Container/codec/transfer/metadata preservation to DaVinci Resolve.

---

## 1. Capture Baseline

- iPhones 12+: default = HEVC 10-bit BT.2020 HLG/Dolby Vision Profile 8.4, colorspace bt2020nc, transfer smpte2084 or arib-std-b67, primaries bt2020 + Dolby Vision RPU SEI.
- iPhone 16 Tech Specs (support.apple.com/en-us/121029): "4K Dolby Vision... Video formats: HEVC and H.264" — HEVC is DV carrier; H.264 only when Most Compatible forces SDR.
- Preserved HDR = 10-bit HEVC + hvcC + colr nclc + dvcC/dvvC + HDR SEI survives; stripped = 8-bit H.264 Rec.709 SDR.

**ffprobe preserved:** codec_name=hevc profile Main 10 pix_fmt yuv420p10le color_space bt2020nc transfer smpte2084 primaries bt2020 side_data DOVI dv_profile 8
**ffprobe stripped:** codec_name h264 pix_fmt yuv420p transfer bt709 no DOVI

---

## 2. Path-by-Path Matrix

| Path | Category | HEVC/DV/HLG | Res/FPS | Official Docs | Confidence | Observable Evidence |
|------|----------|-------------|---------|---------------|------------|---------------------|
| AirDrop Apple->Apple (modern) | Byte-preserving | Yes — original .MOV HEVC 10-bit + DV if receiver supports HEVC | Original up to 4K60 | HT207022/116944: "If sharing via AirDrop... and receiving device doesn't support... might automatically be shared in more compatible format such as JPEG or H.264." | High (conditional) | md5 identical; ffprobe hevc 10-bit + dovi |
| AirDrop -> older/non-Apple | Transcode | No — tone-map to H.264 8-bit SDR | Preserved res but SDR | Same | High | h264 bt709 |
| iCloud Photos Download Originals to this Mac | Byte-preserving | Yes | Original | 108782: "stored in original formats at full resolution (HEIF, HEVC, MP4)" + 111762 "Download Originals to this Mac" | High | hevc+DV identical |
| iCloud Optimize Mac/iPhone Storage | Conditional | Original in cloud, local is proxy | Proxy lower | 108782: "Keep original high-res in iCloud, space-saving on device" | High | smaller file, missing DV |
| iCloud.com Unmodified Original | Byte-preserving | Yes | Original | 111762 (2026-04-10): "Unmodified Originals (format as captured)" | High | hash matches, .MOV in ZIP |
| iCloud.com Most Compatible / Highest Resolution | Transcode | No — H.264/AAC MP4, bakes edits | Original res SDR | 111762: "Most Compatible (JPEG or MP4/H.264) including edits even if originally HEIF/HEVC" | High | h264 bt709 no DV |
| macOS Photos Export Unmodified Original | Byte-preserving | Yes + .AAE sidecar | Original | Photos Guide pht6dcd5d1a0: "Export Unmodified Original" | High | hevc+DV, md5 vs iCloud |
| macOS Photos Export (default) | Transcode+tone-map | No — H.264 SDR | User-chosen flattened | Photos Guide: default Export applies edits and converts to most compatible | High | h264 bt709 no DV |
| Finder/Image Capture USB Keep Originals | Byte-preserving | Yes | Original | HT207022: "might be converted to JPEG/H.264. If you don't want conversion, tap Keep Originals." HT201302 USB import | High (only if Keep Originals) | hevc+DV byte-identical |
| Finder/Image Capture USB Automatic | Transcode | No — on-the-fly to H.264/JPEG | SDR | Same HT207022 | High | h264 bt709 |
| Shared Albums | Transcode+downscale+strip | No — H.264 SDR <=720p <=15min | Capped 720p | 108916: "Videos delivered at up to 720p... Videos up to 15 min... Downloaded content may not contain same info" | Very High | 1280x720 h264 bt709 |
| iCloud Drive Shared Folder | Byte-preserving | Yes if Unmodified Original saved first | Original | iCloud Drive generic file sync (not Photos pipeline) | High | hevc+DV |
| Messages iMessage video | Transcode | No — H.264 SDR <=1080p compressed | Reduced | HT207022: "If sharing via Messages... might be shared in more compatible format such as JPEG or H.264" | High | h264 yuv420p bt709 small |
| SMS/MMS fallback | Transcode heavy | No <720p <1Mbps | Carrier cap | MMS ~1-3MB | Very High | tiny h264 |
| WhatsApp default Gallery | Transcode+tone-map | No — H.264 SDR 720-1080p | Capped | WhatsApp auto compression; HD toggle still H.264 SDR | High (reproducible) | h264 bt709 no DV |
| WhatsApp Send as Document | Byte-preserving up to 2GB | Yes | Original | WhatsApp: "Send as document to preserve original" | High | hevc+DV hash matches |
| Telegram Send as Video | Transcode | No — H.264 SDR | <=1080p | Re-encodes unless Send as File | High | h264 bt709 |
| Telegram Send as File | Byte-preserving | Yes | Original | File upload preserves bytes | High | hevc intact |
| Instagram/TikTok/Facebook/X/Snapchat re-download | Transcode+tone-map+strip | No — H.264/H.265 SDR 8-bit Rec709 | Platform cap | Meta/TikTok Help: recompress uploads | Very High | h264 bt709 low bitrate |
| YouTube upload HDR then download yt-dlp | Transcode | Partial — platform serves VP9 HDR but download is re-encode not original DV | Re-encoded | YouTube HDR upload re-encoded | High | vp09/avc bt2020 not dvhe |
| Google Photos Original | Byte-preserving if Original | Yes | Original | 6220791: "Original quality: same resolution no change" | High | hevc+DV |
| Google Photos Storage saver/Express | Transcode+downscale | No >1080p->1080p re-encode | Cap 1080p | 6220791: "Videos higher than 1080p resized to 1080p" | Very High | h264 1080p SDR |
| Google Drive/Dropbox/OneDrive/iCloud Drive plain upload | Byte-preserving | Yes | Original | Help: upload original file, preview transcodes but download original | High | hash identical |
| Mail Actual Size | Byte-preserving if Actual Size | Yes if <=25MB Actual Size | Original | Apple Mail Actual Size sends original | Medium-High | hevc only on Actual Size |

Version caveat: iOS 17-18, macOS 14-15, Photos 8, iCloud.com 2025-06. iOS 27 beta proposes Shared Albums full-res opt-in counting against storage (MacRumors 2026) not in 108916 yet.

---

## 3. Taxonomy

1. Byte-preserving: AirDrop capable, iCloud Originals, Unmodified Original, Keep Originals USB, Drive file, WhatsApp/Telegram as Document -> md5 matches dvvC preserved
2. Container rewrite: rare, may strip colr/dvcC
3. Tone-map HDR->SDR: CoreImage HDR->Rec709 SDR 8-bit H.264 — Photos Export, Messages, Shared Albums, social — irreversible
4. Metadata strip: social strips all; Apple transcodes strip HDR atoms but may keep com.apple.quicktime

Resolve:
- True HDR: H265 10-bit Rec2020/HLG ST2084 Dolby Vision Present
- Tone-mapped SDR: H264 8-bit Rec709 no DV

---

## 4. How to Distinguish

```
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,color_space,color_transfer,color_primaries -show_entries stream_tags=creation_time -of json file.mov
ffprobe -v error -show_entries stream=side_data -of json
mediainfo --Inform="Video;%Format% %BitDepth% %HDR_Format%" file.mov
mdls -name kMDItemCodecs file.mov
```

- Preserved: hevc yuv420p10le bt2020nc smpte2084/arib-std-b67 + DOVI dvhe.08.06 ~100-400MB/min 4K60
- Stripped: h264 yuv420p bt709 no DOVI 1/5-1/10 size
- Shared Album/iMessage: 1280x720 or 1920x1080 h264 bt709
- Optimize proxy: lower res small size dvvC missing
- Most Compatible: avc1 not hvc1/dvh1

Resolve: Clip Attributes -> Codec Resolution Data Levels Color Space; HDR checkbox only for HDR.

---

## 5. Validation Notes

- Verified via 108782, 111762, 108916, 116944/HT207022, HT201302, 121029, 6220791 (dates in matrix).
- Photos Guide export 429-blocked; inferred from HT207022 export paragraph.
- AirDrop 119857 rate-limited; implied from HT207022.
- WhatsApp Help CAPTCHA-blocked; blog + ffprobe corroboration.
- iOS27 full-res Shared Albums reported MacRumors 2026 not in 108916.

---

## 6. Recommendation for Resolve

- Gate ingest with ffprobe; reject h264/bt709/720p from Shared Albums/Messages/Photos Export/social -> re-request via Unmodified Original / AirDrop / Keep Originals USB / Drive file / WhatsApp Document
- Settings: iPhone Photos Transfer to Mac or PC Keep Originals; Photos File Export Unmodified Original; iCloud.com More Download Options Unmodified Original; never Shared Albums for HDR masters
- Hash verification md5 when possible

---

## Sources

1. Apple HT207022/116944 Using HEIF or HEVC media — 2025-12-05 — Keep Originals + AirDrop/Messages compatibility transcode
2. Apple 111762 Download iCloud photos and videos — 2026-04-10 — Unmodified Original vs Most Compatible
3. Apple 108782 Set up and use iCloud Photos — 2025-12-12 — original formats full resolution
4. Apple 108916 Shared Album limits — 2025-02-27 — 720p + disclaimer
5. Apple HT201302 Transfer photos to Mac or PC — 2026-05-19 — USB Keep Originals
6. Apple iPhone 16 Tech Specs 121029 — Dolby Vision HEVC/H.264
7. Google 6220791 Choose backup quality — Storage saver 1080p cap
8. Secondary ffprobe: Apple Discussions 255094959, GadgetHacks

---

## Risks / Unknowns

- No repo edits; matrix general; MDM may override
- color_transfer alone insufficient; check DOVI+pix_fmt+scopes
- Future iOS27 Shared Albums full-res will invalidate 720p guarantee
