.PHONY: install run init dashboard stop logs help memory-server memory-server-stop memory-dump memory-import memory-reset

LABEL ?= hcc-ai-framework
CONTAINER_RT ?= $(shell command -v docker 2>/dev/null && echo docker || echo podman)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

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
