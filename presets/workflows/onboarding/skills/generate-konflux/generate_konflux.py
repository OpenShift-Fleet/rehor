#!/usr/bin/env python3
"""Generate Konflux onboarding files for konflux-release-data repo.

Usage:
    python3 generate_konflux.py '<json_config>' <konflux_repo_path>

Writes tenant namespace, RBAC, Application, Component, ImageRepository,
ReleasePlan, RPA, constraints, and CODEOWNERS entries.
"""

import json
import re
import sys
from pathlib import Path

_SAFE_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")


def _discover_cluster_suffix(cluster, repo_path):
    config_dir = Path(repo_path) / "config"
    if not config_dir.is_dir():
        raise ValueError(f"config/ directory not found in {repo_path}")
    matches = [d.name for d in config_dir.iterdir() if d.is_dir() and d.name.startswith(f"{cluster}.")]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        picked = sorted(matches)[0]
        print(
            f"WARNING: Multiple cluster suffixes found for '{cluster}': {sorted(matches)}. Using '{picked}'.",
            file=sys.stderr,
        )
        return picked
    raise ValueError(
        f"No cluster suffix found for '{cluster}' in {config_dir}. "
        f"Available: {sorted(d.name for d in config_dir.iterdir() if d.is_dir() and '.' in d.name)}"
    )


def _discover_service_account(repo_path, cluster_suffix):
    """Discover the release SA name from existing RPA files in the repo."""
    config_dir = Path(repo_path) / "config"
    search_dirs = [config_dir / cluster_suffix / "service" / "ReleasePlanAdmission"]
    if not search_dirs[0].is_dir():
        search_dirs = sorted(
            d / "service" / "ReleasePlanAdmission"
            for d in config_dir.iterdir()
            if d.is_dir() and (d / "service" / "ReleasePlanAdmission").is_dir()
        )
    for rpa_base in search_dirs:
        for rpa_file in sorted(rpa_base.rglob("*.yaml")):
            try:
                content = rpa_file.read_text()
            except OSError:
                continue
            match = re.search(r"serviceAccountName:\s*(\S+)", content)
            if match:
                return match.group(1)
    raise ValueError(f"No existing ReleasePlanAdmission files found in {config_dir} to discover service account name")


def _ns_yaml(tenant, cost_center):
    return (
        "---\n"
        "apiVersion: v1\n"
        "kind: Namespace\n"
        "metadata:\n"
        "  labels:\n"
        "    konflux-ci.dev/type: tenant\n"
        f'    cost-center: "{cost_center}"\n'
        '    cost_management_optimizations: "true"\n'
        f"  name: {tenant}\n"
    )


def _admin_kustomization(tenant, quota_tier):
    return (
        "---\n"
        "apiVersion: kustomize.config.k8s.io/v1beta1\n"
        "kind: Kustomization\n"
        f"namespace: {tenant}\n"
        "resources:\n"
        f"  - ../../../../lib/quota/{quota_tier}\n"
        "  - ns.yaml\n"
    )


def _rbac_yaml(tenant, role_suffix, cluster_role, users):
    subjects = ""
    if users:
        subjects = "\n".join(f"  - apiGroup: rbac.authorization.k8s.io\n    kind: User\n    name: {u}" for u in users)
        subjects = f"subjects:\n{subjects}\n"
    else:
        subjects = "subjects: []\n"

    return (
        "---\n"
        "apiVersion: rbac.authorization.k8s.io/v1\n"
        "kind: RoleBinding\n"
        "metadata:\n"
        "  creationTimestamp: null\n"
        f"  name: {tenant}-konflux-{role_suffix}\n"
        "roleRef:\n"
        "  apiGroup: rbac.authorization.k8s.io\n"
        "  kind: ClusterRole\n"
        f"  name: {cluster_role}\n"
        f"{subjects}"
    )


def _tenant_kustomization(tenant, rbac_files, app_dirs):
    resources = "\n".join(f"  - {r}" for r in rbac_files + app_dirs)
    return (
        "---\n"
        "apiVersion: kustomize.config.k8s.io/v1beta1\n"
        "kind: Kustomization\n"
        f"namespace: {tenant}\n"
        f"resources:\n{resources}\n"
    )


def _application_yaml(instance_name, tenant=None):
    ns = f"  namespace: {tenant}\n" if tenant else ""
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: Application\n"
        "metadata:\n"
        f"  name: {instance_name}\n"
        f"{ns}"
        "spec:\n"
        f"  displayName: {instance_name}\n"
    )


