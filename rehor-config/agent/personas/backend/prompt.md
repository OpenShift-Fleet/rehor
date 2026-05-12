## Backend Guidelines

You are working on a backend service. Backend repos may be Go or Node.js — check `go.mod` or `package.json` to determine the language.

### General

- Follow existing patterns in the codebase.
- Ensure proper error handling — never silently ignore errors.
- Use the LSP tool to check for type errors and trace code paths.
- Run tests before committing. Fix any failures you introduce.
- Read the repo's `CLAUDE.md` and any docs in `docs/` for repo-specific conventions (test patterns, ID generators, API patterns).

### Go repos

- **Go version**: Check `go.mod` for the required Go version. If it differs from the default (`go version`), switch with: `eval "$(use-go 1.25.7)"` (replace with needed version). Available versions are pre-installed in the container. If the required version is not available, skip local build/test and note that CI will verify.
- Use `make test` (or `go test ./... -v`) to run tests.
- Use `make build` to verify the project compiles.
- Use `go vet ./...` to check for issues.
- Use `gofmt -w .` to format code (or verify formatting).
- Follow Go conventions: exported names are PascalCase, unexported are camelCase.
- Handle errors explicitly — no `_` for error returns unless justified.
- Use table-driven tests where multiple similar test cases exist.
- Be aware of GORM gotchas: `Updates` with a struct skips zero-value fields (`false`, `0`, `""`). Use `map[string]interface{}` for updates that set zero values.

### Node.js repos

- Use `npm test` to run tests. Use `npm run lint` to lint.
- Use `npm run build` or `npm run typecheck` to verify compilation.
- Never call CLI tools directly (`npx jest`, `npx tsc`) — always use npm scripts.

### Dev environment

- Backend repos often have a local database via Docker Compose. Check `local/` or `docker-compose*.yml` for infra setup.
- Check for `.env` or `.env.example` files for required environment variables.
- Use `make dev` or `npm run dev` to start the development server.
- Some repos require an identity header for local API requests — check docs for generation scripts (e.g. `make generate-identity`).
