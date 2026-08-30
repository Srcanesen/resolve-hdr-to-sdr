#!/usr/bin/env bash
set -euo pipefail

# Bounded, repo-local macOS toolchain attempt. It never writes tools/ or a
# workflow bundle; all state stays below build/portable-toolchain/.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT_DIR/scripts/toolchain/portable-toolchain-manifest.json"
WORK="$ROOT_DIR/build/portable-toolchain"
DOWNLOADS="$WORK/downloads"
SOURCES="$WORK/sources"
TOOLS="$WORK/bootstrap"
PREFIXES="$WORK/prefixes"
ARCH_BUILDS="$WORK/arch"
OUT="$WORK/out/tools"
LOG="$WORK/build.log"
STATUS="$WORK/status.txt"
JOBS="${JOBS:-2}"
MACOS_MIN="${MACOS_MIN:-12.0}"
BUILD_PYTHON="/usr/local/bin/python3"
STAGE="initializing"

fail() {
  echo "portable-toolchain: ERROR: $*" >&2
  exit 1
}

status() {
  STAGE="$1"
  printf 'stage=%s\nreleaseStatus=non-release\n' "$STAGE" > "$STATUS"
  echo "portable-toolchain: $STAGE" >&2
}

on_exit() {
  local code=$?
  printf 'stage=%s\nexit=%s\nreleaseStatus=non-release\n' "$STAGE" "$code" > "$STATUS"
  if [ "$code" -ne 0 ]; then
    echo "portable-toolchain: stopped at $STAGE (exit $code); no repo tools changed" >&2
  fi
}
trap on_exit EXIT
mkdir -p "$WORK"

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is missing: $1"
}

manifest_rows() {
  python3 - "$MANIFEST" <<'PY'
import json
import re
import sys
from pathlib import PurePosixPath

manifest_path = sys.argv[1]
with open(manifest_path, encoding='utf-8') as fh:
    doc = json.load(fh)
if doc.get('releaseStatus') != 'non-release' or doc.get('policy', {}).get('releaseEnabled') is not False:
    raise SystemExit('manifest must remain explicitly non-release')
artifacts = doc.get('artifacts')
if not artifacts:
    raise SystemExit('manifest has no artifacts')
for item in artifacts:
    name = item.get('name', '')
    url = item.get('url', '')
    digest = item.get('sha256', '')
    filename = item.get('filename', '')
    if not item.get('official'):
        raise SystemExit(f'{name}: official/maintainer source URL is required')
    if not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise SystemExit(f'{name}: invalid SHA-256')
    if not url.startswith('https://'):
        raise SystemExit(f'{name}: HTTPS URL required')
    if any(token in url.lower() for token in ('/latest', '/master', '/main', '/head', '?ref=')):
        raise SystemExit(f'{name}: moving URL is forbidden: {url}')
    if PurePosixPath(filename).name != filename or not filename:
        raise SystemExit(f'{name}: unsafe filename')
    print(f'{name}\t{filename}\t{url}\t{digest}')
PY
}

