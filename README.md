# Resolve HDR to SDR

Metadata-driven HDR to Rec.709 SDR converter. Source HDR files are inspected, classified from container and bitstream metadata, and when eligible converted to a separate Rec.709 SDR copy. DaVinci Resolve Workflow Integration is only the host panel and drop target — the source never has to enter Resolve.

> Status: development shell with local verification. Visual correctness beyond mechanical checks has not been human-validated on a calibrated Rec.709 display.

## What it does

- Drop a local `.mov` / `.mp4` into the panel
- Inspect without modifying the source (reads `colr`/`nclx`, VUI, `mdcv`/`clli`, `dvvC`/`dvcC`, RPU)
- For eligible files, create a separate Rec.709 SDR output via a frozen `libplacebo` graph
- Verify the output (`verify-spike.sh`) and drag the verified file to the Resolve Media Pool or timeline with a native OS drag (`webContents.startDrag`)

No iPhone-only restriction. The two iPhone HLG samples in `Sample/` are test material, not a product limit.

## Supported inputs — verified behavior only

Classification is a pure function (`prototype/classifier.py` + `electron/b-profile.cjs`). No silent fallback.

| Classification | `canConvert` | Profile | When |
|---|---|---|---|
| `hlgKnownLocal` | true | `hlg-local-b-v1` | Both local samples exactly: SHA `46dad3…8593` (18,423,719) + SHA `2780c7…4a82a` (20,313,976) with full HLG evidence (`bt2020nc`/`arib-std-b67`/`bt2020`, `tv`, `yuv420p10le`, `hvc1`/`hevc`, `dv_profile 8 / compat 4 HLG`, no `mdcv`/`clli`) |
| `hlgSupported` | true | `hlg-rec709-v1` | Generic non-Dolby HLG: `parse_ok`, not `unspecified`/`contradictory`, `bt2020nc` + `arib-std-b67` + `bt2020`, `tv`, `≥10-bit YUV` allowlist (`yuv420p10le`, `yuv422p10le`, `yuv444p10le`, `p12` variants), `has_dovi=false` |
| `pqSupported` | true | `pq-rec709-v1` | Narrow static HDR10/PQ: `parse_ok`, not `unspecified`/`contradictory`, `bt2020nc`/`smpte2084`/`bt2020` + `tv`, same `≥10-bit` allowlist, `has_dovi=false`, `has_hdr10plus=false`, **both `MDCV` and `CLLI` present** (checked on stream `side_data_list` and a bounded initial probe interval via `-read_intervals %+#1`) |
| `pqHdr10Unsupported` | false | — | PQ detected but fails narrow gate (missing MDCV/CLLI, wrong pix_fmt, HDR10+ detected, etc.) |
| `dolbyVisionUnsupported` | false | — | Dolby Vision detected and not the two allowlisted HLG samples (takes precedence over PQ) |
| `uncertain` | false | — | Missing / contradictory / unknown / malformed metadata — fail-closed |

Dolby Vision expansion and HDR10+ dynamic (`st2094-40`) are not converted (fail-closed). Any `unspecified` (`2/2/2`) or contradictory `colr`/VUI/RPU causes `uncertain` and no conversion.

## Requirements

- macOS with DaVinci Resolve Studio (Workflow Integration host) for the Resolve panel; standalone Electron dev shell runs without Resolve
- Python 3.10+ (3.14 tested), standard library only
- `ffmpeg` / `ffprobe` with `libplacebo` (`ffmpeg-full` 9.x + `molten-vk` on macOS). Repo expects `tools/ffmpeg` and `tools/ffprobe` to resolve to the verified libplacebo build — see `tools/PROVENANCE.txt`. Runtime scripts use only these repo-local tool paths.
- Node 20+ and `electron@41.10.3` (dev dependency). No other npm dependencies

## Installation

```bash
git clone https://github.com/Srcanesen/resolve-hdr-to-sdr.git
cd resolve-hdr-to-sdr
npm install          # installs electron@41.10.3
# verify tools point to executable libplacebo binaries; no download/PATH fallback
npm run doctor
ls -l tools/ffmpeg tools/ffprobe
```

