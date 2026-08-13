#!/usr/bin/env bash
set -euo pipefail

snapshot=$1
expected=$(sha256sum "$snapshot/MANIFEST.sha256" | awk '{print $1}')
recorded=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifestSha256"])' \
  "$snapshot/SNAPSHOT.json")
test "$expected" = "$recorded"
cd "$snapshot/source"
sha256sum -c "$snapshot/MANIFEST.sha256"
