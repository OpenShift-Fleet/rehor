# Red Hat registry pull proxy

The proxy can pull images from `registry.redhat.io` on behalf of Podman and
Skopeo clients. Registry Service Account credentials stay in the proxy container.
It exchanges them for repository-scoped bearer tokens, caches those tokens until
shortly before expiry, and streams manifests and layers. Only GET and HEAD of
Registry V2 pull endpoints are permitted. Pushes and token endpoint access are
blocked.

## Enable in a deployment

The listener on **8451** is disabled when both `REGISTRY_REDHAT_USERNAME` and
`REGISTRY_REDHAT_TOKEN` are absent. Supplying both enables it; supplying only one
is a startup configuration error. `REGISTRY_AUTH_LISTEN` optionally overrides the
listen address (default `:8451`). `/healthz` reports that the listener is running;
it does not verify upstream credentials or image entitlements.

The shared OpenShift template and the obsint custom proxy template use optional
keys from `REGISTRY_SECRET_NAME` (default `redhat-registry-credentials`):

| Secret key | Value |
| --- | --- |
| `registry-redhat-username` | Full Registry Service Account username, including the `account-number|` prefix |
| `registry-redhat-token` | The service account password/token, stored as plain text in the Vault field |

Use the existing app-interface Vault-to-Kubernetes Secret integration. For
example, after creating the Vault entry, add a resource like this to the
deployment namespace's `openshiftResources` (replace the path and version):

```yaml
- provider: vault-secret
  path: <team-vault-path>/redhat-registry-credentials
  name: redhat-registry-credentials
  version: 1  # replace with the actual Vault version
  annotations:
    qontract.recycle: "true"
```

Put the two keys above in that Vault entry. Do not commit credential values or
apply the placeholder path. The proxy reads Kubernetes Secret-backed environment
variables; it does not connect directly to Vault. No Secret needs to exist for
deployments that do not use this feature.

Build and release a proxy image containing this change, then set
`PROXY_IMAGE_TAG` to that release. Reconcile the proxy Deployment, Service and
NetworkPolicy, plus the bot egress policy allowing port 8451. The supplied
templates include that port. Update the pinned Vault version and restart/recycle
the proxy after credential rotation, since environment variables are read at
startup. Remove both keys and recycle the proxy to disable the listener.

For Compose, set the same two environment variables in `.env`. Compose supplies
them to the proxy and explicitly clears them in the bot. The endpoint is
`http://proxy:8451` on the internal network.

## Configure Podman or Skopeo

After enabling the proxy, merge this entry into the container client's
`~/.config/containers/registries.conf` (or its managed system configuration).
Replace the hostname with the deployed proxy Service name:

```toml
[[registry]]
prefix = "registry.redhat.io"
location = "devbot-obsint-processing-proxy:8451"
insecure = true
```

This maps the original registry name to the internal pull proxy. `insecure`
allows HTTP on that internal connection; proxy-to-registry and proxy-to-CDN
connections always use verified HTTPS. Keep the service internal to the bot
network: clients allowed to connect can pull images accessible to the service
account. Set `NO_PROXY` and `no_proxy` to include the proxy Service hostname so
the internal request bypasses Squid (the obsint bot template already does this).

For remote Podman, install the configuration on the machine running the Podman
service. No registry login or registry credential file is needed in the bot.
Then use normal image references, for example:

```sh
podman pull registry.redhat.io/ubi9/ubi:latest
skopeo copy docker://registry.redhat.io/ubi9/ubi:latest dir:/tmp/ubi9-image
```

For an initial check without a registry-name mapping, address the internal
endpoint directly:

```sh
curl --fail http://devbot-obsint-processing-proxy:8451/v2/
skopeo copy --src-tls-verify=false \
  docker://devbot-obsint-processing-proxy:8451/ubi9/ubi:latest dir:/tmp/ubi9-image
```

Skopeo `copy` exercises layer downloads as well as manifest access. A successful
`/v2/` check alone does not verify access to a particular repository.

The proxy follows signed layer redirects to `cdn.quay.io`, `cdn01.quay.io`,
`cdn02.quay.io`, and `cdn03.quay.io` without forwarding registry credentials.
Those hosts and `registry.redhat.io` must be reachable on HTTPS from the proxy.
Bots receive the streamed layer, so they need no additional Squid/CDN access.
Unexpected redirect destinations fail closed. Token exchange failures return a
generic 502 without exposing the upstream response or credential values.

## References

- [Red Hat Container Registry Authentication](https://access.redhat.com/articles/RegistryAuthentication)
- [Distribution token authentication](https://distribution.github.io/distribution/spec/auth/token/)
- [Red Hat registry CDN hosts](https://access.redhat.com/articles/6999582)
- [Podman/Skopeo registry remapping configuration](https://github.com/containers/image/blob/main/docs/containers-registries.conf.5.md)

The token endpoint is fixed to the HTTPS realm advertised by
`https://registry.redhat.io/v2/` on 2026-11-03:
`https://registry.redhat.io/auth/realms/rhcc/protocol/redhat-docker-v2/auth`,
with service `docker-registry`. Clients cannot override the token endpoint,
registry host, or `pull` scope.
