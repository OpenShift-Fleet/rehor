.PHONY: install sync lock run dev up down logs clean seed

CONTAINER_RT ?= $(shell command -v docker 2>/dev/null && echo docker || echo podman)

install:
	uv sync

sync:
	uv sync

lock:
	uv lock

run:
	uv run python -m bot_memory_server.server

dev: up
	uv run python -m bot_memory_server.server

# Docker
up:
	$(CONTAINER_RT) compose up -d postgres
	@echo "Waiting for postgres..."
	@until $(CONTAINER_RT) compose exec postgres pg_isready -U bot -d bot_memory > /dev/null 2>&1; do sleep 1; done
	@echo "Postgres ready"

down:
	$(CONTAINER_RT) compose down

logs:
	$(CONTAINER_RT) compose logs -f

clean:
	$(CONTAINER_RT) compose down -v

# Seed from open-prs.json
seed:
	uv run python seed_from_json.py

# Full stack in Docker
up-all:
	$(CONTAINER_RT) compose up -d --build

down-all:
	$(CONTAINER_RT) compose down