## Usage

### Electron dev shell (inspect + convert + drag)

```bash
HDRTOSDR_PYTHON="$(command -v python3)" npm start
# optional: HDRTOSDR_BACKEND_ROOT must be absolute if set; otherwise repo root is used
```

1. Drop a file onto the panel or use `Choose file` (file picker). The UI shows `Inspecting video…`
2. If eligible: `Ready to convert` → `Convert HDR → SDR` → confirm `Convert` (`Convert HDR → SDR` dialog)
3. Progress: `Preparing conversion…` / `Converting HDR → SDR…` / `Verifying output…` (cancel with `Cancel` if needed)
4. On `Output ready` drag `Drag to Resolve` to the Resolve Media Pool or timeline. Outside Resolve the button is keyboard accessible (`draggable="true"`) but only does an OS file drag.

For inspection only (no conversion):

```bash
echo '{"version":1,"path":"'"$(realpath Sample/1.MOV)"'"}' | python3 prototype/inspect_cli.py
```

### Python prototype (loopback only)

```bash
python3 -m prototype                    # http://127.0.0.1:8765
python3 -m prototype --port 8766
```

Only accepts absolute local paths under `Sample/` after `resolve(strict=True)`, extension `.mov`/`.mp4`, regular file, no symlink escape, no size cap. Browser upload via `POST /api/inspect-upload` is raw `application/octet-stream` with `Content-Length` cap 32 MiB, sanitized `X-Filename`, `0700` temp dir / `0600` file, always deleted. No path / ffprobe stderr / GPS / raw bytes in responses.

### Workflow Integration developer bundle

```bash
npm run bundle:resolve
# output: build/workflow-integration/com.hdrtosdr.app/
# verify the explicit allowlist, regular files, and no symlink cycle:
node scripts/bundle-audit.cjs "$PWD/build/workflow-integration/com.hdrtosdr.app"
```

The bundle is self-contained and never auto-installs. Manual copy to the Resolve plugins folder is required for host smoke. Inside Resolve it runs the lifecycle `Initialize('com.hdrtosdr.app')` → `SetAPITimeout(10)` → `RegisterCallback('ResolveQuit')` → `CleanUp` on quit, with `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`.

### Scripts

```bash
npm test            # python + electron tests
npm run check       # alias for both suites
npm run bundle:resolve

scripts/verify-spike.sh <source> <output> <profileId>
# checks source!=output, timing/frame/dimension preservation, documented audio policy,
# Rec.709 tags, bounded HDR evidence, and semantic privacy tags
```

## Outputs

Electron conversion (via `b-profile.cjs`, routed strictly by `profileId`):

- `hlg-local-b-v1`: `libplacebo=tonemapping=spline:tonemapping_param=0.45:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le,eq=gamma=0.90`
- `hlg-rec709-v1` / `pq-rec709-v1`: `libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le`

Wrapped as H.264 High, `yuv420p`, `bt709`/`tv`, `+faststart+write_colr` MP4 with AAC 192k, `preset medium CRF 18`. Names preserve safe Unicode letters/marks/numbers/emoji where possible and exclude path/control/reserved characters; `<stem>_sdr_rec709_h264_<profile>.mp4` is created under a `0700` output root with `0600` files via atomic staging with `EEXIST` retry. It never overwrites source or an existing output (`-n` + hard-link commit). Every source audio stream is retained in order and re-encoded as AAC at the locked 192k target; inputs without audio produce outputs with no audio track. The verifier checks presentation dimensions, decoded video-frame count, duration, audio-stream count/codec/channel shape, and Rec.709 tags before a SHA-256 fingerprint is recorded for the committed file. Failed staging unlink cleanup emits a generic warning and runs a bounded scavenger that removes only generated private staging names under the strict output root. Output thumbnails are bounded and decode-validated before use, with bounded owner-scoped fingerprint caching and concurrent-request deduplication.

Research spikes under `Output/spike/` historically used ProRes LT — not the Electron path.

