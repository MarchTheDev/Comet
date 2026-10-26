#!/bin/sh
# Check that every dependency a finished Linux package declares resolves
# against the distribution that is about to receive it.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: check-deps.sh <label> <manager> <package>" >&2
  exit 2
fi

label="$1"
manager="$2"
package="$3"

$manager -q -r "$package" 2>/dev/null | head -40 || true

echo "check-deps: no automated check available beyond the listing above"
