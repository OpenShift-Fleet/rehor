#!/bin/bash
# Container-scan env preset — grype + buildah
set -e

# Skip if already installed (idempotent during transition period)
if command -v grype &>/dev/null && command -v buildah &>/dev/null; then
    echo "container-scan preset: already installed, skipping"
    exit 0
fi

# Grype (vulnerability scanner)
ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')
curl -fsSL "https://github.com/anchore/grype/releases/download/v0.87.0/grype_0.87.0_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin grype

# Buildah (rootless container builder)
dnf install -y --nodocs buildah fuse-overlayfs && dnf clean all