def _component_yaml(instance_name, repo_url, dockerfile, target_branch, tenant=None):
    ns = f"  namespace: {tenant}\n" if tenant else ""
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: Component\n"
        "metadata:\n"
        f"  name: {instance_name}\n"
        f"{ns}"
        "  annotations:\n"
        "    build.appstudio.openshift.io/request: configure-pac\n"
        '    build.appstudio.openshift.io/pipeline: \'{"name":"docker-build","bundle":"latest"}\'\n'
        "spec:\n"
        f"  application: {instance_name}\n"
        f"  componentName: {instance_name}\n"
        "  source:\n"
        "    git:\n"
        f"      revision: {target_branch}\n"
        f"      url: {repo_url}\n"
        f"      dockerfileUrl: {dockerfile}\n"
        "      context: ./\n"
    )


def _image_repository_yaml(instance_name, quay_org, tenant=None):
    ns = f"  namespace: {tenant}\n" if tenant else ""
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: ImageRepository\n"
        "metadata:\n"
        "  annotations:\n"
        '    image-controller.appstudio.redhat.com/update-component-image: "true"\n'
        f"  name: {instance_name}-image-repository\n"
        f"{ns}"
        "  labels:\n"
        f"    appstudio.redhat.com/application: {instance_name}\n"
        f"    appstudio.redhat.com/component: {instance_name}\n"
        "spec:\n"
        "  image:\n"
        f"    name: {quay_org}/{instance_name}\n"
        "    visibility: public\n"
        "  notifications:\n"
        "    - config:\n"
        "        url: https://bombino.api.redhat.com/v1/sbom/quay/push\n"
        "      event: repo_push\n"
        "      method: webhook\n"
        "      title: SBOM-event-to-Bombino\n"
    )


def _release_plan_yaml(instance_name, tenant=None):
    ns = f"  namespace: {tenant}\n" if tenant else ""
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: ReleasePlan\n"
        "metadata:\n"
        "  labels:\n"
        '    release.appstudio.openshift.io/auto-release: "true"\n'
        '    release.appstudio.openshift.io/standing-attribution: "true"\n'
        f'    release.appstudio.openshift.io/releasePlanAdmission: "{instance_name}"\n'
        f"  name: {instance_name}-releaseplan\n"
        f"{ns}"
        "spec:\n"
        f"  application: {instance_name}\n"
        "  target: rhtap-releng-tenant\n"
    )


def _integration_test_yaml(instance_name, tenant=None):
    ns = f"  namespace: {tenant}\n" if tenant else ""
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1beta2\n"
        "kind: IntegrationTestScenario\n"
        "metadata:\n"
        f"  name: {instance_name}-enterprise-contract\n"
        f"{ns}"
        "spec:\n"
        f"  application: {instance_name}\n"
        "  contexts:\n"
        "    - description: Application testing\n"
        "      name: application\n"
        "  params:\n"
        "    - name: POLICY_CONFIGURATION\n"
        "      value: rhtap-releng-tenant/app-interface-standard\n"
        "  resolverRef:\n"
        "    params:\n"
        "      - name: url\n"
        "        value: https://github.com/konflux-ci/build-definitions\n"
        "      - name: revision\n"
        "        value: main\n"
        "      - name: pathInRepo\n"
        "        value: pipelines/enterprise-contract.yaml\n"
        "    resolver: git\n"
    )


def _app_kustomization(tenant, instance_name):
    return (
        "---\n"
        "apiVersion: kustomize.config.k8s.io/v1beta1\n"
        "kind: Kustomization\n"
        f"namespace: {tenant}\n"
        "resources:\n"
        "  - application.yaml\n"
        "  - release-plan.yaml\n"
        "  - integration-test-scenario.yaml\n"
        f"  - {instance_name}/component.yaml\n"
        f"  - {instance_name}/image-repository.yaml\n"
    )


