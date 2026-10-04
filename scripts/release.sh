#!/bin/bash
# Henry AI Release Script — run from repo root
# Usage: GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx ./scripts/release.sh

set -e
VERSION=$(cat package.json | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")
TAG="v$VERSION"
TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN}"

[ -z "$TOKEN" ] && echo "Set GITHUB_PERSONAL_ACCESS_TOKEN" && exit 1

ARM_DMG="release2/Henry AI-${VERSION}-arm64.dmg"
X64_DMG="release2/Henry AI-${VERSION}.dmg"

echo "Releasing Henry AI $TAG..."
echo "arm64: $(ls -lh "$ARM_DMG" 2>/dev/null | awk '{print $5}' || echo MISSING)"
echo "x64:   $(ls -lh "$X64_DMG" 2>/dev/null | awk '{print $5}' || echo MISSING)"

# Create release
RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/xbustcodex/Henry-AI/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"Henry AI $TAG\",\"draft\":false,\"prerelease\":false,\"body\":\"## Download\\n- **Apple Silicon**: Henry AI-${VERSION}-arm64.dmg\\n- **Intel Mac**: Henry AI-${VERSION}.dmg\\n\\nSee README for setup.\"}")

ID=$(echo $RESP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['id'])" 2>/dev/null)
[ -z "$ID" ] && echo "Error: $RESP" && exit 1
echo "Created release $ID"

upload() {
  local f="$1"
  local n=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$(basename "$f")")
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    "https://uploads.github.com/repos/xbustcodex/Henry-AI/releases/$ID/assets?name=$n" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('Uploaded:', d.get('name','?'))" 2>/dev/null
}

[ -f "$ARM_DMG" ] && upload "$ARM_DMG"
[ -f "$X64_DMG" ] && upload "$X64_DMG"

echo "Done: https://github.com/xbustcodex/Henry-AI/releases/tag/$TAG"