# Fail-closed archive member validation. Treats pinned official archives as
# untrusted input. Allows only regular files, directories, and safe internal
# relative symlink/hardlink members. Rejects FIFO/device/other types, absolute
# paths, ".." traversal, and backslash escapes before extraction. Bounded:
# only header metadata is inspected, not file contents.
validate_tar_members() {
  local archive="$1"
  python3 - "$archive" <<'PY'
import sys
import tarfile
from pathlib import PurePosixPath
archive = sys.argv[1]
try:
    tf = tarfile.open(archive, 'r:*')
except Exception as exc:
    print(f"tar open failed for {archive}: {exc}", file=sys.stderr)
    sys.exit(1)
allowed_types = (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE)
for member in tf.getmembers():
    name = member.name
    linkname = member.linkname or ""
    if member.type not in allowed_types:
        print(f"archive member unsupported type {member.type!r}: {name!r}", file=sys.stderr)
        sys.exit(1)
    if "\\" in name:
        print(f"archive member contains backslash: {name!r}", file=sys.stderr)
        sys.exit(1)
    if "\\" in linkname:
        print(f"archive linkname contains backslash: {name!r} -> {linkname!r}", file=sys.stderr)
        sys.exit(1)
    if name.startswith("/") or linkname.startswith("/"):
        print(f"archive member absolute path: {name!r} -> {linkname!r}", file=sys.stderr)
        sys.exit(1)
    if PurePosixPath(name).is_absolute() or (linkname and PurePosixPath(linkname).is_absolute()):
        print(f"archive member absolute path (posix): {name!r} -> {linkname!r}", file=sys.stderr)
        sys.exit(1)
    parts = name.split("/")
    if ".." in parts:
        print(f"archive member traversal: {name!r}", file=sys.stderr)
        sys.exit(1)
    if linkname and ".." in linkname.split("/"):
        print(f"archive linkname traversal: {name!r} -> {linkname!r}", file=sys.stderr)
        sys.exit(1)
    if member.issym() or member.islnk() or member.type in (tarfile.SYMTYPE, tarfile.LNKTYPE):
        # Allow only safe internal relative symlinks/hardlinks. Reject those
        # that could escape via absolute path, traversal, or backslash.
        if chr(92) in linkname:
            print(f"archive linkname backslash: {name!r} -> {linkname!r}", file=sys.stderr)
            sys.exit(1)
        if linkname.startswith("/") or (linkname and PurePosixPath(linkname).is_absolute()):
            print(f"archive linkname absolute: {name!r} -> {linkname!r}", file=sys.stderr)
            sys.exit(1)
        if linkname and ".." in linkname.split("/"):
            print(f"archive linkname traversal: {name!r} -> {linkname!r}", file=sys.stderr)
            sys.exit(1)
        # Safe internal link (e.g., MoltenVK dylib -> dynamic/dylib) is allowed.
        continue
PY
}

validate_zip_members() {
  local archive="$1"
  python3 - "$archive" <<'PY'
import sys
import zipfile
from pathlib import PurePosixPath
archive = sys.argv[1]
try:
    zf = zipfile.ZipFile(archive, 'r')
except Exception as exc:
    print(f"zip open failed for {archive}: {exc}", file=sys.stderr)
    sys.exit(1)
for info in zf.infolist():
    name = info.filename
    if "\\" in name:
        print(f"zip member backslash: {name!r}", file=sys.stderr)
        sys.exit(1)
    if name.startswith("/") or name.startswith("\\"):
        print(f"zip member absolute path: {name!r}", file=sys.stderr)
        sys.exit(1)
    if PurePosixPath(name).is_absolute():
        print(f"zip member absolute (posix): {name!r}", file=sys.stderr)
        sys.exit(1)
    stripped = name.rstrip("/")
    if stripped:
        parts = stripped.split("/")
        if ".." in parts:
            print(f"zip member traversal: {name!r}", file=sys.stderr)
            sys.exit(1)
    mode = (info.external_attr >> 16) & 0o170000
    if mode == 0o120000:
        # Zip symlink target is stored as file data. Allow only safe internal
        # relative targets (e.g., wheel symlinks), reject those that could escape.
        try:
            target = zf.read(name).decode('utf-8', errors='ignore')
        except Exception:
            target = ""
        if chr(92) in target or chr(92) in name:
            print(f"zip symlink backslash: {name!r} -> {target!r}", file=sys.stderr)
            sys.exit(1)
        if target.startswith("/") or (target and PurePosixPath(target).is_absolute()):
            print(f"zip symlink absolute: {name!r} -> {target!r}", file=sys.stderr)
            sys.exit(1)
        if target and ".." in target.split("/"):
            print(f"zip symlink traversal: {name!r} -> {target!r}", file=sys.stderr)
            sys.exit(1)
        # Safe internal symlink is allowed.
        continue
    if mode != 0 and mode not in (0o100000, 0o040000, 0o120000):
        # Any other non-regular, non-directory unix file type (fifo, device…) is unsafe.
        # mode 0 means no unix attributes (Windows-created); allowed if name checks pass.
        if mode != 0o120000:
            # Re-check symlink already handled; other unexpected types fail.
            is_unexpected = mode not in (0o100000, 0o040000)
            if is_unexpected:
                print(f"zip member unexpected file type {oct(mode)}: {name!r}", file=sys.stderr)
                sys.exit(1)
PY
}

