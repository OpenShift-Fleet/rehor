## RBAC (insights-rbac) Guidelines

You are working on **insights-rbac**, a Django 5.2 + Django REST Framework service that provides Role-Based Access Control for the Hybrid Cloud Console. The stack includes PostgreSQL 16, Redis, and Celery (worker + scheduler).

### Project Structure

```
rbac/                    # Django project root (APP_HOME)
  rbac/                  # Django settings module (settings.py, urls.py, middleware.py, wsgi.py)
  management/            # Django management app (roles, groups, permissions, policies)
  api/                   # API app (tenant model, common utilities, serializers)
tests/                   # Test suite (mirrors app structure: tests/management/, tests/api/, etc.)
scripts/                 # Utility scripts (entrypoint, DB setup, Kafka, ephemeral cluster)
```

### Dev Environment

The dev environment runs via Docker Compose. Prerequisites:

1. Create the docker network: `docker network create rbac-network`
2. Start with dev mode: `DEVELOPMENT=True docker-compose up`
3. Run migrations: `docker exec -it rbac_server python /opt/rbac/rbac/manage.py migrate`
4. Seed default roles: `docker exec -it rbac_server python /opt/rbac/rbac/manage.py seeds`

**Dev mode** (`DEVELOPMENT=True`) enables the `DevelopmentIdentityHeaderMiddleware` which auto-injects an `x-rh-identity` header with a fake org admin user (org_id=11111, username=user_dev). No auth headers needed for local API calls.

The server is exposed on **port 9080** (maps to 8080 inside the container). The DB is on port 15432.

### API Endpoints

Base path: `/api/rbac/v1/`

| Endpoint | Methods | Notes |
|----------|---------|-------|
| `roles/` | GET, POST | List/create roles |
| `roles/<uuid>/` | GET, PUT, PATCH, DELETE | Role detail |
| `roles/<uuid>/access/` | GET | Role access permissions |
| `groups/` | GET, POST | List/create groups |
| `groups/<uuid>/` | GET, PUT, PATCH, DELETE | Group detail |
| `groups/<uuid>/principals/` | GET, POST, DELETE | Group membership |
| `groups/<uuid>/roles/` | GET, POST, DELETE | Group role assignments |
| `access/` | GET | Requires `?application=` query param |
| `permissions/` | GET | List permissions |
| `permissions/options/` | GET | Permission filter options |
| `principals/` | GET | List principals |
| `cross-account-requests/` | GET, POST | Cross-account access requests |
| `auditlogs/` | GET | Audit log entries |

V2 endpoints are available at `/api/rbac/v2/`.

### Testing

- **Fast tests** (no coverage): `make unittest-fast` (uses `tox -e py312-fast`)
- **Full tests** (with coverage): `make unittest`
- **Profile tests**: `make unittest-profile` (shows slowest tests)
- Tests use Django's test framework with `TestCase` classes
- Test DB is auto-created by Django test runner (separate from dev DB)
- Tests run against a local PostgreSQL, not the Docker Compose DB

When modifying code, run relevant test modules:
```bash
tox -e py312-fast -- tests/management/test_role_viewset.py
```

### Linting and Formatting

- **Lint**: `make lint` (runs `tox -elint`)
- **Format**: `make format` (runs `black -t py312 -l 119`)
- **Typecheck**: `make typecheck` (runs `mypy`)
- Line length: 119 characters
- Python target: 3.12

### Code Conventions

- Uses Pipenv for dependency management (`Pipfile`, `Pipfile.lock`)
- Django settings in `rbac/rbac/settings.py`, reads from environment variables
- Identity/auth handled via `x-rh-identity` header (base64-encoded JSON) parsed in `rbac/rbac/middleware.py`
- Multi-tenancy via `Tenant` model keyed on `org_id`
- System roles are seeded and marked `system=True` — do not modify these directly
- Custom permissions use the format `app:resource:action` (e.g. `approval:requests:read`)
- Celery tasks are in `management/tasks.py`, broker is Redis
- The worker connects to Redis via the `redis` hostname in Docker Compose (not localhost)

### Key Files

- `rbac/rbac/settings.py` — all Django settings and env var configuration
- `rbac/rbac/middleware.py` — identity header parsing, tenant resolution
- `rbac/rbac/dev_middleware.py` — development identity injection (auto org_id=11111)
- `rbac/management/role/` — role views, serializers, definer
- `rbac/management/group/` — group views, serializers
- `rbac/management/permission/` — permission views
- `rbac/management/seeds.py` — default role/group seeding logic
- `rbac/api/models.py` — Tenant and other core models

### Common Pitfalls

- The `rbac-network` Docker network must exist before `docker-compose up` — it's external.
- Redis health check task in the worker logs connection errors to `localhost:6379` — this is a known issue in the health check code, not a real problem. The Celery broker connects to `redis:6379` correctly.
- Migrations must be run manually after first `docker-compose up` — the entrypoint only starts gunicorn.
- `DEVELOPMENT` env var defaults to `False` — must be explicitly set to `True` for auth bypass.