## Limitations

- No Dolby Vision or HDR10+ conversion. Those classifications return `canConvert:false` with a safe reason.
- Requires positive, exact metadata. `Unspecified` / `2/2/2` or contradictory `colr` vs VUI is `uncertain` (no conversion).
- PQ requires **both** MDCV and CLLI (stream + bounded initial probe interval). Missing one is unsupported.
- Mechanical verifier checks Rec.709 tags, presentation dimensions, timing, frame counts, the documented audio policy, and semantic privacy tags, but **not visual correctness**. HDR side-data scanning is bounded to the first 32 decoded video frames/stream evidence; it does not prove that later packets are HDR-free. Calibrated Rec.709 human A/B is still required.
- Electron `libplacebo` needs a Vulkan runtime (`molten-vk` on macOS). Vulkan errors surface as a generic conversion failure with no fallback.
- The prototype web server is `127.0.0.1` only and sample-root-restricted; it is not a generic file handler.
- Only `.mov` / `.mp4` regular files; symlinks, directories, and size-unknown uploads are rejected.
- An output-root symlink or permission failure is rejected with a safe UI message; the app does not silently redirect output elsewhere.

## Troubleshooting

- `HDRTOSDR_PYTHON` not set or not absolute → startup shows a generic configuration error (never leaks PATH). Set `HDRTOSDR_PYTHON="$(command -v python3)"`.
- `npm run doctor` fails → provide verified executable targets at `tools/ffmpeg` and `tools/ffprobe`; the doctor does not install or use `PATH`.
- `ffmpeg` without `libplacebo` → converter fails closed with a generic failure; install `ffmpeg-full` + `molten-vk` through your trusted provisioning process and rerun the doctor.
- `Vulkan VK_ERROR_INCOMPATIBLE_DRIVER` → install `molten-vk`; no fallback graph is used.
- `unspecified_metadata` / `contradictory_metadata` → check source `ffprobe` `color_space`/`color_transfer`/`color_primaries`; file is intentionally not converted.
- `verify-spike.sh` timing failure → ensure source and output duration/frame counts match within 0.05 s; re-run ffprobe.

## Security posture

- No shell: all `ffprobe`/`ffmpeg` calls via `spawn([...], {shell:false})` with `tools/ffprobe` resolved as an absolute executable; no `PATH` fallback leakage
- Inspector uses a bounded `-read_intervals %+#1 -show_frames` initial probe interval for side-data evidence; no raw frame leak
- Responses are privacy-filtered: only `displayName`, `size`, `sha256`, permitted color fields, `classification`/`reason`/`profileId`/`canConvert` — no raw paths, ffprobe stderr, GPS, or bytes
- Electron: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `webSecurity:true` via `secure-window.cjs`; renderer never receives filesystem paths
- Drag and thumbnails are gated strictly on verified outputs: opaque `outputId`, revalidated owner `webContents.id`, canonical non-symlink containment (`outputStore.isSafeOutputFile`), `TOCTOU` `realpath` equality, current SHA-256/size fingerprint, and a 32×32 non-empty `NativeImage` for drag; thumbnail bytes are decode-validated, oversized output fails closed, and the bounded owner/fingerprint cache is invalidated on changes or owner cleanup
- HTTP prototype: `127.0.0.1` only, explicit CSP and `no-store`, no arbitrary path serving

## Contributing

Issues and pull requests welcome. Please run `npm run check` and `npm audit` locally, keep commits focused, and avoid staging ignored artifacts (`Output/`, `Sample/`, `build/`, `node_modules/`, symlinked tools). No project-specific commit style is enforced.

## Security reporting

Do not open a public issue for sensitive vulnerabilities. Please use the repository’s private security advisory flow or contact the maintainers through GitHub’s private reporting. No private email is required.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

FFmpeg `libplacebo` / Vulkan (`molten-vk`) and the `zscale` fallback paths are documented in `docs/research/conversion-spike-2026-08-25.md` and `tools/PROVENANCE.txt`. DaVinci Resolve is a trademark of Blackmagic Design.