def _rpa_yaml(service_name, instance_name, tenant, quay_org, service_account):
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: ReleasePlanAdmission\n"
        "metadata:\n"
        "  labels:\n"
        '    release.appstudio.openshift.io/block-releases: "false"\n'
        "    pp.engineering.redhat.com/business-unit: other\n"
        f"  name: {instance_name}\n"
        "  namespace: rhtap-releng-tenant\n"
        "spec:\n"
        "  applications:\n"
        f"    - {instance_name}\n"
        f"  origin: {tenant}\n"
        "  policy: app-interface-standard\n"
        "  data:\n"
        "    releaseNotes:\n"
        f"      product_name: {instance_name}\n"
        "      product_version: 1.0.0\n"
        "    mapping:\n"
        "      components:\n"
        f"        - name: {instance_name}\n"
        "          repositories:\n"
        f'            - url: "quay.io/redhat-services-prod/{quay_org}/{instance_name}"\n'
        "              tags:\n"
        "                - latest\n"
        '                - "{{ git_sha }}"\n'
        '                - "{{ git_short_sha }}"\n'
        '                - "{{ digest_sha }}"\n'
        "          public: true\n"
        "          pushSourceContainer: false\n"
        "      registrySecret: konflux-release-service-access-management-token\n"
        "    intention: production\n"
        "  pipeline:\n"
        "    pipelineRef:\n"
        "      resolver: git\n"
        "      params:\n"
        "        - name: url\n"
        '          value: "https://github.com/konflux-ci/release-service-catalog.git"\n'
        "        - name: revision\n"
        "          value: production\n"
        "        - name: pathInRepo\n"
        '          value: "pipelines/managed/rh-push-to-external-registry/rh-push-to-external-registry.yaml"\n'
        f"    serviceAccountName: {service_account}\n"
        "    timeouts:\n"
        '      pipeline: "1h0m0s"\n'
        "      tasks: 1h0m0s\n"
    )


def _constraints_yaml(service_name, tenant, quay_org, service_account, instance_name=None):
    tenant_re = re.escape(tenant)
    quay_org_re = re.escape(quay_org)
    instance_re = re.escape(instance_name or service_name)
    sa_base = re.sub(r"-(staging|prod)$", "", service_account)
    if sa_base == service_account:
        sa_pattern = re.escape(service_account)
    else:
        sa_pattern = f"{re.escape(sa_base)}-((staging)|(prod))"
    return (
        "---\n"
        "properties:\n"
        "  spec:\n"
        "    properties:\n"
        "      origin:\n"
        "        type: string\n"
        f"        pattern: ^{tenant_re}$\n"
        "      policy:\n"
        "        pattern: ^app-interface-standard$\n"
        "      data:\n"
        "        properties:\n"
        "          mapping:\n"
        "            properties:\n"
        "              components:\n"
        "                type: array\n"
        "                items:\n"
        "                  properties:\n"
        "                    repositories:\n"
        "                      type: array\n"
        "                      items:\n"
        "                        properties:\n"
        "                          url:\n"
        "                            type: string\n"
        f"                            pattern: ^quay\\.io/redhat-services-prod/{quay_org_re}/{instance_re}.*\n"
        "      pipeline:\n"
        "        properties:\n"
        "          pipelineRef:\n"
        "            properties:\n"
        "              resolver:\n"
        "                pattern: git\n"
        "              params:\n"
        "                items:\n"
        "                  oneOf:\n"
        "                    - properties:\n"
        "                        name:\n"
        "                          pattern: url\n"
        "                        value:\n"
        "                          pattern: https://github.com/konflux-ci/release-service-catalog.git\n"
        "                    - properties:\n"
        "                        name:\n"
        "                          pattern: revision\n"
        "                        value:\n"
        "                          pattern: production\n"
        "                    - properties:\n"
        "                        name:\n"
        "                          pattern: pathInRepo\n"
        "                        value:\n"
        "                          pattern: pipelines/managed/"
        "rh-push-to-external-registry/"
        "rh-push-to-external-registry.yaml\n"
        "          serviceAccountName:\n"
        f"            pattern: {sa_pattern}\n"
    )


def _update_codeowners(repo_path, tenant, cluster, cluster_suffix, service_name):
    codeowners_path = Path(repo_path) / "CODEOWNERS"
    existing_lines = []
    if codeowners_path.exists():
        existing_lines = codeowners_path.read_text().splitlines()

    new_entries = [
        f"/auto-generated/cluster/{cluster}/admin/{tenant}/ @konflux-ci/konflux-release-tenant-admins",
        f"/auto-generated/cluster/{cluster}/tenants/{tenant}/ @konflux-ci/konflux-release-tenant-admins",
        f"/config/{cluster_suffix}/service/ReleasePlanAdmission/{service_name}/ @konflux-ci/konflux-release-rpa-admins",
        f"/constraints/service/{service_name}.yaml @konflux-ci/konflux-release-rpa-admins",
        f"/tenants-config/cluster/{cluster}/admin/{tenant}/ @konflux-ci/konflux-release-tenant-admins",
        f"/tenants-config/cluster/{cluster}/tenants/{tenant}/ @konflux-ci/konflux-release-tenant-admins",
    ]

    entries_to_add = []
    for entry in new_entries:
        path_prefix = entry.split()[0]
        if not any(line.startswith(path_prefix) for line in existing_lines):
            entries_to_add.append(entry)

    if entries_to_add:
        entries_to_add.sort()
        existing_lines.extend(entries_to_add)
    codeowners_path.write_text("\n".join(existing_lines) + "\n")


