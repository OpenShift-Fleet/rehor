#!/bin/bash
# Container-scan env preset — grype + buildah + rootless config
set -e

# Grype (vulnerability scanner)
ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')
curl -fsSL "https://github.com/anchore/grype/releases/download/v0.87.0/grype_0.87.0_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin grype

# Buildah (rootless container builder)
dnf install -y --nodocs buildah fuse-overlayfs && dnf clean all

# Buildah rootless config — vfs driver (no kernel module needed, works everywhere)
BOTUSER_HOME="${BOTUSER_HOME:-/home/botuser}"
mkdir -p "$BOTUSER_HOME/.config/containers" "$BOTUSER_HOME/.local/share/containers"
echo -e '[storage]\ndriver = "vfs"' > "$BOTUSER_HOME/.config/containers/storage.conf"
echo -e '[registries.search]\nregistries = ["registry.access.redhat.com", "quay.io", "docker.io"]' \
    > "$BOTUSER_HOME/.config/containers/registries.conf"

# BUILDAH_ISOLATION for all shells
cat > /etc/profile.d/buildah.sh << 'PROFILE'
export BUILDAH_ISOLATION=chroot
PROFILE
