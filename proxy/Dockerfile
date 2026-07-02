# Build executor binaries
FROM registry.access.redhat.com/ubi9/go-toolset:latest@sha256:8d2d83261cbc8854b8c93b1237d7d4aa0069bdb93e2974d980bc7788db56f8f4 AS executor-builder
WORKDIR /build
COPY executor/ .
RUN go mod download \
    && CGO_ENABLED=0 go build -o /tmp/executor-server ./cmd/server \
    && CGO_ENABLED=0 go build -o /tmp/executor-client ./cmd/client

FROM registry.access.redhat.com/ubi9/ubi:latest

# Squid + GPG + Python 3.11 (gnupg2 for commit signing, python3.11 for mcp-atlassian which requires >=3.10)
RUN dnf install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm \
    && dnf install -y --nodocs squid gnupg2 python3.11 python3.11-pip \
    && pip3.11 install --no-cache-dir mcp-atlassian \
    && dnf clean all

COPY squid.conf /etc/squid/squid.conf

# gh CLI (renamed to gh-real — thin client takes "gh" in bot container)
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v2.67.0/gh_2.67.0_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1 \
    && mv /usr/local/bin/gh /usr/local/bin/gh-real

# glab CLI (renamed to glab-real)
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') \
    && curl -fSL -o /tmp/glab.tar.gz "https://gitlab.com/gitlab-org/cli/-/releases/v1.51.0/downloads/glab_1.51.0_linux_${ARCH}.tar.gz" \
    && tar -xzf /tmp/glab.tar.gz -C /usr/local/bin --strip-components=1 bin/glab \
    && rm /tmp/glab.tar.gz \
    && mv /usr/local/bin/glab /usr/local/bin/glab-real

# Executor binaries
COPY --from=executor-builder /tmp/executor-server /usr/local/bin/
COPY --from=executor-builder /tmp/executor-client /usr/local/bin/

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

RUN mkdir -p /var/log/squid /var/spool/squid /var/run/squid /var/run/devbot \
    && chown -R squid:0 /var/log/squid /var/spool/squid /var/run/squid /var/run/devbot \
    && chmod -R g+rwX /var/log/squid /var/spool/squid /var/run/squid /var/run/devbot

ENV HOME=/tmp

EXPOSE 3128
EXPOSE 8443
EXPOSE 8446
EXPOSE 8444
USER squid

CMD ["/usr/local/bin/start.sh"]