def _validate_name(value, field):
    if not _SAFE_NAME.match(value):
        raise ValueError(f"Invalid {field}: {value!r} — must match [a-zA-Z0-9._-]")


def generate(cfg, repo_path):
    root = Path(repo_path)
    tenant = cfg["tenant"]
    cluster = cfg.get("cluster", "kflux-prd-rh02")
    cluster_suffix = _discover_cluster_suffix(cluster, repo_path)
    service_account = _discover_service_account(repo_path, cluster_suffix)
    instance_name = cfg["instance_name"]
    repo_url = cfg["repo_url"]

    for name, field in [
        (tenant, "tenant"),
        (cluster, "cluster"),
        (instance_name, "instance_name"),
    ]:
        _validate_name(name, field)
    dockerfile = cfg.get("dockerfile", "dev-bot/Dockerfile.runner")
    target_branch = cfg.get("target_branch", "main")
    admins = cfg.get("admins", [])
    maintainers = cfg.get("maintainers", [])
    cost_center = cfg.get("cost_center", "")
    quota_tier = cfg.get("quota_tier", "1.small")
    quay_org = cfg["quay_org"]
    service_name = cfg.get("service_name", instance_name)
    new_tenant = cfg.get("new_tenant", True)

    for name, field in [(quay_org, "quay_org"), (service_name, "service_name")]:
        _validate_name(name, field)

    files_written = []

    if new_tenant:
        if not cost_center:
            raise ValueError("cost_center is required when creating a new tenant")
        admin_dir = root / "tenants-config" / "cluster" / cluster / "admin" / tenant
        admin_dir.mkdir(parents=True, exist_ok=True)
        (admin_dir / "ns.yaml").write_text(_ns_yaml(tenant, cost_center))
        (admin_dir / "kustomization.yaml").write_text(_admin_kustomization(tenant, quota_tier))
        files_written.extend(
            [
                str((admin_dir / "ns.yaml").relative_to(root)),
                str((admin_dir / "kustomization.yaml").relative_to(root)),
            ]
        )

        tenant_dir = root / "tenants-config" / "cluster" / cluster / "tenants" / tenant
        tenant_dir.mkdir(parents=True, exist_ok=True)
        (tenant_dir / "rbac-admins.yaml").write_text(_rbac_yaml(tenant, "admins", "konflux-admin-user-actions", admins))
        (tenant_dir / "rbac-maintainers.yaml").write_text(
            _rbac_yaml(tenant, "maintainers", "konflux-maintainer-user-actions", maintainers)
        )
        (tenant_dir / "rbac-contributors.yaml").write_text(
            _rbac_yaml(tenant, "contributors", "konflux-contributor-user-actions", [])
        )
        (tenant_dir / "kustomization.yaml").write_text(
            _tenant_kustomization(
                tenant,
                [
                    "rbac-admins.yaml",
                    "rbac-contributors.yaml",
                    "rbac-maintainers.yaml",
                ],
                [instance_name],
            )
        )
        files_written.extend(
            [
                str((tenant_dir / f).relative_to(root))
                for f in ["rbac-admins.yaml", "rbac-maintainers.yaml", "rbac-contributors.yaml", "kustomization.yaml"]
            ]
        )

    tenant_dir = root / "tenants-config" / "cluster" / cluster / "tenants" / tenant
    tenant_dir.mkdir(parents=True, exist_ok=True)

    if new_tenant:
        app_dir = tenant_dir / instance_name
        comp_dir = app_dir / instance_name
        comp_dir.mkdir(parents=True, exist_ok=True)

        (app_dir / "application.yaml").write_text(_application_yaml(instance_name))
        (app_dir / "release-plan.yaml").write_text(_release_plan_yaml(instance_name))
        (app_dir / "integration-test-scenario.yaml").write_text(_integration_test_yaml(instance_name))
        (app_dir / "kustomization.yaml").write_text(_app_kustomization(tenant, instance_name))
        (comp_dir / "component.yaml").write_text(_component_yaml(instance_name, repo_url, dockerfile, target_branch))
        (comp_dir / "image-repository.yaml").write_text(_image_repository_yaml(instance_name, quay_org))
        files_written.extend(
            [
                str((app_dir / f).relative_to(root))
                for f in [
                    "application.yaml",
                    "release-plan.yaml",
                    "integration-test-scenario.yaml",
                    "kustomization.yaml",
                ]
            ]
        )
        files_written.extend(
            [
                str((comp_dir / f).relative_to(root))
                for f in [
                    "component.yaml",
                    "image-repository.yaml",
                ]
            ]
        )
    else:
        combined = _application_yaml(instance_name, tenant) + _component_yaml(
            instance_name, repo_url, dockerfile, target_branch, tenant
        )
        new_files = [
            f"{instance_name}.yaml",
            f"{instance_name}.imagerepository.yaml",
            f"{instance_name}.release-plan.yaml",
            f"{instance_name}.enterprise-contract.integrationtestscenario.yaml",
        ]
        (tenant_dir / new_files[0]).write_text(combined)
        (tenant_dir / new_files[1]).write_text(_image_repository_yaml(instance_name, quay_org, tenant))
        (tenant_dir / new_files[2]).write_text(_release_plan_yaml(instance_name, tenant))
        (tenant_dir / new_files[3]).write_text(_integration_test_yaml(instance_name, tenant))
        files_written.extend([str((tenant_dir / f).relative_to(root)) for f in new_files])

        kustom_path = tenant_dir / "kustomization.yaml"
        if kustom_path.exists():
            kustom_content = kustom_path.read_text()
            for f in new_files:
                if f not in kustom_content:
                    lines = kustom_content.splitlines(keepends=True)
                    insert_idx = len(lines)
                    in_resources = False
                    for i, line in enumerate(lines):
                        stripped = line.rstrip()
                        if stripped == "resources:" or stripped.startswith("resources:"):
                            in_resources = True
                            continue
                        if in_resources:
                            if stripped.startswith("  - ") or stripped == "":
                                insert_idx = i + 1
                            else:
                                insert_idx = i
                                break
                    lines.insert(insert_idx, f"  - {f}\n")
                    kustom_content = "".join(lines)
            kustom_path.write_text(kustom_content)
            files_written.append(str(kustom_path.relative_to(root)))

    rpa_dir = root / "config" / cluster_suffix / "service" / "ReleasePlanAdmission" / service_name
    rpa_dir.mkdir(parents=True, exist_ok=True)
    (rpa_dir / f"{instance_name}.yaml").write_text(
        _rpa_yaml(service_name, instance_name, tenant, quay_org, service_account)
    )
    files_written.append(str((rpa_dir / f"{instance_name}.yaml").relative_to(root)))

    if new_tenant:
        constraints_dir = root / "constraints" / "service"
        constraints_dir.mkdir(parents=True, exist_ok=True)
        (constraints_dir / f"{service_name}.yaml").write_text(
            _constraints_yaml(service_name, tenant, quay_org, service_account, instance_name)
        )
        files_written.append(str((constraints_dir / f"{service_name}.yaml").relative_to(root)))

    if new_tenant:
        _update_codeowners(repo_path, tenant, cluster, cluster_suffix, service_name)
        files_written.append("CODEOWNERS")

    return {"files_written": sorted(files_written), "new_tenant": new_tenant}


def main():
    if len(sys.argv) < 3:
        print("Usage: generate_konflux.py '<json_config>' <konflux_repo_path>", file=sys.stderr)
        sys.exit(1)

    try:
        cfg = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    repo_path = sys.argv[2]
    if not cfg.get("tenant"):
        print(json.dumps({"error": "tenant is required"}))
        sys.exit(1)
    if not cfg.get("instance_name"):
        print(json.dumps({"error": "instance_name is required"}))
        sys.exit(1)
    if not cfg.get("repo_url"):
        print(json.dumps({"error": "repo_url is required"}))
        sys.exit(1)
    if not cfg.get("quay_org"):
        print(json.dumps({"error": "quay_org is required"}))
        sys.exit(1)

    result = generate(cfg, repo_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
