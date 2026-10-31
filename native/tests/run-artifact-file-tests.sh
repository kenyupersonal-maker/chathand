#!/bin/sh
set -eu
artifact_repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
artifact_tmp=$(mktemp -d -t chathand-artifact-native)
trap 'rm -rf -- "$artifact_tmp"' EXIT HUP INT TERM
/usr/bin/xcrun swiftc -swift-version 5 -parse-as-library -framework Foundation -framework ImageIO -framework CoreGraphics "$artifact_repo/native/ArtifactFileAccess.swift" "$artifact_repo/native/tests/ArtifactFileAccessTests.swift" -o "$artifact_tmp/artifact-checks"
"$artifact_tmp/artifact-checks"
