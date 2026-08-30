# Third-party notices for the portable-toolchain attempt

This notice describes the **non-release** candidate produced by TODO 4. The
candidate remains under `build/portable-toolchain/` (ignored) and is not a
product bundle or a distributable binary. The release pipeline must add the
complete corresponding source offer and license texts before any GPL-linked
binary is published.

## Pinned inputs actually used

All downloaded inputs were fetched over HTTPS and SHA-256 checked before
extraction. The authoritative machine-readable list is
`scripts/toolchain/portable-toolchain-manifest.json`.

| Input | License/source notice | SHA-256 |
| --- | --- | --- |
| FFmpeg 9.0.1 source — `https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz` | FFmpeg LGPL-2.1-or-later; this build enables GPL components, so GPL-2.0-or-later terms also apply | `cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635` |
| libplacebo v7.351.0 — `https://code.videolan.org/videolan/libplacebo/-/archive/v7.351.0/libplacebo-v7.351.0.tar.gz` | LGPL-2.1-or-later | `4efe1c8d4da3c61295eb5fdfa50e6037409d8425eb3c15dd86788679c4ce59ee` |
| x264 pinned stable commit — `https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz` | GPL-2.0-or-later | `cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9` |
| Vulkan-Headers pinned commit — `https://github.com/KhronosGroup/Vulkan-Headers/archive/e3b1eec08173d6b825cd3ac88c885a63b621504a.tar.gz` | Apache-2.0 and MIT components; see the upstream `LICENSE.md` | `f492279345cbc10708b64fcd432b3ff6c8246a5837c4db2b649abba00cf82208` |
| MoltenVK 1.4.2 macOS archive — `https://github.com/KhronosGroup/MoltenVK/releases/download/v1.4.2/MoltenVK-macos.tar` | Apache-2.0; the candidate uses its universal static `libMoltenVK.a` | `f95765a6229cb7b915990a2890ce12ebe36a730b021545d3d52ae69ce4c4024e` |
| glslang 16.5.0 macOS universal SDK — `https://github.com/KhronosGroup/glslang/releases/download/16.5.0/glslang-16.5.0-macos-universal-release.tar.gz` | BSD-3-Clause upstream project notice | `0f0b8ae3873d1f182ecd1806cd1a10fee3f9965896a660b7a0bbe6bdd9e1f46d` |
| fast_float pinned submodule commit — `https://github.com/fastfloat/fast_float/archive/1bf70101536d37fa9954cc4f03fd0903d045a9f3.tar.gz` | Apache-2.0, Boost-1.0, and MIT files; see upstream license files | `95c7730f3db8bfb8568e26387bed5df5284158c408d2c6411ed8ad4f5a6dc9ae` |
| Jinja2 3.1.6 build source — `https://files.pythonhosted.org/packages/df/bf/f7da0350254c0ed7c72f3e33cef02e048281fec7ecec5f032d4aac52226b/jinja2-3.1.6.tar.gz` | BSD-3-Clause | `0137fb05990d35f1275a587e9aee6d56da821fc83491a0fb838183be43f66d6d` |
| MarkupSafe 3.0.3 build source — `https://files.pythonhosted.org/packages/7e/99/7690b6d4034fffd95959cbe0c02de8deb3098cc577c67bb6a24fe5d7caa7/markupsafe-3.0.3.tar.gz` | BSD-3-Clause | `722695808f4b6457b320fdc131280796bdceb04ab50fe1795cd540799ebe1698` |

The FFmpeg detached signature was also downloaded and SHA-256 checked:
`b613a00005232a1245ace7080088781ac23a916119d3e5b0d6c042368eee0177`.
Detached GPG verification was not claimed because GPG was unavailable on the
bounded host.

## Distribution obligations and exclusions

- FFmpeg was configured with `--enable-gpl` and statically linked with x264.
  A future distribution therefore needs the applicable GPL source offer,
  license texts, and corresponding FFmpeg/libx264 source for the exact binary.
- libplacebo, Vulkan-Headers, fast_float, MoltenVK, glslang, Jinja2, and
  MarkupSafe notices must accompany any distribution that includes their
  corresponding code or derived binary.
- No source archive, SDK archive, generated media, RPU, or candidate binary is
  committed by this attempt. No proprietary Dolby sample or metadata is part
  of the candidate.
- MoltenVK and glslang were consumed from official, hash-pinned release
  archives in this bounded attempt. This is not a claim that the release
  process is independently source-building those archives; that provenance
  and clean-host/notarization review remains a release gate.
