.PHONY: install run init dashboard costs costs-today costs-week seed-costs stop logs help memory-server memory-server-stop memory-dump memory-import memory-reset verify memory-verify precommit-install precommit-run prepush-install prepush-check verify-required-checks check-branch-protection container-verify container-e2e container-e2e-browser

LABEL ?= hcc-ai-framework
CONTAINER_RT ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

verify: ## Run all checks (same as CI)
	uv sync --frozen --extra dev
	@echo "=== Python: format ==="
	uv run ruff format --check .
	@echo "=== Python: lint ==="
	uv run ruff check .
	@echo "=== Python: type check ==="
	uv run mypy
	@echo "=== Python: tests ==="
	uv run pytest
	@echo "=== Go: vet ==="
	cd proxy/executor && go vet ./...
	@echo "=== Go: tests ==="
	cd proxy/executor && go test -race ./...
	@echo "=== Dashboard: type check ==="
	cd dashboard && npm run lint
	@echo "=== Dashboard: build ==="
	cd dashboard && npm run build
	@echo "=== Dashboard: tests ==="
	cd dashboard && npm test
	@echo ""
	@echo "All checks passed."

precommit-install: ## Install pre-commit hooks
	pip install pre-commit && pre-commit install

precommit-run: ## Run pre-commit on all files
	pre-commit run --all-files

prepush-install: ## Install pre-push git hook
	bash scripts/install_prepush_hook.sh

prepush-check: ## Run pre-push quality checks manually
	bash scripts/prepush_check.sh

verify-required-checks: ## Verify required CI checks on a PR (usage: make verify-required-checks PR=123)
	@if [ -z "$(PR)" ]; then echo "usage: make verify-required-checks PR=<number>"; exit 1; fi
	bash scripts/verify_required_checks.sh "$(PR)"

check-branch-protection: ## Check branch protection drift against versioned policy
	bash scripts/check_branch_protection.sh

memory-verify: ## Run memory-server CI-equivalent checks locally
	cd memory-server && uv sync --frozen --extra test
	cd memory-server && uv lock --check
	cd memory-server && uv run pytest -q
	@echo "=== Memory Server: pip-audit (report-only) ==="
	@cd memory-server && uv run pip-audit --desc --local --skip-editable; \
	status=$$?; \
	if [ "$$status" -eq 0 ]; then \
		echo "pip-audit found no vulnerabilities."; \
	elif [ "$$status" -eq 1 ]; then \
		echo "pip-audit reported vulnerabilities (report-only)"; \
	else \
		echo "pip-audit failed to execute correctly (exit $$status)"; \
		exit "$$status"; \
	fi

container-verify: ## Run container build + smoke checks locally (CI-equivalent, see .github/workflows/container-verify.yml). Uses --network host; on macOS this needs Docker Desktop's host-networking feature enabled, or run under a Linux VM/CI.
	@echo "=== bot: build ==="
	$(CONTAINER_RT) build --build-arg GOVERSIONS="1.24.2 1.25.7" -t bot:verify -f Dockerfile .
	@echo "=== bot: tooling presence check ==="
	@for tool in python3 uv git tini bwrap buildah node go gcc make gh glab gpg; do \
		$(CONTAINER_RT) run --rm --entrypoint bash bot:verify -c "command -v $$tool" >/dev/null \
			&& echo "OK: $$tool present" \
			|| { echo "MISSING: $$tool"; exit 1; }; \
	done
	@echo "=== proxy: build ==="
	$(CONTAINER_RT) build -t proxy:verify ./proxy
	@echo "=== proxy: smoke check ==="
	@$(CONTAINER_RT) rm -f proxy-verify >/dev/null 2>&1 || true
	$(CONTAINER_RT) run -d --name proxy-verify -e GH_TOKEN=dummy-smoke-token proxy:verify
	@ok=0; for i in $$(seq 1 15); do \
		$(CONTAINER_RT) exec proxy-verify squidclient -h 127.0.0.1 -p 3128 mgr:info >/dev/null 2>&1 && ok=1 && break; \
		sleep 2; \
	done; \
	if [ "$$ok" -ne 1 ]; then echo "squid did not become ready"; $(CONTAINER_RT) logs proxy-verify; $(CONTAINER_RT) rm -f proxy-verify; exit 1; fi
	$(CONTAINER_RT) exec proxy-verify test -S /var/run/devbot/executor.sock \
		|| { echo "executor socket missing"; $(CONTAINER_RT) logs proxy-verify; $(CONTAINER_RT) rm -f proxy-verify; exit 1; }
	@$(CONTAINER_RT) rm -f proxy-verify
	@echo "=== memory-server: build ==="
	$(CONTAINER_RT) build -f memory-server/Dockerfile -t memory-server:verify .
	@echo "=== memory-server: smoke check (spins up its own throwaway postgres on :55432) ==="
	@$(CONTAINER_RT) rm -f memory-server-verify-pg memory-server-verify >/dev/null 2>&1 || true
	$(CONTAINER_RT) run -d --name memory-server-verify-pg -p 55432:5432 \
		-e POSTGRES_USER=devbot_test -e POSTGRES_PASSWORD=devbot_test -e POSTGRES_DB=devbot_migration_test \
		pgvector/pgvector:pg17
	@pg_ok=0; for i in $$(seq 1 15); do \
		$(CONTAINER_RT) exec memory-server-verify-pg pg_isready -U devbot_test -d devbot_migration_test >/dev/null 2>&1 && pg_ok=1 && break; \
		sleep 2; \
	done; \
	if [ "$$pg_ok" -ne 1 ]; then echo "throwaway postgres never became ready"; $(CONTAINER_RT) logs memory-server-verify-pg; $(CONTAINER_RT) rm -f memory-server-verify-pg; exit 1; fi
	@if ! $(CONTAINER_RT) run -d --name memory-server-verify --network host \
		-e DATABASE_URL=postgresql://devbot_test:devbot_test@localhost:55432/devbot_migration_test \
		memory-server:verify; then \
		$(CONTAINER_RT) rm -f memory-server-verify-pg >/dev/null 2>&1 || true; \
		exit 1; \
	fi
	@ok=0; for i in $$(seq 1 30); do \
		curl -sf http://localhost:8080/health >/dev/null 2>&1 && ok=1 && break; \
		sleep 2; \
	done; \
	if [ "$$ok" -ne 1 ]; then \
		echo "memory-server /health never succeeded"; $(CONTAINER_RT) logs memory-server-verify; \
		$(CONTAINER_RT) rm -f memory-server-verify memory-server-verify-pg; exit 1; \
	fi
	@$(CONTAINER_RT) rm -f memory-server-verify memory-server-verify-pg
	@echo ""
	@echo "All container verification checks passed."

