#!/usr/bin/env python3
"""Generate Konflux onboarding files for konflux-release-data repo.

Usage:
    python3 generate_konflux.py '<json_config>' <konflux_repo_path>

Writes tenant namespace, RBAC, Application, Component, ImageRepository,
ReleasePlan, RPA, constraints, and CODEOWNERS entries.
"""

import json
import sys
from pathlib import Path

CLUSTER_SUFFIXES = {
    "kflux-prd-rh02": "kflux-prd-rh02.0fk9.p1",
    "kflux-prd-rh03": "kflux-prd-rh03.nnv1.p1",
    "kflux-ocp-p01": "kflux-ocp-p01.7ayg.p1",
}


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
        subjects = "\n".join(
            f"  - apiGroup: rbac.authorization.k8s.io\n"
            f"    kind: User\n"
            f"    name: {u}"
            for u in users
        )
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


def _application_yaml(app_name):
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: Application\n"
        "metadata:\n"
        f"  name: {app_name}\n"
        "spec:\n"
        f"  description: {app_name}\n"
        f"  displayName: {app_name}\n"
    )


def _component_yaml(component_name, app_name, source_url, dockerfile, default_branch):
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: Component\n"
        "metadata:\n"
        "  annotations:\n"
        "    build.appstudio.openshift.io/pipeline: '{\"name\":\"docker-build\",\"bundle\":\"latest\"}'\n"
        "    build.appstudio.openshift.io/request: configure-pac\n"
        f"  name: {component_name}\n"
        "spec:\n"
        f"  application: {app_name}\n"
        f"  componentName: {component_name}\n"
        "  source:\n"
        "    git:\n"
        "      context: ./\n"
        f"      dockerfileUrl: {dockerfile}\n"
        f"      revision: {default_branch}\n"
        f"      url: {source_url}\n"
    )


def _image_repository_yaml(component_name, app_name, tenant):
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: ImageRepository\n"
        "metadata:\n"
        "  annotations:\n"
        '    image-controller.appstudio.redhat.com/update-component-image: "true"\n'
        "  labels:\n"
        f"    appstudio.redhat.com/application: {app_name}\n"
        f"    appstudio.redhat.com/component: {component_name}\n"
        f"  name: {component_name}-image-repository\n"
        "spec:\n"
        "  image:\n"
        f"    name: {tenant}/{app_name}/{component_name}\n"
        "    visibility: public\n"
        "  notifications:\n"
        "    - config:\n"
        "        url: https://bombino.api.redhat.com/v1/sbom/quay/push\n"
        "      event: repo_push\n"
        "      method: webhook\n"
        "      title: SBOM-event-to-Bombino\n"
    )


def _release_plan_yaml(app_name):
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: ReleasePlan\n"
        "metadata:\n"
        "  labels:\n"
        '    release.appstudio.openshift.io/auto-release: "true"\n'
        f"    release.appstudio.openshift.io/releasePlanAdmission: {app_name}\n"
        '    release.appstudio.openshift.io/standing-attribution: "true"\n'
        f"  name: {app_name}-releaseplan\n"
        "spec:\n"
        f"  application: {app_name}\n"
        "  target: rhtap-releng-tenant\n"
    )


def _app_kustomization(tenant, app_name, component_name):
    return (
        "---\n"
        "apiVersion: kustomize.config.k8s.io/v1beta1\n"
        "kind: Kustomization\n"
        f"namespace: {tenant}\n"
        "resources:\n"
        "  - application.yaml\n"
        "  - release-plan.yaml\n"
        f"  - {component_name}/component.yaml\n"
        f"  - {component_name}/image-repository.yaml\n"
    )


def _rpa_yaml(service_name, component_name, app_name, tenant, quay_org):
    return (
        "---\n"
        "apiVersion: appstudio.redhat.com/v1alpha1\n"
        "kind: ReleasePlanAdmission\n"
        "metadata:\n"
        "  labels:\n"
        '    pp.engineering.redhat.com/business-unit: unknown\n'
        '    release.appstudio.openshift.io/block-releases: "false"\n'
        f"  name: {service_name}\n"
        "  namespace: rhtap-releng-tenant\n"
        "spec:\n"
        "  applications:\n"
        f"    - {app_name}\n"
        f"  origin: {tenant}\n"
        "  policy: app-interface-standard\n"
        "  data:\n"
        "    releaseNotes:\n"
        f"      product_name: {service_name}\n"
        '      product_version: "1.0.0"\n'
        "    mapping:\n"
        "      registrySecret: konflux-release-service-access-management-token\n"
        "      defaults:\n"
        "        public: True\n"
        "        tags:\n"
        "          - latest\n"
        "        pushSourceContainer: false\n"
        "      components:\n"
        f"        - name: {component_name}\n"
        "          repositories:\n"
        f'            - url: "quay.io/redhat-services-prod/{quay_org}/"\n'
        "    pyxis:\n"
        "      secret: pyxis-prod-secret\n"
        "      server: production\n"
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
        "    serviceAccountName: release-app-interface-prod\n"
        "    timeouts:\n"
        '      pipeline: "4h0m0s"\n'
        '      tasks: "1h0m0s"\n'
    )


