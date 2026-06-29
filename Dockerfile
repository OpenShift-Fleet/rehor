# Dev proxy — build custom Caddy from source on UBI (passes EC)
FROM registry.access.redhat.com/ubi9/go-toolset:latest@sha256:8d2d83261cbc8854b8c93b1237d7d4aa0069bdb93e2974d980bc7788db56f8f4 AS dev-proxy-builder
COPY dev-proxy/ /tmp/dev-proxy/
RUN cd /tmp/dev-proxy \
    && go build -o /tmp/caddy .

# Build executor thin client (gh/glab shim that forwards via UDS to proxy sidecar)
FROM registry.access.redhat.com/ubi9/go-toolset:latest@sha256:8d2d83261cbc8854b8c93b1237d7d4aa0069bdb93e2974d980bc7788db56f8f4 AS executor-client-builder
WORKDIR /build
COPY proxy/executor/ .
RUN go mod download \
    && CGO_ENABLED=0 go build -o /tmp/executor-client ./cmd/client

FROM registry.access.redhat.com/ubi9/ubi:latest

# System deps + Python 3.12 + Chromium runtime libraries
RUN dnf install -y --nodocs --allowerasing \
    python3.12 python3.12-pip python3.12-devel \
    git \
    curl \
    jq \
    socat \
    gcc \
    make \
    sqlite-devel \
    alsa-lib \
    atk \
    at-spi2-atk \
    at-spi2-core \
    cairo \
    cups-libs \
    dbus-libs \
    libdrm \
    mesa-libgbm \
    glib2 \
    nspr \
    nss \
    pango \
    libX11 \
    libxcb \
    libXcomposite \
    libXdamage \
    libXext \
    libXfixes \
    libxkbcommon \
    libXrandr \
    && dnf clean all

# Node.js 22 (official binary tarball)
RUN ARCH=$(uname -m | sed 's/x86_64/x64/' | sed 's/aarch64/arm64/') \
    && curl -fsSL "https://nodejs.org/dist/v22.15.0/node-v22.15.0-linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1


# Headless Chromium via Playwright (avoids EPEL/CentOS RPMs)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright install chromium

# Make python3.12 the default
RUN ln -sf /usr/bin/python3.12 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.12 /usr/bin/python

# Go — multiple versions via GOVERSIONS build arg
# Default Go is the first version listed. Bot switches with: eval "$(use-go 1.25.7)"
ARG GOVERSIONS="1.24.2 1.25.7"
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') \
    && for v in $GOVERSIONS; do \
         echo "Installing Go $v..." \
         && curl -fsSL "https://go.dev/dl/go${v}.linux-${ARCH}.tar.gz" \
            | tar -xz -C /usr/local \
         && mv /usr/local/go /usr/local/go${v}; \
       done \
    && DEFAULT=$(echo $GOVERSIONS | awk '{print $1}') \
    && ln -s /usr/local/go${DEFAULT} /usr/local/go
ENV PATH="/usr/local/go/bin:$PATH"

# use-go helper: eval "$(use-go 1.25.7)"
RUN printf '#!/bin/bash\nV=${1:?Usage: use-go <version>}\nif [ ! -d "/usr/local/go${V}" ]; then echo "Go $V not installed. Available:" >&2; ls -d /usr/local/go[0-9]* | sed "s|/usr/local/go||" >&2; exit 1; fi\necho "export PATH=/usr/local/go${V}/bin:\${PATH#/usr/local/go*/bin:}"\n' > /usr/local/bin/use-go \
    && chmod +x /usr/local/bin/use-go

# golangci-lint
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') \
    && curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v2.1.6/golangci-lint-2.1.6-linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin --strip-components=1 --wildcards '*/golangci-lint'

# Executor thin client — drop-in gh/glab replacement (forwards to proxy sidecar)
COPY --from=executor-client-builder /tmp/executor-client /usr/local/bin/executor-client
RUN ln /usr/local/bin/executor-client /usr/local/bin/gh \
    && ln /usr/local/bin/executor-client /usr/local/bin/glab \
    && ln /usr/local/bin/executor-client /usr/local/bin/gpg

