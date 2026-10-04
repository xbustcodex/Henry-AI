#!/bin/bash
# Henry AI Release Script — run from repo root
# Usage: GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx ./scripts/release.sh
#
# WHY THIS SCRIPT REFUSES TO PUBLISH WITHOUT UPDATER METADATA
# ---------------------------------------------------------
# An installed Henry discovers updates through electron-updater, which reads the
# channel metadata for its platform — latest-mac.yml, latest.yml,
# latest-linux.yml — from the GitHub release, and then downloads the artifact
# that file points at (plus a .blockmap for the differential download). A
# release carrying only two .dmg files serves no metadata at all: every
# installed Henry gets a 404 on its update feed and silently stays on its
# current version forever, with nothing in the app to show for it. The tag
# exists, the release exists, the downloads work — and no client ever learns
# there was a new version.
#
# So publishing is refused unless, for every platform being released, the
# metadata electron-updater needs is present, it describes THIS version, and
# every artifact it references was actually built. Anything missing is reported
# by name and the release is not created.
#
# Overridable (used by src/henry/releasePipeline.test.ts to exercise this script
# without touching a real release): RELEASE_ARTIFACT_DIR, HENRY_RELEASE_REPO,
# GITHUB_API_URL, GITHUB_UPLOADS_URL.

set -euo pipefail
shopt -s nullglob

ARTIFACT_DIR="${RELEASE_ARTIFACT_DIR:-release2}"
REPO_SLUG="${HENRY_RELEASE_REPO:-xbustcodex/Henry-AI}"
API="${GITHUB_API_URL:-https://api.github.com}"
UPLOADS_API="${GITHUB_UPLOADS_URL:-https://uploads.github.com}"

fail() {
  echo "" >&2
  echo "REFUSING TO PUBLISH — $*" >&2
  exit 1
}

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
TAG="v$VERSION"
TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN:-}"
[ -z "$TOKEN" ] && fail "GITHUB_PERSONAL_ACCESS_TOKEN is not set"

# A version carrying a semver pre-release marker (1.0.0-beta.1) must become a
# GitHub pre-release. Installed Henrys run with allowPrerelease = false against
# the stable feed, so publishing a beta as a normal release hands exactly the
# build they must not receive to every stable client.
case "$VERSION" in
  *-*) PRERELEASE=true ;;
  *) PRERELEASE=false ;;
esac

