# Makefile for automating git push with conflict handling

BRANCH := $(shell git rev-parse --abbrev-ref HEAD)
COMMIT_MSG ?= "Auto-commit on $(shell date '+%Y-%m-%d %H:%M:%S')"

.PHONY: push pull commit status

# Default target
all: push

# Show current git status
status:
	@git status

# Commit all changes
commit:
	@git add .
	@git commit -m "$(COMMIT_MSG)" || echo "No changes to commit."

# Pull latest changes and handle merge conflicts
pull:
	@echo "🔄 Pulling latest changes from origin/$(BRANCH)..."
	@git fetch origin
	@if git merge --no-edit origin/$(BRANCH); then \
		echo "✅ Merge successful."; \
	else \
		echo "⚠️ Merge conflict detected! Please resolve manually."; \
		exit 1; \
	fi

# Push local commits to remote
push: commit pull
	@echo "⬆️  Pushing changes to origin/$(BRANCH)..."
	@if git push origin $(BRANCH); then \
		echo "✅ Push successful!"; \
	else \
		echo "⚠️ Push failed — attempting to rebase and retry..."; \
		git pull --rebase origin $(BRANCH) && git push origin $(BRANCH) || (echo "❌ Push failed even after rebase. Resolve manually." && exit 1); \
	fi

run: 
	uvicorn backend.main:app --reload