# bubblewrap (sandbox runtime for Claude Code)
RUN dnf install -y --nodocs libcap-devel \
    && pip3.12 install meson ninja \
    && git clone --depth 1 --branch v0.11.1 https://github.com/containers/bubblewrap.git /tmp/bwrap \
    && cd /tmp/bwrap \
    && meson setup _builddir \
    && meson compile -C _builddir \
    && meson install -C _builddir \
    && cd / && rm -rf /tmp/bwrap \
    && pip3.12 uninstall -y meson ninja \
    && dnf clean all

# Buildah (rootless container image builder — no daemon, works in OpenShift)
RUN dnf install -y --nodocs buildah fuse-overlayfs \
    && dnf clean all

# tini — proper init process that reaps zombie children
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') \
    && curl -fsSL -o /usr/local/bin/tini "https://github.com/krallin/tini/releases/download/v0.19.0/tini-${ARCH}" \
    && chmod +x /usr/local/bin/tini

# grype (container image vulnerability scanner)
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') \
    && curl -fsSL "https://github.com/anchore/grype/releases/download/v0.87.0/grype_0.87.0_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin grype

# Dev proxy (custom Caddy for local UI verification against stage)
COPY --from=dev-proxy-builder /tmp/caddy /usr/local/bin/caddy
COPY dev-proxy/Caddyfile /etc/caddy/Caddyfile
COPY dev-proxy/start-proxy.sh /usr/local/bin/start-dev-proxy.sh
RUN chmod +x /usr/local/bin/start-dev-proxy.sh

# Pre-install MCP servers so they don't need network at runtime
RUN npm install -g chrome-devtools-mcp@latest @redhat-cloud-services/hcc-pf-mcp

# uv
RUN pip3.12 install uv

# mcp-atlassian runs in the proxy container (streamable-http transport).
# Bot connects via HTTP — no local install needed.

# Non-root user (Claude Code rejects root)
RUN useradd -m -s /bin/bash botuser
WORKDIR /home/botuser/app

# Copy project files and install Python deps (as root so uv is available)
COPY pyproject.toml uv.lock* ./
COPY bot/ bot/
RUN uv sync --frozen --no-dev
ENV PATH="/home/botuser/app/.venv/bin:/home/botuser/go/bin:$PATH"
ENV GOPATH="/home/botuser/go"
ENV CLAUDE_CODE_USE_VERTEX=1
ENV CLOUD_ML_REGION=global
ENV BUILDAH_ISOLATION=chroot

# Copy bot config files
COPY config.json CLAUDE.md .mcp.json entrypoint.sh ./
COPY .claude/ .claude/
COPY presets/ presets/

# Run env preset install scripts (no-op until presets are extracted)
RUN bash -c 'shopt -s nullglob; for script in presets/envs/*/install.sh; do bash "$script"; done'

ENV HOME=/home/botuser
USER botuser

# Buildah rootless config — vfs driver (no kernel module needed, works everywhere)
RUN mkdir -p /home/botuser/.config/containers /home/botuser/.local/share/containers \
    && echo -e '[storage]\ndriver = "vfs"' > /home/botuser/.config/containers/storage.conf \
    && echo -e '[registries.search]\nregistries = ["registry.access.redhat.com", "quay.io", "docker.io"]' \
       > /home/botuser/.config/containers/registries.conf


# Fix ownership — botuser:0 + group-writable so OpenShift arbitrary UIDs (always GID 0) can write.
# Must run last so it covers all dirs created above (.ssh, .config, .gitconfig, etc.)
USER 0
RUN chown -R botuser:0 /home/botuser \
    && chmod -R g+rwX /home/botuser
USER botuser

ENTRYPOINT ["tini", "--", "bash", "entrypoint.sh"]