def _constraints_yaml(service_name, tenant, quay_org):
    return (
        "---\n"
        "properties:\n"
        "  spec:\n"
        "    properties:\n"
        "      origin:\n"
        "        type: string\n"
        f"        pattern: {tenant}\n"
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
        f"                            pattern: ^quay.io/redhat-services-prod/{quay_org}/{service_name}*\n"
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
        "                          pattern: pipelines/managed/rh-push-to-external-registry/rh-push-to-external-registry.yaml\n"
        "          serviceAccountName:\n"
        "            pattern: release-app-interface-((staging)|(prod))\n"
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

    for entry in new_entries:
        path_prefix = entry.split()[0]
        if not any(path_prefix in line for line in existing_lines):
            existing_lines.append(entry)

    existing_lines.sort()
    codeowners_path.write_text("\n".join(existing_lines) + "\n")


def generate(cfg, repo_path):
    root = Path(repo_path)
    tenant = cfg["tenant"]
    cluster = cfg.get("cluster", "kflux-prd-rh02")
    cluster_suffix = CLUSTER_SUFFIXES.get(cluster, f"{cluster}.unknown")
    app_name = cfg["app_name"]
    component_name = cfg.get("component_name", app_name)
    source_url = cfg["source_url"]
    dockerfile = cfg.get("dockerfile", "dev-bot/Dockerfile.runner")
    default_branch = cfg.get("default_branch", "master")
    admins = cfg.get("admins", [])
    maintainers = cfg.get("maintainers", [])
    cost_center = cfg.get("cost_center", "735")
    quota_tier = cfg.get("quota_tier", "1.small")
    quay_org = cfg.get("quay_org", "rh-platform-experien-tenant")
    service_name = cfg.get("service_name", app_name)
    new_tenant = cfg.get("new_tenant", True)

    files_written = []

    if new_tenant:
        admin_dir = root / "tenants-config" / "cluster" / cluster / "admin" / tenant
        admin_dir.mkdir(parents=True, exist_ok=True)
        (admin_dir / "ns.yaml").write_text(_ns_yaml(tenant, cost_center))
        (admin_dir / "kustomization.yaml").write_text(_admin_kustomization(tenant, quota_tier))
        files_written.extend([
            str((admin_dir / "ns.yaml").relative_to(root)),
            str((admin_dir / "kustomization.yaml").relative_to(root)),
        ])

        tenant_dir = root / "tenants-config" / "cluster" / cluster / "tenants" / tenant
        tenant_dir.mkdir(parents=True, exist_ok=True)
        (tenant_dir / "rbac-admins.yaml").write_text(
            _rbac_yaml(tenant, "admins", "konflux-admin-user-actions", admins)
        )
        (tenant_dir / "rbac-maintainers.yaml").write_text(
            _rbac_yaml(tenant, "maintainers", "konflux-maintainer-user-actions", maintainers)
        )
        (tenant_dir / "rbac-contributors.yaml").write_text(
            _rbac_yaml(tenant, "contributors", "konflux-contributor-user-actions", [])
        )
        (tenant_dir / "kustomization.yaml").write_text(
            _tenant_kustomization(tenant, [
                "rbac-admins.yaml",
                "rbac-contributors.yaml",
                "rbac-maintainers.yaml",
            ], [app_name])
        )
        files_written.extend([
            str((tenant_dir / f).relative_to(root))
            for f in ["rbac-admins.yaml", "rbac-maintainers.yaml",
                       "rbac-contributors.yaml", "kustomization.yaml"]
        ])

    app_dir = root / "tenants-config" / "cluster" / cluster / "tenants" / tenant / app_name
    comp_dir = app_dir / component_name
    comp_dir.mkdir(parents=True, exist_ok=True)

    (app_dir / "application.yaml").write_text(_application_yaml(app_name))
    (app_dir / "release-plan.yaml").write_text(_release_plan_yaml(app_name))
    (app_dir / "kustomization.yaml").write_text(_app_kustomization(tenant, app_name, component_name))
    (comp_dir / "component.yaml").write_text(
        _component_yaml(component_name, app_name, source_url, dockerfile, default_branch)
    )
    (comp_dir / "image-repository.yaml").write_text(
        _image_repository_yaml(component_name, app_name, tenant)
    )
    files_written.extend([
        str((app_dir / f).relative_to(root))
        for f in ["application.yaml", "release-plan.yaml", "kustomization.yaml"]
    ])
    files_written.extend([
        str((comp_dir / f).relative_to(root))
        for f in ["component.yaml", "image-repository.yaml"]
    ])

    rpa_dir = root / "config" / cluster_suffix / "service" / "ReleasePlanAdmission" / service_name
    rpa_dir.mkdir(parents=True, exist_ok=True)
    (rpa_dir / f"{component_name}.yaml").write_text(
        _rpa_yaml(service_name, component_name, app_name, tenant, quay_org)
    )
    files_written.append(str((rpa_dir / f"{component_name}.yaml").relative_to(root)))

    constraints_dir = root / "constraints" / "service"
    constraints_dir.mkdir(parents=True, exist_ok=True)
    (constraints_dir / f"{service_name}.yaml").write_text(
        _constraints_yaml(service_name, tenant, quay_org)
    )
    files_written.append(str((constraints_dir / f"{service_name}.yaml").relative_to(root)))

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
    if not cfg.get("app_name"):
        print(json.dumps({"error": "app_name is required"}))
        sys.exit(1)
    if not cfg.get("source_url"):
        print(json.dumps({"error": "source_url is required"}))
        sys.exit(1)

    result = generate(cfg, repo_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
