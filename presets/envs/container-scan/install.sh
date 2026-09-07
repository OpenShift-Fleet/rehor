#!/bin/bash
# Container-scan env preset — grype + buildah
set -e

# Grype (vulnerability scanner)
ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')
curl -fsSL "https://github.com/anchore/grype/releases/download/v0.118.0/grype_0.118.0_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin grype

# Buildah (rootless container builder)
dnf install -y --nodocs buildah fuse-overlayfs && dnf clean all

# BUILDAH_ISOLATION for all shells
cat > /etc/profile.d/buildah.sh << 'PROFILE'
export BUILDAH_ISOLATION=chroot
PROFILE