# ── What is actually built ───────────────────────────────────────────────────
DMGS=("$ARTIFACT_DIR"/Henry*AI-"$VERSION"*.dmg)
ZIPS=("$ARTIFACT_DIR"/Henry*AI-"$VERSION"*.zip)
EXES=("$ARTIFACT_DIR"/*.exe)
APPIMAGES=("$ARTIFACT_DIR"/*.AppImage)
EXE_BLOCKMAPS=("$ARTIFACT_DIR"/*.exe.blockmap)
BLOCKMAPS=("$ARTIFACT_DIR"/*.blockmap)

METADATA=()
for meta in latest-mac.yml latest.yml latest-linux.yml; do
  [ -f "$ARTIFACT_DIR/$meta" ] && METADATA+=("$ARTIFACT_DIR/$meta")
done

echo "Releasing Henry AI $TAG (prerelease: $PRERELEASE) from $ARTIFACT_DIR"
printf '  %-58s %s\n' "Henry AI-$VERSION-arm64.dmg" "$(ls -lh "${ARTIFACT_DIR}/Henry AI-$VERSION-arm64.dmg" 2>/dev/null | awk '{print $5}' || echo MISSING)"
printf '  %-58s %s\n' "Henry AI-$VERSION.dmg" "$(ls -lh "${ARTIFACT_DIR}/Henry AI-$VERSION.dmg" 2>/dev/null | awk '{print $5}' || echo MISSING)"

# ── Preflight: the update feed must exist ─────────────────────────────────────
if [ ${#DMGS[@]} -eq 0 ] && [ ${#ZIPS[@]} -eq 0 ] && [ ${#EXES[@]} -eq 0 ] && [ ${#APPIMAGES[@]} -eq 0 ]; then
  fail "no built artifacts in $ARTIFACT_DIR — build before releasing (electron-builder writes them there)"
fi

MISSING=()
# macOS: electron-updater updates a packaged app from the ZIP and finds it via
# latest-mac.yml — a DMG-only release can never update. The block map that
# pairs with the ZIP (<zip>.blockmap) is checked below against what the
# metadata actually points at.
if [ ${#DMGS[@]} -gt 0 ] || [ ${#ZIPS[@]} -gt 0 ]; then
  [ -f "$ARTIFACT_DIR/latest-mac.yml" ] || MISSING+=("latest-mac.yml")
fi
# Windows: latest.yml points at the NSIS installer; electron-updater fetches
# <installer>.exe.blockmap for the differential download.
if [ ${#EXES[@]} -gt 0 ]; then
  [ -f "$ARTIFACT_DIR/latest.yml" ] || MISSING+=("latest.yml")
  [ ${#EXE_BLOCKMAPS[@]} -gt 0 ] || MISSING+=("<installer>.exe.blockmap")
fi
# Linux: latest-linux.yml points at the AppImage the updater installs. The
# AppImage carries its own embedded block map, so there is no sibling file.
if [ ${#APPIMAGES[@]} -gt 0 ]; then
  [ -f "$ARTIFACT_DIR/latest-linux.yml" ] || MISSING+=("latest-linux.yml")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  {
    echo ""
    echo "Updater metadata required by the artifacts in $ARTIFACT_DIR is missing:"
    for f in "${MISSING[@]}"; do echo "  - $f"; done
    echo ""
    echo "Publishing these artifacts would give every installed Henry a 404 on its"
    echo "update feed, and it would never update. Build them first: electron-builder"
    echo "writes latest-mac.yml / latest.yml / latest-linux.yml and the .blockmap"
    echo "files into $ARTIFACT_DIR."
  } >&2
  fail "${#MISSING[@]} required updater metadata file(s) absent"
fi

# ── Preflight: the metadata must describe this version and its artifacts ──────
# Metadata left over from an earlier build is the same silent failure as no
# metadata at all: the feed resolves, serves a stale version, and every client
# correctly concludes it is already up to date.
python3 - "$ARTIFACT_DIR" "$VERSION" <<'PY' >&2 || fail "updater metadata does not describe this release"
import os, re, sys

art_dir, version = sys.argv[1], sys.argv[2]
problems = []

for meta in ("latest-mac.yml", "latest.yml", "latest-linux.yml"):
    path = os.path.join(art_dir, meta)
    if not os.path.isfile(path):
        continue
    with open(path, encoding="utf-8") as fh:
        text = fh.read()

    declared = re.search(r"^version:\s*'?([^'\s]+)'?\s*$", text, re.M)
    if not declared:
        problems.append(f"{meta} declares no version")
    elif declared.group(1) != version:
        problems.append(
            f"{meta} describes version {declared.group(1)}, not {version} (stale metadata from an earlier build)"
        )

    refs = re.findall(r"^\s*(?:url|path):\s*(.+?)\s*$", text, re.M)
    if not refs:
        problems.append(f"{meta} lists no artifact (no url:/path: entry)")
    for ref in refs:
        ref = ref.strip().strip('"\'')
        if not os.path.isfile(os.path.join(art_dir, ref)):
            problems.append(f"{meta} references {ref}, which is not in {art_dir}")
            continue
        # electron-updater fetches <artifact>.blockmap alongside the artifact.
        if ref.endswith((".zip", ".AppImage")) and not os.path.isfile(os.path.join(art_dir, ref + ".blockmap")):
            problems.append(f"{meta} references {ref}, but {ref}.blockmap is not in {art_dir}")
        if ref.endswith(".exe") and not any(n.endswith(".exe.blockmap") for n in os.listdir(art_dir)):
            problems.append(f"{meta} references {ref}, but no .exe.blockmap is in {art_dir}")

if problems:
    print("")
    print("Updater metadata is incomplete or stale:")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)
PY

UPLOADS=("${DMGS[@]}" "${ZIPS[@]}" "${EXES[@]}" "${APPIMAGES[@]}" "${METADATA[@]}" "${BLOCKMAPS[@]}")
for f in "${UPLOADS[@]}"; do
  [ -f "$f" ] || fail "artifact vanished between preflight and publish: $f"
done

# ── Create the release ────────────────────────────────────────────────────────
BODY=$(python3 - "$VERSION" "$PRERELEASE" <<'PY'
import json, sys
version, prerelease = sys.argv[1], sys.argv[2] == "true"
body = (
    f"## Download\n"
    f"- **Apple Silicon**: Henry AI-{version}-arm64.dmg\n"
    f"- **Intel Mac**: Henry AI-{version}.dmg\n\n"
    f"Existing installs update themselves — Henry checks for updates on launch and "
    f"every four hours, using the updater metadata shipped alongside these files "
    f"(latest-mac.yml / latest.yml / latest-linux.yml).\n\n"
    f"See README for setup."
)
print(json.dumps({
    "tag_name": f"v{version}",
    "name": f"Henry AI v{version}",
    "draft": False,
    "prerelease": prerelease,
    "body": body,
}))
PY
)

RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "$API/repos/$REPO_SLUG/releases")

ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || true)
[ -z "${ID:-}" ] && fail "GitHub rejected the release: $RESP"
echo "Created release $ID (prerelease: $PRERELEASE)"

upload() {
  local f="$1"
  local n
  n=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$(basename "$f")")
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    "$UPLOADS_API/repos/$REPO_SLUG/releases/$ID/assets?name=$n" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('Uploaded:', d['name']) if 'name' in d else print('FAILED:', d.get('message','unknown error'))" \
    || echo "FAILED: $(basename "$f")"
}

FAILED_UPLOADS=0
for f in "${UPLOADS[@]}"; do
  out=$(upload "$f")
  echo "$out"
  case "$out" in
    Uploaded:*) ;;
    *) FAILED_UPLOADS=$((FAILED_UPLOADS + 1)) ;;
  esac
done

if [ "$FAILED_UPLOADS" -gt 0 ]; then
  fail "$FAILED_UPLOADS artifact(s) could not be uploaded — the release is incomplete, delete it and release again"
fi

echo "Done: $API/repos/$REPO_SLUG/releases/tag/$TAG"