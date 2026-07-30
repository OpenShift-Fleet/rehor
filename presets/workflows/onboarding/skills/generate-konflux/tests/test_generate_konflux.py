import pytest
from generate_konflux import (
    _constraints_yaml,
    _discover_cluster_suffix,
    _discover_service_account,
    _validate_name,
    generate,
)

NEW_TENANT_CONFIG = {
    "tenant": "test-tenant",
    "cluster": "test-cluster",
    "instance_name": "test-agent-dev",
    "repo_url": "https://github.com/TestOrg/test-agent-dev",
    "dockerfile": "dev-bot/Dockerfile.runner",
    "target_branch": "main",
    "admins": ["admin1"],
    "maintainers": ["admin1", "maint1"],
    "cost_center": "735",
    "quota_tier": "1.small",
    "quay_org": "test-tenant",
    "service_name": "test-agent-dev",
    "new_tenant": True,
}

EXISTING_TENANT_CONFIG = {
    **NEW_TENANT_CONFIG,
    "instance_name": "second-agent-dev",
    "service_name": "second-agent-dev",
    "new_tenant": False,
}

EXISTING_RPA_CONTENT = """\
---
apiVersion: appstudio.redhat.com/v1alpha1
kind: ReleasePlanAdmission
metadata:
  name: existing-app
  namespace: rhtap-releng-tenant
spec:
  pipeline:
    serviceAccountName: test-sa-prod
    pipelineRef:
      resolver: git
"""


@pytest.fixture()
def konflux_repo(tmp_path):
    cluster_dir = tmp_path / "config" / "test-cluster.abcd.p1"
    rpa_dir = cluster_dir / "service" / "ReleasePlanAdmission" / "existing-app"
    rpa_dir.mkdir(parents=True)
    (rpa_dir / "existing-app.yaml").write_text(EXISTING_RPA_CONTENT)

    (tmp_path / "constraints" / "service").mkdir(parents=True)

    tc = tmp_path / "tenants-config" / "cluster" / "test-cluster"
    (tc / "admin").mkdir(parents=True)
    (tc / "tenants").mkdir(parents=True)

    (tmp_path / "CODEOWNERS").write_text("")
    return tmp_path


class TestDiscovery:
    def test_cluster_suffix_found(self, konflux_repo):
        assert _discover_cluster_suffix("test-cluster", konflux_repo) == "test-cluster.abcd.p1"

    def test_cluster_suffix_unknown_raises(self, konflux_repo):
        with pytest.raises(ValueError, match="No cluster suffix found for 'nonexistent'"):
            _discover_cluster_suffix("nonexistent", konflux_repo)

    def test_cluster_suffix_missing_config_dir(self, tmp_path):
        with pytest.raises(ValueError, match="config/ directory not found"):
            _discover_cluster_suffix("test-cluster", tmp_path)

    def test_service_account_discovered(self, konflux_repo):
        sa = _discover_service_account(konflux_repo, "test-cluster.abcd.p1")
        assert sa == "test-sa-prod"

    def test_service_account_no_rpas_raises(self, tmp_path):
        (tmp_path / "config" / "empty.xxxx.p1").mkdir(parents=True)
        with pytest.raises(ValueError, match="No existing ReleasePlanAdmission"):
            _discover_service_account(tmp_path, "empty.xxxx.p1")

    def test_cluster_suffix_multiple_warns(self, tmp_path, capsys):
        (tmp_path / "config" / "multi.aaa.p1").mkdir(parents=True)
        (tmp_path / "config" / "multi.zzz.p2").mkdir(parents=True)
        result = _discover_cluster_suffix("multi", tmp_path)
        assert result == "multi.aaa.p1"
        assert "WARNING" in capsys.readouterr().err


