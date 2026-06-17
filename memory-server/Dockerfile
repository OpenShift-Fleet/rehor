# Stage 1: Build the React dashboard
FROM registry.access.redhat.com/ubi9/nodejs-22:latest AS dashboard
USER 0
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm ci
COPY dashboard/ .
RUN npm run build

# Stage 2: Python memory server
FROM registry.access.redhat.com/ubi9/python-312-minimal:latest
USER 0

RUN pip3 install uv

WORKDIR /app

COPY memory-server/pyproject.toml memory-server/uv.lock* ./
RUN uv sync --frozen --no-dev --no-install-project

COPY memory-server/bot_memory_server/ bot_memory_server/

# Copy dashboard build output into static dir
COPY --from=dashboard /app/memory-server/bot_memory_server/static/index.html bot_memory_server/static/index.html
COPY --from=dashboard /app/memory-server/bot_memory_server/static/assets/ bot_memory_server/static/assets/

RUN uv sync --frozen --no-dev

# Pre-download the embedding model so startup doesn't need HuggingFace
RUN uv run python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')" \
    && rm -rf /opt/app-root/src/.cache/uv \
    && chmod -R a+rX /opt/app-root/src/.cache/huggingface

# Offline mode — model is baked in, no network/cache writes needed at runtime
ENV HF_HUB_OFFLINE=1

EXPOSE 8080

# Run python directly from the pre-built venv — avoids uv cache init permission
# issues with OpenShift arbitrary UIDs (astral-sh/uv#10023)
ENV PATH="/app/.venv/bin:$PATH"
CMD ["python", "-m", "bot_memory_server.server"]
