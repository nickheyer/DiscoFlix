// Replays recorded QLever answers and publishes fixture repositories so crosswalk tests never touch the network
package snapshottest

import (
	"context"
	_ "embed"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nickheyer/DiscoFlix/snapshot"
)

//go:embed qlever.tsv
var fixture string

// Name-index string the fixture endpoint reports
const Index = "fixture index"

// Answers each query name from its recorded TSV section, paging by limit and offset
type Endpoint struct {
	TimeoutAbove int

	sections map[string][]string
	mu       sync.Mutex
	calls    []snapshot.Query
}

// Parses the embedded recording into one section per query name
func NewEndpoint() *Endpoint {
	e := &Endpoint{sections: map[string][]string{}}
	name := ""
	for line := range strings.SplitSeq(strings.TrimRight(fixture, "\n"), "\n") {
		if n, ok := strings.CutPrefix(line, "#query "); ok {
			name = n
			continue
		}
		e.sections[name] = append(e.sections[name], line)
	}
	return e
}

// Returns the recorded page, or a timeout when the page is larger than TimeoutAbove
func (e *Endpoint) Select(_ context.Context, q snapshot.Query) ([]byte, error) {
	e.mu.Lock()
	e.calls = append(e.calls, q)
	e.mu.Unlock()
	lines, ok := e.sections[q.Name]
	if !ok {
		return nil, fmt.Errorf("snapshottest: no recorded answer for %s", q.Name)
	}
	if e.TimeoutAbove > 0 && q.Limit > e.TimeoutAbove {
		return nil, fmt.Errorf("%w: recorded timeout above %d rows", snapshot.ErrTimeout, e.TimeoutAbove)
	}
	rows := lines[1:]
	rows = rows[min(q.Offset, len(rows)):]
	if q.Limit > 0 {
		rows = rows[:min(q.Limit, len(rows))]
	}
	return []byte(strings.Join(append([]string{lines[0]}, rows...), "\n") + "\n"), nil
}

func (e *Endpoint) Index(context.Context) (string, error) { return Index, nil }

// Every query the endpoint answered in order
func (e *Endpoint) Calls() []snapshot.Query {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]snapshot.Query(nil), e.calls...)
}

// Extracts the recording and writes it to path as built at builtAt
func Build(ctx context.Context, path string, builtAt time.Time) (*snapshot.Dataset, snapshot.Counts, error) {
	x := &snapshot.Extractor{Endpoint: NewEndpoint(), Log: slog.New(slog.DiscardHandler)}
	d, err := x.Extract(ctx)
	if err != nil {
		return nil, snapshot.Counts{}, err
	}
	c, err := snapshot.Write(ctx, path, d, builtAt)
	return d, c, err
}

// A published fixture repository with its keys
type Repo struct {
	Dir  string
	Keys string
	Root []byte
	work string
}

// Makes fresh keys under work and an empty repository directory beside them
func NewRepo(work string) (*Repo, error) {
	r := &Repo{Dir: filepath.Join(work, "repo"), Keys: filepath.Join(work, "keys"), work: work}
	if _, _, err := snapshot.InitKeys(r.Keys, time.Now()); err != nil {
		return nil, err
	}
	root, err := os.ReadFile(filepath.Join(r.Keys, snapshot.RootFile))
	if err != nil {
		return nil, err
	}
	r.Root = root
	return r, os.MkdirAll(r.Dir, 0o750)
}

// Builds the recording as built at builtAt and signs it into the repository as the next version
func (r *Repo) Publish(ctx context.Context, builtAt time.Time) (snapshot.Published, error) {
	path := filepath.Join(r.work, builtAt.UTC().Format(snapshot.VersionLayout)+".sqlite")
	if _, _, err := Build(ctx, path, builtAt); err != nil {
		return snapshot.Published{}, err
	}
	return snapshot.Publish(ctx, snapshot.PublishOptions{
		Repo: r.Dir, Root: filepath.Join(r.Keys, snapshot.RootFile), OnlineKey: filepath.Join(r.Keys, snapshot.OnlineKeyFile),
		SQLite: path, Now: time.Now(),
	})
}