container-e2e: ## Run REHOR-62 multi-container entrypoint/runtime E2E checks locally.
	bash tests/container-e2e/test-container.sh --fixture $(or $(FIXTURE),minimal)

container-e2e-browser: ## Run REHOR-62 browser-only fixture (disk-heavy).
	bash tests/container-e2e/test-container.sh --fixture browser-only

install: ## Install dependencies with uv
	uv sync

init: install ## Full setup: install deps, LSP, memory server
	./init.sh

dashboard: ## Build the dashboard UI
	cd dashboard && npm run build

run: ## Run the bot (LABEL=hcc-ai-framework by default)
	uv run dev-bot --label $(LABEL)

run-rbac: ## Run the bot with platform-accessmanagement label
	uv run dev-bot --label hcc-ai-platform-accessmanagement

stop: ## Stop a running bot (release lock)
	@if [ -f data/.lock ]; then \
		pid=$$(cat data/.lock 2>/dev/null); \
		if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
			kill "$$pid" && echo "Stopped bot (PID $$pid)"; \
		else \
			rm -f data/.lock && echo "Removed stale lock"; \
		fi \
	else \
		echo "No bot running"; \
	fi

logs: ## Tail bot log
	tail -f data/bot.log

costs: ## Show all cost data
	./costs.sh all

costs-today: ## Show today's costs
	./costs.sh today

costs-week: ## Show this week's costs
	./costs.sh week

seed-costs: ## Import costs.jsonl into the database
	uv run python scripts/seed-costs.py data/costs.jsonl

memory-server: ## Start memory server + postgres
	$(CONTAINER_RT) compose -f memory-server/docker-compose.yml up --build

memory-server-stop: ## Stop memory server + postgres
	$(CONTAINER_RT) compose -f memory-server/docker-compose.yml down

memory-dump: ## Dump memory DB to data/memory-dump.sql
	@($(CONTAINER_RT) compose exec -T postgres pg_dump -U bot --data-only --inserts --on-conflict-do-nothing bot_memory 2>/dev/null || \
	  $(CONTAINER_RT) compose -f memory-server/docker-compose.yml exec -T postgres pg_dump -U bot --data-only --inserts --on-conflict-do-nothing bot_memory) > data/memory-dump.sql
	@echo "Dumped to data/memory-dump.sql"

memory-import: ## Import data from data/memory-dump.sql (additive, skips duplicates)
	@$(CONTAINER_RT) compose exec -T postgres psql -U bot -d bot_memory < data/memory-dump.sql 2>/dev/null || \
	  $(CONTAINER_RT) compose -f memory-server/docker-compose.yml exec -T postgres psql -U bot -d bot_memory < data/memory-dump.sql
	@echo "Imported from data/memory-dump.sql"

memory-reset: ## Wipe and reimport memory DB from data/memory-dump.sql
	@($(CONTAINER_RT) compose exec -T postgres psql -U bot -d bot_memory -c "DELETE FROM bot_status; DELETE FROM cycles; DELETE FROM memories; DELETE FROM tasks;" 2>/dev/null || \
	  $(CONTAINER_RT) compose -f memory-server/docker-compose.yml exec -T postgres psql -U bot -d bot_memory -c "DELETE FROM bot_status; DELETE FROM cycles; DELETE FROM memories; DELETE FROM tasks;") && \
	($(CONTAINER_RT) compose exec -T postgres psql -U bot -d bot_memory < data/memory-dump.sql 2>/dev/null || \
	  $(CONTAINER_RT) compose -f memory-server/docker-compose.yml exec -T postgres psql -U bot -d bot_memory < data/memory-dump.sql)
	@echo "Reset and imported from data/memory-dump.sql"

docker-up: ## Start full stack (postgres + memory server + bot)
	$(CONTAINER_RT) compose up --build

docker-down: ## Stop full stack
	$(CONTAINER_RT) compose down