# Low-risk manifest hash lookup: avoids duplicating SHA-256 literals in
# shell. Filenames remain explicit to preserve extraction ordering and
# 3rdparty wiring; only the hash values are sourced from the manifest.
manifest_sha_for() {
  local wanted="$1"
  awk -F'\t' -v want="$wanted" '$2==want{print $4; found=1; exit} END{if(!found) exit 1}' "$MANIFEST_ROWS"
}

verify_or_fetch() {
  local name="$1" filename="$2" url="$3" expected="$4"
  local destination="$DOWNLOADS/$filename"
  mkdir -p "$DOWNLOADS"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ -f "$destination" ] && [ ! -L "$destination" ] || fail "$name: cached download is not a regular file"
    local actual
    actual="$(shasum -a 256 "$destination" | awk '{print $1}')"
    [ "$actual" = "$expected" ] || fail "$name: cached SHA-256 mismatch (refusing to replace it)"
    echo "portable-toolchain: verified cached $name ($expected)" >&2
    return
  fi
  local partial="$destination.part.$$"
  rm -f "$partial"
  echo "portable-toolchain: downloading pinned $name" >&2
  curl --fail --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 900 \
    "$url" --output "$partial"
  local actual
  actual="$(shasum -a 256 "$partial" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    rm -f "$partial"
    fail "$name: downloaded SHA-256 mismatch (expected $expected, got $actual)"
  fi
  mv "$partial" "$destination"
  echo "portable-toolchain: downloaded and verified $name ($expected)" >&2
}

