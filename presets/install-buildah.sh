#!/bin/bash
# Shared buildah + fuse-overlayfs installer — called by the root Dockerfile
# and the container-scan env preset so every image resolves the buildah stack
# identically.
#
# Tries the plain dnf install first and falls back to a workaround for the
# UBI9 appstream epoch skew (REHOR-245, observed 2026-11-12): netavark was
# republished with epoch 3 (3:1.17.2) requiring aardvark-dns >= 3:1.17, but
# the repo carries the epoch-2 build (2:1.17.1) and keeps no older versions,
# so dnf cannot resolve the buildah chain at all (--nobest has nothing to
# fall back to). The fallback installs netavark with --nodeps first; dnf does
# not re-verify the dependencies of already-installed packages, so netavark
# then satisfies the container-network-stack requirement of
# containers-common-extra and buildah resolves normally. netavark 1.17.2 and
# aardvark-dns 1.17.1 are functionally matched; only the epoch metadata is
# off. The fallback is self-removing: once the repo resyncs, the plain
# install succeeds and the workaround is never taken.
set -e

DNF=(dnf --disableplugin=subscription-manager --disablerepo='*' --enablerepo='ubi-*')

if "${DNF[@]}" install -y --nodocs buildah fuse-overlayfs; then
    "${DNF[@]}" clean all
    exit 0
fi

echo "[install-buildah] plain install failed — applying UBI9 epoch-skew workaround" >&2
tmpdir=$(mktemp -d)
"${DNF[@]}" download --destdir="$tmpdir" netavark
rpm -i --nodeps "$tmpdir"/netavark-*.rpm
rm -rf "$tmpdir"
"${DNF[@]}" install -y --nodocs buildah fuse-overlayfs aardvark-dns
"${DNF[@]}" clean all
