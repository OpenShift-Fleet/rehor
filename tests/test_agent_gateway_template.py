"""Static contract tests for the agent gateway wiring (REHOR-251).

deploy/template.yaml is the only artifact under test. The wiring is
additive and inert by default with exactly ONE new public endpoint:

* services HTTP gateway (edge TLS + oauth-proxy :8453 -> loopback mux
  :8454). Zero-config executor plan: the SAME existing executor listener
  :9090 serves legacy gRPC and the new HTTP/1 /executor/execute path,
  always running (not gated); the mux :8454 is the only internal listener
  and is never exposed. There is no separate :8455 server.

There is deliberately NO new public gRPC endpoint, NO forward proxy and
NO custom certificate/Secret: sandbox ordinary egress uses the central
dispatcher-owned OpenShell policies (migrated Squid allowlist), and the
legacy internal executor gRPC :9090 and Squid :3128 are unchanged. No
IngressController / cluster mutation.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "deploy" / "template.yaml"
DISPATCHER_TEMPLATE = ROOT / "deploy" / "agent-dispatcher-template.yaml"

# Dummy values for required parameters and the self-referential NAMESPACE.
DUMMY = {
    "NAMESPACE": "test-ns",
    "MEMORY_SERVER_IMAGE_TAG": "test",
    "PROXY_IMAGE_TAG": "test",
    "GCP_PROJECT_ID": "test-project",
    "GCP_REGION": "us-east1",
    "VERTEX_ALLOWED_MODELS": "claude",
    "DASHBOARD_URL": "dashboard.example.com",
    "OUTCOMES_URL": "outcomes.example.com",
}

GATEWAY_ENV = {
    "AGENT_HTTP_GATEWAY_ENABLED": "false",
}


def load_template():
    return yaml.safe_load(TEMPLATE.read_text())


def substitute(node, values):
    """Emulate oc process: replace ${VAR} inside parsed string values."""
    if isinstance(node, str):
        return re.sub(r"\$\{([A-Z0-9_]+)\}", lambda m: str(values[m.group(1)]), node)
    if isinstance(node, list):
        return [substitute(item, values) for item in node]
    if isinstance(node, dict):
        return {key: substitute(value, values) for key, value in node.items()}
    return node


def render_objects(**overrides):
    template = load_template()
    values = {p["name"]: p.get("value", "") for p in template["parameters"]}
    values.update(DUMMY)
    values.update(overrides)
    return substitute(template["objects"], values)


def find(objects, kind, name):
    for obj in objects:
        if obj["kind"] == kind and obj["metadata"]["name"] == name:
            return obj
    raise AssertionError(f"{kind}/{name} not found")


def proxy_deployment(objects):
    deployment = find(objects, "Deployment", "devbot-proxy")
    return deployment["spec"]["template"]["spec"]


def container(spec, name):
    for c in spec["containers"]:
        if c["name"] == name:
            return c
    raise AssertionError(f"container {name} not found")


def env_map(container_spec):
    return {e["name"]: e.get("value") for e in container_spec.get("env", [])}


# --- parameters -----------------------------------------------------------


def test_gateway_parameters_default_inert():
    params = {p["name"]: p for p in load_template()["parameters"]}
    assert params["AGENT_HTTP_GATEWAY_ENABLED"]["value"] == "false"
    assert params["SERVICE_GATEWAY_URL"]["value"] == ""
    # The dropped gRPC/forward endpoints and cert must not resurface.
    for name in (
        "AGENT_GRPC_GATEWAY_ENABLED",
        "EXECUTOR_GATEWAY_URL",
        "AGENT_FORWARD_GATEWAY_ENABLED",
        "FORWARD_GATEWAY_URL",
        "GATEWAY_TLS_SECRET",
    ):
        assert name not in params
    # The old parameter set is preserved.
    for name in ("MODEL_PROXY_URL", "MODEL_PROXY_TOKEN_SERVICE_ACCOUNT"):
        assert name in params


# --- gateways Service -----------------------------------------------------


def test_gateways_service_selects_proxy_pod_with_gateway_ports_only():
    service = find(render_objects(), "Service", "devbot-proxy-gateways")
    spec = service["spec"]
    assert spec["type"] == "ClusterIP"
    assert spec["selector"] == {"app.kubernetes.io/name": "devbot-proxy"}
    ports = {p["name"]: p["port"] for p in spec["ports"]}
    assert ports == {"gateway-auth": 8453}
    target_ports = {p["name"]: p["targetPort"] for p in spec["ports"]}
    assert target_ports == {"gateway-auth": "gateway-auth"}
    # No serving-cert annotation and no certificate Secret dependency:
    # TLS terminates at the router, auth in the oauth sidecar.
    annotations = service["metadata"].get("annotations") or {}
    assert "service.beta.openshift.io/serving-cert-secret-name" not in annotations
    # The internal loopback listeners are never exposed via a Service.
    assert 8454 not in ports.values()
    assert 8455 not in ports.values()


def test_existing_proxy_service_untouched():
    service = find(render_objects(), "Service", "devbot-proxy")
    ports = {p["name"]: p["port"] for p in service["spec"]["ports"]}
    assert ports == {
        "squid": 3128,
        "executor": 9090,
        "vertex-auth": 8443,
        "jira-mcp": 8444,
        "screenshot": 8446,
        "git-auth": 8447,
        "glitchtip": 8448,
        "openai-auth": 8450,
        "model-auth": 8452,
        "registry-auth": 8451,
        "metrics": 9091,
    }


# --- Routes ---------------------------------------------------------------


def test_services_route_is_edge_tls_behind_oauth_sidecar():
    route = find(render_objects(), "Route", "devbot-proxy-services")
    spec = route["spec"]
    assert spec["host"] in (None, "")  # router-assigned by default
    assert spec["to"] == {"kind": "Service", "name": "devbot-proxy-gateways"}
    assert spec["port"]["targetPort"] == "gateway-auth"
    tls = spec["tls"]
    assert tls["termination"] == "edge"
    assert tls["insecureEdgeTerminationPolicy"] == "Redirect"


def test_exactly_one_new_public_route_no_grpc_no_forward():
    """Thinclients use HTTP under the shared gateway: no other endpoints."""
    objects = render_objects()
    names = [o["metadata"]["name"] for o in objects if o["kind"] == "Route"]
    assert "devbot-proxy-executor" not in names
    assert "devbot-proxy-forward" not in names
    # Exactly one new public Route targets the gateways Service.
    gateway_routes = [o for o in objects if o["kind"] == "Route" and o["spec"]["to"]["name"] == "devbot-proxy-gateways"]
    assert [o["metadata"]["name"] for o in gateway_routes] == ["devbot-proxy-services"]
    # No 9443/9444 listeners anywhere in the new wiring.
    spec = proxy_deployment(objects)
    for c in spec["containers"]:
        for port in c.get("ports", []):
            assert port["containerPort"] not in (9443, 9444)
    # Legacy internal executor gRPC :9090 and Squid :3128 are untouched.
    proxy_service = find(objects, "Service", "devbot-proxy")
    ports = {p["name"]: p["port"] for p in proxy_service["spec"]["ports"]}
    assert ports["executor"] == 9090
    assert ports["squid"] == 3128


def test_forward_route_removed():
    """No forward proxy endpoint: egress is dispatcher-owned policy."""
    objects = render_objects()
    routes = [o for o in objects if o["kind"] == "Route"]
    terminations = [r["spec"]["tls"]["termination"] for r in routes]
    assert "passthrough" not in terminations
    assert "reencrypt" not in terminations


def test_model_route_preserved():
    route = find(render_objects(), "Route", "devbot-proxy-model")
    spec = route["spec"]
    assert spec["to"]["name"] == "devbot-proxy"
    assert spec["port"]["targetPort"] == "model-auth"
    assert spec["tls"]["termination"] == "edge"
    assert spec["tls"]["insecureEdgeTerminationPolicy"] == "Redirect"


# --- Deployment wiring ----------------------------------------------------


def test_oauth_services_sidecar_contract():
    spec = proxy_deployment(render_objects())
    sidecar = container(spec, "oauth-services")
    assert sidecar["image"] == container(spec, "oauth-proxy")["image"]
    ports = {p["name"]: p["containerPort"] for p in sidecar["ports"]}
    assert ports == {"gateway-auth": 8453}
    args = sidecar["args"]
    assert "-http-address=:8453" in args
    assert "-upstream=http://127.0.0.1:8454" in args
    sar = next(a for a in args if a.startswith("--openshift-sar="))
    delegate = next(a for a in args if a.startswith("--openshift-delegate-urls="))
    # Token-mint SAR for the minted identity, not the broad projects/list.
    assert '"resource": "serviceaccounts"' in sar
    assert '"resourceName": "devbot-memory-server"' in sar
    assert '"namespace": "test-ns"' in sar
    assert "projects" not in sar and "projects" not in delegate
    assert "--cookie-secret-file=/etc/secrets/session_secret" in args
    assert "--client-id=system:serviceaccount:test-ns:devbot-proxy" in args
    mounts = {m["name"]: m for m in sidecar["volumeMounts"]}
    assert mounts["oauth-proxy-cookie-secret"]["mountPath"] == "/etc/secrets"
    assert mounts["oauth-proxy-cookie-secret"]["readOnly"] is True
    assert sidecar["resources"] == container(spec, "oauth-proxy")["resources"]
    # Inert when disabled: no probe depends on the loopback mux.
    assert "livenessProbe" not in sidecar and "readinessProbe" not in sidecar


def test_existing_oauth_proxy_sidecar_preserved():
    spec = proxy_deployment(render_objects())
    sidecar = container(spec, "oauth-proxy")
    args = sidecar["args"]
    assert "-http-address=:8452" in args
    assert "-upstream=http://localhost:8450" in args


def test_proxy_gateway_env_contract():
    spec = proxy_deployment(render_objects())
    env = env_map(container(spec, "proxy"))
    for name, value in GATEWAY_ENV.items():
        assert env.get(name) == value, name
    # Removed gateway env must not resurface.
    for name in (
        "AGENT_GRPC_GATEWAY_ENABLED",
        "AGENT_FORWARD_GATEWAY_ENABLED",
        "GATEWAY_AUTH_NAMESPACE",
        "GATEWAY_AUTH_SERVICE_ACCOUNT",
        "GATEWAY_GRPC_TLS_CERT",
        "GATEWAY_GRPC_TLS_KEY",
        "GATEWAY_FORWARD_TLS_CERT",
        "GATEWAY_FORWARD_TLS_KEY",
    ):
        assert name not in env


def test_no_gateway_certificate_volume_dependency():
    spec = proxy_deployment(render_objects())
    volume_names = {v["name"] for v in spec["volumes"]}
    assert volume_names == {"oauth-proxy-cookie-secret"}
    # The proxy container mounts nothing new.
    assert container(spec, "proxy").get("volumeMounts") is None
    # No certificate Secret parameter or reference remains in the template.
    raw = TEMPLATE.read_text()
    assert "GATEWAY_TLS_SECRET" not in raw
    assert "agent-gateway-tls" not in raw


def test_proxy_container_ports_unchanged_plus_no_new_listeners():
    spec = proxy_deployment(render_objects())
    ports = {p["name"]: p["containerPort"] for p in container(spec, "proxy")["ports"]}
    # The existing port set is preserved exactly.
    assert ports == {
        "squid": 3128,
        "executor": 9090,
        "vertex-auth": 8443,
        "jira-mcp": 8444,
        "screenshot": 8446,
        "git-auth": 8447,
        "glitchtip": 8448,
        "openai-auth": 8450,
        "registry-auth": 8451,
        "metrics": 9091,
    }
    # The loopback mux :8454 and executor wrapper :8455 are not declared
    # as container ports.
    assert 8454 not in ports.values()
    assert 8455 not in ports.values()


def test_no_service_serving_cert_wiring():
    """Passthrough design: no serving-cert annotation or generated volume."""
    raw = TEMPLATE.read_text()
    assert "service.beta.openshift.io/serving-cert-secret-name" not in raw
    spec = proxy_deployment(render_objects())
    for volume in spec["volumes"]:
        assert volume["name"] != "agent-gateway-grpc-tls"
        assert volume["name"] != "agent-gateway-forward-tls"


# --- NetworkPolicy --------------------------------------------------------


def test_router_networkpolicy_allows_new_public_port_only():
    policy = find(render_objects(), "NetworkPolicy", "devbot-proxy-ingress")
    router_rules = []
    for rule in policy["spec"]["ingress"]:
        for peer in rule["from"]:
            labels = peer.get("namespaceSelector", {}).get("matchLabels", {})
            if labels.get("network.openshift.io/policy-group") == "ingress":
                router_rules.append(sorted(p["port"] for p in rule["ports"]))
    assert [8452] in router_rules  # model gateway preserved
    assert [8453] in router_rules  # services gateway, one new port only
    assert [9443] not in router_rules  # no public gRPC port
    assert [9444] not in router_rules  # no forward proxy port


def test_legacy_internal_access_rule_unchanged():
    policy = find(render_objects(), "NetworkPolicy", "devbot-proxy-ingress")
    bot_rule = policy["spec"]["ingress"][0]
    assert bot_rule["from"] == [{"podSelector": {"matchLabels": {"app.kubernetes.io/part-of": "devbot"}}}]
    assert sorted(p["port"] for p in bot_rule["ports"]) == [
        3128,
        8443,
        8444,
        8446,
        8447,
        8448,
        8450,
        8451,
        9090,
    ]


def test_loopback_listeners_8454_8455_never_exposed():
    objects = render_objects()
    for obj in objects:
        if obj["kind"] == "NetworkPolicy":
            for rule in obj["spec"].get("ingress", []):
                for port in rule.get("ports", []):
                    assert port["port"] not in (8454, 8455)
        if obj["kind"] == "Service":
            for port in obj["spec"].get("ports", []):
                assert port["port"] not in (8454, 8455)
    spec = proxy_deployment(objects)
    for c in spec["containers"]:
        for port in c.get("ports", []):
            assert port["containerPort"] not in (8454, 8455)
    # No phantom :8455 server anywhere in the template, comments included:
    # the shared executor :9090 serves both gRPC and HTTP /executor/execute.
    raw = TEMPLATE.read_text()
    assert "8455" not in raw
    # The only reference to the loopback mux is the sidecar upstream.
    sidecar = container(spec, "oauth-services")
    assert "-upstream=http://127.0.0.1:8454" in sidecar["args"]


def test_no_ingresscontroller_mutation_recorded():
    """Edge termination only: no cluster-level IngressController change."""
    raw = TEMPLATE.read_text()
    assert "default-enable-http2" not in raw
    assert "ingresscontrollers/" not in raw


# --- dispatcher public-egress opt-in (policy worker) ----------------------


def test_dispatcher_public_egress_flag_default_false_and_deployment_owned():
    """Central opt-in only: default false, env-wired, no per-agent knob."""
    template = yaml.safe_load(DISPATCHER_TEMPLATE.read_text())
    params = {p["name"]: p for p in template["parameters"]}
    flag = params["AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED"]
    assert flag["value"] == "false"
    # Deployment-owned only: no per-instance/per-agent egress parameters
    # and no service URL parameters (policy worker not implemented there).
    egress_params = [n for n in params if "EGRESS" in n]
    assert egress_params == ["AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED"]
    assert not [n for n in params if "EGRESS_URL" in n]

    deployments = [o for o in template["objects"] if o["kind"] == "Deployment"]
    assert len(deployments) == 1  # single central deployment, no per-agent
    container_spec = deployments[0]["spec"]["template"]["spec"]["containers"][0]
    env = {e["name"]: e for e in container_spec["env"]}
    entry = env["AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED"]
    assert entry["value"] == "${AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED}"
    assert "valueFrom" not in entry  # plain GitOps flag, not a secret
