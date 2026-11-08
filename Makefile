VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)
TAGS    := purego,production
WEB_SRC := $(shell find web/src web/static -type f) web/package.json web/vite.config.ts

export CGO_ENABLED = 0

.DEFAULT_GOAL := build
.PHONY: build dev test fmt gen clean

web/node_modules/.stamp: web/package.json web/bun.lock
	cd web && bun install --frozen-lockfile && touch node_modules/.stamp

web/build/200.html: web/node_modules/.stamp $(WEB_SRC)
	cd web && bun run build

# Builds the web client and the desktop-capable binary into bin/discoflix
build: web/build/200.html
	go build -tags $(TAGS) -ldflags "$(LDFLAGS)" -o bin/discoflix ./cmd/discoflix

# Builds then serves from ./data with debug logging
dev: build
	./bin/discoflix serve --data-dir ./data --log-level debug

# Runs the Go and web test suites
test: web/build/200.html
	go test -tags $(TAGS) ./...
	cd web && bun run test

# Formats Go with gofumpt and gci, protos with buf, and the web client with prettier
fmt:
	golangci-lint fmt ./...
	go tool buf format -w
	cd web && bun run format

# Regenerates protos, Connect handlers, JSON schemas, and Ent code
gen:
	go tool buf generate
	go tool ent generate --feature sql/upsert,sql/execquery,sql/modifier,sql/lock ./internal/store/ent/schema

# Removes build outputs and keeps data, secrets, and generated sources
clean:
	rm -rf bin web/build web/.svelte-kit