class TestValidation:
    def test_valid_name(self):
        _validate_name("my-tenant-123", "tenant")

    def test_invalid_name_starts_with_dash(self):
        with pytest.raises(ValueError, match="tenant"):
            _validate_name("-bad", "tenant")

    def test_missing_cost_center_new_tenant(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "cost_center": ""}
        with pytest.raises(ValueError, match="cost_center"):
            generate(cfg, str(konflux_repo))


class TestNewTenant:
    def test_returns_new_tenant_true(self, konflux_repo):
        result = generate(NEW_TENANT_CONFIG, str(konflux_repo))
        assert result["new_tenant"] is True
        assert len(result["files_written"]) > 0

    def test_namespace_yaml(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        ns_file = konflux_repo / "tenants-config" / "cluster" / "test-cluster" / "admin" / "test-tenant" / "ns.yaml"
        content = ns_file.read_text()
        assert "name: test-tenant" in content
        assert "735" in content

    def test_rbac_admins(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        admins_file = (
            konflux_repo
            / "tenants-config"
            / "cluster"
            / "test-cluster"
            / "tenants"
            / "test-tenant"
            / "rbac-admins.yaml"
        )
        content = admins_file.read_text()
        assert "admin1" in content

    def test_rbac_maintainers(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        maint_file = (
            konflux_repo
            / "tenants-config"
            / "cluster"
            / "test-cluster"
            / "tenants"
            / "test-tenant"
            / "rbac-maintainers.yaml"
        )
        content = maint_file.read_text()
        assert "maint1" in content

    def test_component_yaml(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        comp_file = (
            konflux_repo
            / "tenants-config"
            / "cluster"
            / "test-cluster"
            / "tenants"
            / "test-tenant"
            / "test-agent-dev"
            / "test-agent-dev"
            / "component.yaml"
        )
        content = comp_file.read_text()
        assert "https://github.com/TestOrg/test-agent-dev" in content
        assert "target_branch" not in content or "main" in content

    def test_rpa_uses_discovered_sa(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        rpa_file = (
            konflux_repo
            / "config"
            / "test-cluster.abcd.p1"
            / "service"
            / "ReleasePlanAdmission"
            / "test-agent-dev"
            / "test-agent-dev.yaml"
        )
        content = rpa_file.read_text()
        assert "serviceAccountName: test-sa-prod" in content

    def test_constraints_uses_derived_sa_pattern(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        constraints_file = konflux_repo / "constraints" / "service" / "test-agent-dev.yaml"
        content = constraints_file.read_text()
        assert "test\\-sa-((staging)|(prod))" in content

    def test_constraints_sa_pattern_no_suffix(self):
        content = _constraints_yaml("svc", "tenant", "org", "my-release-sa")
        assert "my\\-release\\-sa" in content
        assert "((staging)|(prod))" not in content

    def test_integration_test_scenario_created(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        its_file = (
            konflux_repo
            / "tenants-config"
            / "cluster"
            / "test-cluster"
            / "tenants"
            / "test-tenant"
            / "test-agent-dev"
            / "integration-test-scenario.yaml"
        )
        assert its_file.exists()
        content = its_file.read_text()
        assert "IntegrationTestScenario" in content
        assert "test-agent-dev-enterprise-contract" in content

    def test_kustomization_references_integration_test(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        kustom_file = (
            konflux_repo
            / "tenants-config"
            / "cluster"
            / "test-cluster"
            / "tenants"
            / "test-tenant"
            / "test-agent-dev"
            / "kustomization.yaml"
        )
        content = kustom_file.read_text()
        assert "integration-test-scenario.yaml" in content

    def test_codeowners_updated(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        content = (konflux_repo / "CODEOWNERS").read_text()
        assert "test-tenant" in content
        assert "test-cluster.abcd.p1" in content


class TestInputSanitization:
    def test_rejects_cost_center_with_path_traversal(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "cost_center": "../etc"}
        with pytest.raises(ValueError, match="cost_center"):
            generate(cfg, str(konflux_repo))

    def test_rejects_quota_tier_with_dotdot(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "quota_tier": "../../etc"}
        with pytest.raises(ValueError, match="quota_tier"):
            generate(cfg, str(konflux_repo))

    def test_rejects_admin_with_newline(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "admins": ["admin1\ninjected"]}
        with pytest.raises(ValueError, match="admin username"):
            generate(cfg, str(konflux_repo))

    def test_rejects_maintainer_with_special_chars(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "maintainers": ["user; rm -rf /"]}
        with pytest.raises(ValueError, match="maintainer username"):
            generate(cfg, str(konflux_repo))

    def test_rejects_repo_url_without_https(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "repo_url": "file:///etc/passwd"}
        with pytest.raises(ValueError, match="repo_url"):
            generate(cfg, str(konflux_repo))

    def test_rejects_repo_url_with_newline(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "repo_url": "https://evil.com\ninjected: true"}
        with pytest.raises(ValueError, match="repo_url"):
            generate(cfg, str(konflux_repo))

    def test_rejects_dockerfile_with_dotdot(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "dockerfile": "../../etc/passwd"}
        with pytest.raises(ValueError, match="dockerfile"):
            generate(cfg, str(konflux_repo))

    def test_rejects_dockerfile_with_newline(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "dockerfile": "Dockerfile\nRUN evil"}
        with pytest.raises(ValueError, match="dockerfile"):
            generate(cfg, str(konflux_repo))

    def test_rejects_target_branch_with_special_chars(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "target_branch": "main; echo pwned"}
        with pytest.raises(ValueError, match="target_branch"):
            generate(cfg, str(konflux_repo))

    def test_valid_admins_accepted(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "admins": ["user@redhat.com", "kerberos.user"]}
        result = generate(cfg, str(konflux_repo))
        assert result["new_tenant"] is True


class TestExistingTenantGuards:
    def test_missing_cluster_errors(self, konflux_repo):
        cfg = {**EXISTING_TENANT_CONFIG, "cluster": None, "tenant": "nonexistent-tenant"}
        with pytest.raises(ValueError, match="not found in any cluster"):
            generate(cfg, str(konflux_repo))

    def test_missing_tenant_dir_errors(self, konflux_repo):
        cfg = {**EXISTING_TENANT_CONFIG, "tenant": "nonexistent-tenant"}
        with pytest.raises(ValueError, match="Tenant directory not found"):
            generate(cfg, str(konflux_repo))

    def test_missing_kustomization_errors(self, konflux_repo):
        tenant_dir = konflux_repo / "tenants-config" / "cluster" / "test-cluster" / "tenants" / "test-tenant"
        tenant_dir.mkdir(parents=True, exist_ok=True)
        cfg = {**EXISTING_TENANT_CONFIG}
        with pytest.raises(ValueError, match="kustomization.yaml not found"):
            generate(cfg, str(konflux_repo))


class TestCodeownersAdminUsernames:
    def test_uses_admin_usernames_not_groups(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "admins": ["alice", "bob"]}
        generate(cfg, str(konflux_repo))
        content = (konflux_repo / "CODEOWNERS").read_text()
        assert "@alice" in content
        assert "@bob" in content
        assert "konflux-ci" not in content

    def test_codeowners_for_existing_tenant(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        cfg = {**EXISTING_TENANT_CONFIG, "admins": ["charlie"]}
        generate(cfg, str(konflux_repo))
        content = (konflux_repo / "CODEOWNERS").read_text()
        assert "ReleasePlanAdmission/second-agent-dev" in content
        assert "@charlie" in content

    def test_no_admins_skips_codeowners(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "admins": []}
        generate(cfg, str(konflux_repo))
        content = (konflux_repo / "CODEOWNERS").read_text()
        assert content.strip() == ""

    def test_new_tenant_includes_tenant_dir_entries(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "admins": ["alice"]}
        generate(cfg, str(konflux_repo))
        content = (konflux_repo / "CODEOWNERS").read_text()
        assert "/tenants-config/cluster/test-cluster/tenants/test-tenant/" in content
        assert "/tenants-config/cluster/test-cluster/admin/test-tenant/" in content

    def test_existing_tenant_excludes_tenant_dir_entries(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        (konflux_repo / "CODEOWNERS").write_text("")
        cfg = {**EXISTING_TENANT_CONFIG, "admins": ["alice"]}
        generate(cfg, str(konflux_repo))
        content = (konflux_repo / "CODEOWNERS").read_text()
        assert "/tenants-config/cluster/test-cluster/tenants/" not in content
        assert "ReleasePlanAdmission" in content

    def test_no_auto_generated_entries(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "admins": ["alice"]}
        generate(cfg, str(konflux_repo))
        content = (konflux_repo / "CODEOWNERS").read_text()
        assert "auto-generated" not in content

    def test_codeowners_globally_sorted(self, konflux_repo):
        (konflux_repo / "CODEOWNERS").write_text("/zzz/existing/ @someone\n")
        cfg = {**NEW_TENANT_CONFIG, "admins": ["alice"]}
        generate(cfg, str(konflux_repo))
        content = (konflux_repo / "CODEOWNERS").read_text()
        lines = [line for line in content.splitlines() if line.strip()]
        assert lines == sorted(lines)


class TestServiceNameDefault:
    def test_defaults_to_tenant_without_suffix(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG}
        del cfg["service_name"]
        generate(cfg, str(konflux_repo))
        rpa_dir = konflux_repo / "config" / "test-cluster.abcd.p1" / "service" / "ReleasePlanAdmission" / "test"
        assert rpa_dir.exists()
        assert (rpa_dir / "test-agent-dev.yaml").exists()

    def test_explicit_service_name_overrides(self, konflux_repo):
        cfg = {**NEW_TENANT_CONFIG, "service_name": "custom-svc"}
        generate(cfg, str(konflux_repo))
        rpa_dir = konflux_repo / "config" / "test-cluster.abcd.p1" / "service" / "ReleasePlanAdmission" / "custom-svc"
        assert rpa_dir.exists()
        assert (rpa_dir / "test-agent-dev.yaml").exists()


class TestExistingTenant:
    def test_existing_tenant_returns_false(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        result = generate(EXISTING_TENANT_CONFIG, str(konflux_repo))
        assert result["new_tenant"] is False

    def test_existing_tenant_files_written(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        result = generate(EXISTING_TENANT_CONFIG, str(konflux_repo))
        assert any("second-agent-dev" in f for f in result["files_written"])

    def test_no_admin_dir_for_existing(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        generate(EXISTING_TENANT_CONFIG, str(konflux_repo))
        admin_dir = konflux_repo / "tenants-config" / "cluster" / "test-cluster" / "admin" / "test-tenant"
        ns_mtime = (admin_dir / "ns.yaml").stat().st_mtime
        generate(EXISTING_TENANT_CONFIG, str(konflux_repo))
        assert (admin_dir / "ns.yaml").stat().st_mtime == ns_mtime

    def test_kustomization_updated(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        generate(EXISTING_TENANT_CONFIG, str(konflux_repo))
        kustom_file = (
            konflux_repo
            / "tenants-config"
            / "cluster"
            / "test-cluster"
            / "tenants"
            / "test-tenant"
            / "kustomization.yaml"
        )
        content = kustom_file.read_text()
        assert "second-agent-dev.yaml" in content

    def test_integration_test_scenario_created(self, konflux_repo):
        generate(NEW_TENANT_CONFIG, str(konflux_repo))
        generate(EXISTING_TENANT_CONFIG, str(konflux_repo))
        its_file = (
            konflux_repo
            / "tenants-config"
            / "cluster"
            / "test-cluster"
            / "tenants"
            / "test-tenant"
            / "second-agent-dev.enterprise-contract.integrationtestscenario.yaml"
        )
        assert its_file.exists()
