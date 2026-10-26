#!/bin/sh
# Check that a Linux package's X11 entry point reached the files it names.
# A bundler that copies nothing does not fail, so the check is there to catch
# the packages that silently ship empty.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: check-x11.sh <label> <package> <list-command>" >&2
  exit 2
fi

label="$1"
package="$2"
command="$3"

listing="$(command -v sh -c "true" >/dev/null 2>&1; $command "$package" 2>/dev/null | tr '\n' '\n')"
echo "$listing"

for needle in /comet-x11 /comet-x11.desktop /README.txt; do
  if ! printf '%s\n' "$listing" | grep -q "$needle"; then
    echo "::error title=The package::$label is missing $needle"
    exit 1
  fi
done

if ! printf '%s\n' "$listing" | grep -qE '/comet-x11$'; then
  echo "::error title=The package::$label is missing the executable bit on comet-x11"
  exit 1
fi