extract_single_root() {
  local archive="$1" target="$2"
  local marker="$target/.source-sha256"
  local digest="$3"
  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$digest" ]; then
    echo "portable-toolchain: using verified extracted $(basename "$target")" >&2
    return
  fi
  rm -rf "$target" "$target.extract.$$"
  mkdir -p "$target.extract.$$"
  validate_tar_members "$archive"
  tar -xf "$archive" -C "$target.extract.$$"
  local roots
  roots="$(find "$target.extract.$$" -mindepth 1 -maxdepth 1 -type d -print)"
  [ "$(printf '%s\n' "$roots" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] \
    || fail "archive does not have exactly one top-level directory: $archive"
  local root
  root="$(printf '%s\n' "$roots")"
  mv "$root" "$target"
  rmdir "$target.extract.$$"
  printf '%s\n' "$digest" > "$marker"
}

extract_flat_archive() {
  local archive="$1" target="$2" digest="$3"
  local marker="$target/.archive-sha256"
  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$digest" ]; then
    echo "portable-toolchain: using verified extracted $(basename "$target")" >&2
    return
  fi
  rm -rf "$target"
  mkdir -p "$target"
  validate_tar_members "$archive"
  tar -xf "$archive" -C "$target"
  printf '%s\n' "$digest" > "$marker"
}

extract_wheel() {
  local archive="$1" target="$2" digest="$3"
  local marker="$target/.archive-sha256"
  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$digest" ]; then
    echo "portable-toolchain: using verified extracted $(basename "$target")" >&2
    return
  fi
  rm -rf "$target"
  mkdir -p "$target"
  validate_zip_members "$archive"
  unzip -q "$archive" -d "$target"
  printf '%s\n' "$digest" > "$marker"
}

status "preflight"
[ "$(uname -s)" = "Darwin" ] || fail "this implementation is macOS-only"
[ "$(uname -m)" = "arm64" ] || fail "the bounded cross-build host must be arm64"
[ -f "$MANIFEST" ] || fail "missing source manifest: $MANIFEST"
for command in curl shasum tar unzip python3 clang clang++ ar ranlib strip make cmake pkg-config xcrun lipo otool codesign; do
  require_command "$command"
done
require_command "$BUILD_PYTHON"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
[ -d "$SDKROOT" ] || fail "macOS SDK was not found"
mkdir -p "$WORK" "$SOURCES" "$TOOLS" "$PREFIXES" "$ARCH_BUILDS" "$OUT"

status "download-verification"
MANIFEST_ROWS="$WORK/manifest.rows"
manifest_rows > "$MANIFEST_ROWS"
while IFS=$'\t' read -r name filename url sha; do
  verify_or_fetch "$name" "$filename" "$url" "$sha"
done < "$MANIFEST_ROWS"

# No archive is extracted until every manifest download has passed SHA-256.
status "source-extraction"
# Hashes are sourced from the manifest at extraction time to avoid duplicating
# SHA-256 literals in shell. Filename literals remain explicit to preserve
# extraction ordering and 3rdparty wiring without broadening archive logic.
# Remaining duplication note: filename strings (e.g., "ffmpeg-9.0.1.tar.xz")
# are intentionally kept as explicit arguments; converting the entire
# extraction plan to a manifest-driven loop would broaden scope and risk
# reordering or omitting the manual 3rdparty fixups.
FFMPEG_SHA="$(manifest_sha_for "ffmpeg-9.0.1.tar.xz")"
LIBPLACEBO_SHA="$(manifest_sha_for "libplacebo-v7.351.0.tar.gz")"
X264_SHA="$(manifest_sha_for "x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz")"
VULKAN_HEADERS_SHA="$(manifest_sha_for "Vulkan-Headers-e3b1eec08173d6b825cd3ac88c885a63b621504a.tar.gz")"
MVK_SHA="$(manifest_sha_for "MoltenVK-macos.tar")"
GLSLANG_SHA="$(manifest_sha_for "glslang-16.5.0-macos-universal-release.tar.gz")"
FAST_FLOAT_SHA="$(manifest_sha_for "fast_float-1bf70101536d37fa9954cc4f03fd0903d045a9f3.tar.gz")"
JINJA2_SHA="$(manifest_sha_for "jinja2-3.1.6.tar.gz")"
MARKUPSAFE_SHA="$(manifest_sha_for "markupsafe-3.0.3.tar.gz")"
MESON_SHA="$(manifest_sha_for "meson-1.12.0-py3-none-any.whl")"
NINJA_SHA="$(manifest_sha_for "ninja-1.13.0-py3-none-macosx_10_9_universal2.whl")"
extract_single_root "$DOWNLOADS/ffmpeg-9.0.1.tar.xz" "$SOURCES/ffmpeg" "$FFMPEG_SHA"
extract_single_root "$DOWNLOADS/libplacebo-v7.351.0.tar.gz" "$SOURCES/libplacebo" "$LIBPLACEBO_SHA"
extract_single_root "$DOWNLOADS/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz" "$SOURCES/x264" "$X264_SHA"
extract_single_root "$DOWNLOADS/Vulkan-Headers-e3b1eec08173d6b825cd3ac88c885a63b621504a.tar.gz" "$SOURCES/vulkan-headers" "$VULKAN_HEADERS_SHA"
rm -rf "$SOURCES/libplacebo/3rdparty/Vulkan-Headers"
cp -R "$SOURCES/vulkan-headers" "$SOURCES/libplacebo/3rdparty/Vulkan-Headers"
extract_single_root "$DOWNLOADS/MoltenVK-macos.tar" "$SOURCES/MoltenVK" "$MVK_SHA"
extract_flat_archive "$DOWNLOADS/glslang-16.5.0-macos-universal-release.tar.gz" "$SOURCES/glslang" "$GLSLANG_SHA"
extract_single_root "$DOWNLOADS/fast_float-1bf70101536d37fa9954cc4f03fd0903d045a9f3.tar.gz" "$SOURCES/fast_float" "$FAST_FLOAT_SHA"
extract_single_root "$DOWNLOADS/jinja2-3.1.6.tar.gz" "$SOURCES/jinja2" "$JINJA2_SHA"
extract_single_root "$DOWNLOADS/markupsafe-3.0.3.tar.gz" "$SOURCES/markupsafe" "$MARKUPSAFE_SHA"
rm -rf "$SOURCES/libplacebo/3rdparty/fast_float"
cp -R "$SOURCES/fast_float" "$SOURCES/libplacebo/3rdparty/fast_float"
rm -rf "$SOURCES/libplacebo/3rdparty/jinja/src/jinja2" "$SOURCES/libplacebo/3rdparty/markupsafe/src/markupsafe"
mkdir -p "$SOURCES/libplacebo/3rdparty/jinja/src" "$SOURCES/libplacebo/3rdparty/markupsafe/src"
cp -R "$SOURCES/jinja2/src/jinja2" "$SOURCES/libplacebo/3rdparty/jinja/src/jinja2"
cp -R "$SOURCES/markupsafe/src/markupsafe" "$SOURCES/libplacebo/3rdparty/markupsafe/src/markupsafe"
extract_wheel "$DOWNLOADS/meson-1.12.0-py3-none-any.whl" "$TOOLS/meson" "$MESON_SHA"
extract_wheel "$DOWNLOADS/ninja-1.13.0-py3-none-macosx_10_9_universal2.whl" "$TOOLS/ninja" "$NINJA_SHA"

status "build-tool-bootstrap"
MESON_PYTHONPATH="$TOOLS/meson"
NINJA_BIN="$TOOLS/ninja/ninja-1.13.0.data/scripts/ninja"
MESON_BIN="$TOOLS/meson-bin"
mkdir -p "$TOOLS/bin"
cat > "$MESON_BIN" <<EOF
#!/usr/bin/env bash
exec "$BUILD_PYTHON" -m mesonbuild.mesonmain "\$@"
EOF
chmod +x "$MESON_BIN" "$NINJA_BIN"
export PYTHONPATH="$MESON_PYTHONPATH${PYTHONPATH:+:$PYTHONPATH}"
export PATH="$TOOLS/bin:$TOOLS:/usr/local/bin:/usr/bin:/bin:$PATH"
cp "$NINJA_BIN" "$TOOLS/bin/ninja"
chmod +x "$TOOLS/bin/ninja"
"$MESON_BIN" --version
"$TOOLS/bin/ninja" --version

MVK_A="$(find "$SOURCES/MoltenVK" -type f -path '*/macos-arm64_x86_64/libMoltenVK.a' -print -quit)"
[ -f "$MVK_A" ] || fail "pinned MoltenVK archive did not contain the universal static macOS archive"
MVK_ARCHS="$(lipo -archs "$MVK_A")"
case " $MVK_ARCHS " in *' arm64 '*|*' arm64') ;; *) fail "MoltenVK static archive lacks arm64 slice: $MVK_ARCHS" ;; esac
case " $MVK_ARCHS " in *' x86_64 '*|*' x86_64') ;; *) fail "MoltenVK static archive lacks x86_64 slice: $MVK_ARCHS" ;; esac
GLSLANG_INCLUDE="$SOURCES/glslang/include"
GLSLANG_LIB="$SOURCES/glslang/lib"
[ -f "$GLSLANG_INCLUDE/glslang/build_info.h" ] || fail "pinned glslang archive has no headers"
[ -f "$GLSLANG_LIB/libSPIRV.a" ] || fail "pinned glslang archive has no static SPIRV library"

