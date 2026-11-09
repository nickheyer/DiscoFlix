VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)
TAGS    := purego,gtk3,production
WEB_SRC := $(shell find web/src web/static -type f) web/package.json web/vite.config.ts

export CGO_ENABLED = 0

.DEFAULT_GOAL := build
.PHONY: build dev test fmt gen clean crosswalk

web/node_modules/.stamp: web/package.json web/bun.lock
	cd web && bun install --frozen-lockfile && touch node_modules/.stamp

web/build/200.html: web/node_modules/.stamp $(WEB_SRC)
	cd web && bun run build

# Builds the web client and the binary into bin/discoflix
build: web/build/200.html
	go build -tags $(TAGS) -ldflags "$(LDFLAGS)" -o bin/discoflix ./cmd/discoflix

# Builds, copies a locally built crosswalk into ./data when it is newer, then serves with debug logging
dev: build
	@if [ -f bin/crosswalk.sqlite ] && { [ ! -f data/crosswalk.sqlite ] || [ bin/crosswalk.sqlite -nt data/crosswalk.sqlite ]; }; then mkdir -p data && cp bin/crosswalk.sqlite data/crosswalk.sqlite && echo "installed bin/crosswalk.sqlite into data/"; fi
	./bin/discoflix serve --data-dir ./data --log-level debug

# Builds the Wikidata crosswalk from QLever into bin/crosswalk.sqlite for dev without a mirror
crosswalk:
	go run ./snapshot/cmd/crosswalk build --out bin/crosswalk.sqlite

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
