.PHONY: check lint format lint-ts format-ts docs docs-strict docs-live docs-clean

check:
	npx prek run --all-files
	@echo "All checks passed."

lint: check

# Validate agent syntax before restart (prevents crashes)
validate-agents:
	@echo "Validating agent scripts..."
	node -c scripts/discord-bridge.js && echo "✅ discord-bridge.js"
	node -c scripts/candy.js && echo "✅ candy.js"
	node -c scripts/architect-daemon.js && echo "✅ architect-daemon.js"
	node -c scripts/maomai.js && echo "✅ maomai.js"
	@echo "All agents validated."

# Targeted subproject checks (not part of `make check` — use for focused runs).
lint-ts:
	cd nemoclaw && npm run check

format: format-ts format-cli

format-cli:
	npx prettier --write 'bin/**/*.js' 'test/**/*.js'

format-ts:
	cd nemoclaw && npm run lint:fix && npm run format

# --- Documentation ---

docs:
	uv run --group docs sphinx-build -b html docs docs/_build/html

docs-strict:
	uv run --group docs sphinx-build -W -b html docs docs/_build/html

docs-live:
	uv run --group docs sphinx-autobuild docs docs/_build/html --open-browser

docs-clean:
	rm -rf docs/_build