make_prefix_pc() {
  local prefix="$1" arch="$2"
  local pcdir="$prefix/lib/pkgconfig"
  mkdir -p "$pcdir"
  cat > "$pcdir/vulkan.pc" <<EOF
prefix=$prefix
exec_prefix=\${prefix}
libdir=$prefix/lib
includedir=$SOURCES/libplacebo/3rdparty/Vulkan-Headers/include

Name: Vulkan
Description: pinned MoltenVK static Vulkan implementation
Version: 1.4.2
Libs: -L$prefix/lib -lMoltenVK -framework Metal -framework Foundation -framework AppKit -framework QuartzCore -framework CoreGraphics -framework CoreVideo -framework IOSurface -framework IOKit -framework CoreFoundation -lc++
Cflags: -I\${includedir}
EOF
  # Meson finds these by library name; the copies remain build-cache inputs.
  cp "$MVK_A" "$prefix/lib/libMoltenVK.a"
  cp "$GLSLANG_LIB"/*.a "$prefix/lib/"
}

build_x264() {
  local arch="$1" host="$2"
  local prefix="$PREFIXES/$arch/x264"
  local source="$ARCH_BUILDS/$arch/x264-src"
  mkdir -p "$ARCH_BUILDS/$arch"
  if [ ! -f "$prefix/lib/libx264.a" ]; then
    rm -rf "$source"
    cp -R "$SOURCES/x264" "$source"
    mkdir -p "$prefix"
    (cd "$source" && \
      CC=clang AR=ar RANLIB=ranlib STRIP=strip \
      CFLAGS="-arch $arch -mmacosx-version-min=$MACOS_MIN" \
      ./configure --host="$host" --prefix="$prefix" --enable-static \
        --disable-cli --disable-asm --disable-opencl)
    (cd "$source" && make -j"$JOBS" && make install)
  fi
  [ -f "$prefix/lib/libx264.a" ] || fail "x264 did not produce a static library for $arch"
}

build_libplacebo() {
  local arch="$1"
  local prefix="$PREFIXES/$arch/libplacebo"
  local pcpath="$prefix/lib/pkgconfig"
  local builddir="$ARCH_BUILDS/$arch/libplacebo"
  local crossfile="$ARCH_BUILDS/$arch/libplacebo-cross.txt"
  local wrapperdir="$ARCH_BUILDS/$arch/compiler-wrapper"
  local cpp_wrapper="$wrapperdir/clang++"
  local pkg_config_bin="$(command -v pkg-config)"
  local meson_cpu_family="x86_64" meson_cpu="x86_64"
  [ "$arch" = "arm64" ] && meson_cpu_family="aarch64" && meson_cpu="arm64"
  mkdir -p "$prefix/lib" "$prefix/include"
  make_prefix_pc "$prefix" "$arch"
  if [ ! -f "$prefix/lib/libplacebo.a" ]; then
    rm -rf "$builddir" "$wrapperdir"
    mkdir -p "$wrapperdir"
    cat > "$cpp_wrapper" <<EOF
#!/usr/bin/env bash
if printf '%s\\n' "\$@" | grep -Eq -- '^-{1,2}print-search-dirs$'; then
  /usr/bin/clang++ "\$@" | sed 's|^libraries: =|libraries: =$GLSLANG_LIB:$prefix/lib:|'
  exit \${PIPESTATUS[0]}
fi
exec /usr/bin/clang++ -L$GLSLANG_LIB -L$prefix/lib "\$@"
EOF
    chmod +x "$cpp_wrapper"
    cat > "$crossfile" <<EOF
[binaries]
c = 'clang'
cpp = '$cpp_wrapper'
pkgconfig = '$pkg_config_bin'
ar = 'ar'
strip = 'strip'
ranlib = 'ranlib'

[host_machine]
system = 'darwin'
cpu_family = '$meson_cpu_family'
cpu = '$meson_cpu'
endian = 'little'

[built-in options]
c_args = ['-arch', '$arch', '-mmacosx-version-min=$MACOS_MIN', '-I$GLSLANG_INCLUDE']
cpp_args = ['-arch', '$arch', '-mmacosx-version-min=$MACOS_MIN', '-I$GLSLANG_INCLUDE']
c_link_args = ['-arch', '$arch', '-mmacosx-version-min=$MACOS_MIN', '-L$GLSLANG_LIB', '-L$prefix/lib']
cpp_link_args = ['-arch', '$arch', '-mmacosx-version-min=$MACOS_MIN', '-L$GLSLANG_LIB', '-L$prefix/lib']
EOF
    export PKG_CONFIG_PATH="$pcpath"
    export CFLAGS="-arch $arch -mmacosx-version-min=$MACOS_MIN -I$GLSLANG_INCLUDE"
    export CXXFLAGS="$CFLAGS"
    export LDFLAGS="-arch $arch -mmacosx-version-min=$MACOS_MIN -L$GLSLANG_LIB -L$prefix/lib"
    "$MESON_BIN" setup "$builddir" "$SOURCES/libplacebo" --cross-file "$crossfile" \
      --buildtype=release --prefix="$prefix" \
      -Ddefault_library=static -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false \
      -Dopengl=disabled -Dunwind=disabled -Dlcms=disabled -Dlibdovi=disabled -Dxxhash=disabled \
      -Dshaderc=disabled -Dglslang=enabled -Dvulkan=enabled -Dvk-proc-addr=enabled \
      -Dvulkan-registry="$SOURCES/libplacebo/3rdparty/Vulkan-Headers/registry/vk.xml"
    "$MESON_BIN" compile -C "$builddir" -j "$JOBS"
    "$MESON_BIN" install -C "$builddir"
  fi
  [ -f "$prefix/lib/libplacebo.a" ] || fail "libplacebo did not produce a static library for $arch"
}

build_ffmpeg() {
  local arch="$1"
  local prefix="$PREFIXES/$arch/ffmpeg"
  local source="$ARCH_BUILDS/$arch/ffmpeg-src"
  local xprefix="$PREFIXES/$arch/x264"
  local lprefix="$PREFIXES/$arch/libplacebo"
  local ffarch="$arch"
  [ "$arch" = "arm64" ] && ffarch="aarch64"
  if [ ! -x "$prefix/bin/ffmpeg" ] || [ ! -x "$prefix/bin/ffprobe" ]; then
    rm -rf "$source"
    cp -R "$SOURCES/ffmpeg" "$source"
    mkdir -p "$prefix"
    export PKG_CONFIG_PATH="$xprefix/lib/pkgconfig:$lprefix/lib/pkgconfig"
    export CFLAGS="-arch $arch -mmacosx-version-min=$MACOS_MIN -I$GLSLANG_INCLUDE"
    export CXXFLAGS="$CFLAGS"
    export LDFLAGS="-arch $arch -mmacosx-version-min=$MACOS_MIN -L$GLSLANG_LIB -L$xprefix/lib -L$lprefix/lib"
    (cd "$source" && \
      ./configure \
        --prefix="$prefix" --arch="$ffarch" --target-os=darwin \
        --cc=clang --cxx=clang++ --ar=ar --ranlib=ranlib --strip=strip \
        --enable-cross-compile --disable-autodetect --disable-x86asm \
        --enable-gpl --enable-libx264 --enable-libplacebo --enable-vulkan \
        --enable-static --disable-shared --disable-debug --disable-doc --disable-ffplay \
        --pkg-config-flags=--static \
        --extra-cflags="$CFLAGS" --extra-cxxflags="$CXXFLAGS" --extra-ldflags="$LDFLAGS")
    (cd "$source" && make -j"$JOBS" && make install)
  fi
  [ -x "$prefix/bin/ffmpeg" ] || fail "ffmpeg did not build for $arch"
  [ -x "$prefix/bin/ffprobe" ] || fail "ffprobe did not build for $arch"
}

status "x264-build"
mkdir -p "$PREFIXES/arm64" "$PREFIXES/x86_64"
build_x264 arm64 aarch64-apple-darwin
build_x264 x86_64 x86_64-apple-darwin

status "libplacebo-build"
build_libplacebo arm64
build_libplacebo x86_64

status "ffmpeg-build"
build_ffmpeg arm64
build_ffmpeg x86_64

status "universal-assembly"
rm -rf "$OUT"
mkdir -p "$OUT"
lipo -create "$PREFIXES/arm64/ffmpeg/bin/ffmpeg" "$PREFIXES/x86_64/ffmpeg/bin/ffmpeg" -output "$OUT/ffmpeg"
lipo -create "$PREFIXES/arm64/ffmpeg/bin/ffprobe" "$PREFIXES/x86_64/ffmpeg/bin/ffprobe" -output "$OUT/ffprobe"
chmod 755 "$OUT/ffmpeg" "$OUT/ffprobe"
# Ad-hoc signing is intentionally sufficient for this non-release local
# candidate. Developer ID signing and notarization remain release gates.
codesign --force --sign - "$OUT/ffmpeg" "$OUT/ffprobe"

status "portable-probe"
node "$ROOT_DIR/scripts/toolchain/verify-portable-tools.cjs" --tools "$OUT" --manifest "$MANIFEST" --report "$WORK/portable-probe.json"
printf 'portable-toolchain: non-release candidate written to %s\n' "$OUT" >&2
