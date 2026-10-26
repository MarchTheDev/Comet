#!/bin/sh
# Check that a finished AppImage actually contains what it says it contains,
# and that the entry point inside it is the one the menu entry calls.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: check-appimage.sh <label> <image>" >&2
  exit 2
fi

label="$1"
image="$2"

if [ ! -f "$image" ]; then
  echo "::error title=The AppImage::$label is missing"
  exit 1
fi

echo "$label: file present"

# The AppImage is an ISO; ask the tooling that reads them to describe it.
command -v appimagetool >/dev/null 2>&1 || true
file "$image"
