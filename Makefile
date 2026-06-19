# FreeAI.fyi — convenience commands for local dev.
#
# Run `make` or `make help` to list everything below with descriptions.
# Each target is a thin wrapper over the per-component README steps; the
# READMEs stay the source of truth, this just makes the day-to-day stuff
# one short command.

# Local static site server (override: `make site SITE_PORT=9000`).
SITE_PORT ?= 8000
# Where the macOS SwiftPM package lives.
MAC_DIR := desktop/macos/SponsorOverlay
# Local dev database URL used by the server + its tests.
DATABASE_URL ?= postgresql://postgres:postgres@localhost:5432/freeai
export DATABASE_URL

.DEFAULT_GOAL := help

## help: List every command with a one-line description.
help:
	@echo "FreeAI.fyi — make commands:"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'
	@echo ""

# ---------------------------------------------------------------------------
# Site (static landing page + portal)
# ---------------------------------------------------------------------------

## site: Serve the static site locally (default http://localhost:8000).
site:
	@echo "Serving site at http://localhost:$(SITE_PORT) (Ctrl-C to stop)"
	@python3 -m http.server $(SITE_PORT)

# ---------------------------------------------------------------------------
# Server (Node + Postgres backend)
# ---------------------------------------------------------------------------

## db-up: Start the local Postgres 16 container (docker compose).
db-up:
	docker compose up -d db

## db-down: Stop the local Postgres container.
db-down:
	docker compose stop db

## migrate: Apply db/schema.sql to the database (uses $DATABASE_URL).
migrate:
	cd server && npm run migrate

## seed: Insert one example active campaign (a single live entry).
seed:
	cd server && npm run seed

## server: Start the API on http://localhost:8787.
server:
	cd server && npm start

## server-up: Bring up db, migrate, then start the API (first-run friendly).
server-up: db-up migrate server

## server-install: Install server dependencies.
server-install:
	cd server && npm install

## test-server: Run the server's end-to-end tests against the local DB.
test-server:
	cd server && npm test

# ---------------------------------------------------------------------------
# Chrome extension
# ---------------------------------------------------------------------------

## test-ext: Run the Chrome extension's headless tests.
test-ext:
	cd chrome-extension && npm test

## lint-ext: Syntax-check the extension's JS.
lint-ext:
	cd chrome-extension && npm run lint

# ---------------------------------------------------------------------------
# Terminal client (Claude Code CLI)
# ---------------------------------------------------------------------------

## test-terminal: Run the standalone Claude Code terminal client tests.
test-terminal:
	cd terminal && npm test

# ---------------------------------------------------------------------------
# VS Code / Cursor extension (incubating — see vscode-extension/INTEGRATION.md)
# ---------------------------------------------------------------------------

## vscode-install: Install the VS Code extension's dev dependencies.
vscode-install:
	cd vscode-extension && npm install

## build-vscode: Bundle the VS Code extension (esbuild → dist/).
build-vscode:
	cd vscode-extension && npm run build

## test-vscode: Run the VS Code extension's vitest editor-safety suite.
test-vscode:
	cd vscode-extension && npm test

## package-vscode: Produce the .vsix (requires @vscode/vsce).
package-vscode:
	cd vscode-extension && npm run package

# ---------------------------------------------------------------------------
# macOS app (SponsorOverlay) + Rust core
# ---------------------------------------------------------------------------

## test-mac: Run the Rust overlay-core tests (works on any OS).
test-mac:
	cd desktop/core && cargo test

## mac-build: Build the macOS app (requires a Mac with Swift).
mac-build:
	cd $(MAC_DIR) && swift build

## mac-run: Build & run the macOS app against the real API (requires a Mac).
mac-run:
	cd $(MAC_DIR) && swift run SponsorOverlay

## mac-demo: Run the macOS app in demo mode — no server or Claude needed.
mac-demo:
	cd $(MAC_DIR) && FREEAI_DEMO=1 swift run SponsorOverlay

## mac-probe: Run the macOS app in probe mode to verify generation detection.
mac-probe:
	cd $(MAC_DIR) && FREEAI_PROBE=1 swift run SponsorOverlay

## mac-bundle: Package the macOS app into .app/.zip/.dmg (ad-hoc signed).
mac-bundle:
	cd $(MAC_DIR) && ./packaging/bundle.sh

## mac-open: Open the bundled SponsorOverlay.app (run `make mac-bundle` first).
mac-open:
	open $(MAC_DIR)/build/SponsorOverlay.app

# ---------------------------------------------------------------------------
# Aggregates
# ---------------------------------------------------------------------------

## test: Run every test suite (server, extension, terminal, mac core).
test: test-server test-ext test-terminal test-mac

.PHONY: help site db-up db-down migrate seed server server-up server-install \
	test-server test-ext lint-ext test-terminal vscode-install build-vscode test-vscode \
	package-vscode test-mac mac-build mac-run mac-demo \
	mac-probe mac-bundle mac-open test
