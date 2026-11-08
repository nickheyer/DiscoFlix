package snapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Public QLever Wikidata SPARQL endpoint
const DefaultEndpoint = "https://qlever.dev/api/wikidata"

// Every prefix the extraction queries use, QLever requires each one declared
const prefixes = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX psn: <http://www.wikidata.org/prop/statement/value-normalized/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX schema: <http://schema.org/>
PREFIX wikibase: <http://wikiba.se/ontology#>
`

// Text QLever appends to a TSV body when the export fails after the headers were sent
const exportMarker = "!!!!>>#"

var (
	// QLever ran out of time on a query, a smaller page may succeed
	ErrTimeout = errors.New("qlever: query timed out")
	errBusy    = errors.New("qlever: server busy")
)

// One named SELECT with the page it asks for
type Query struct {
	Name    string
	Select  string
	Where   string
	GroupBy string
	Limit   int
	Offset  int
}

// Renders the named SPARQL with prefixes, projection, grouping, and page bounds
func (q Query) Text() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# discoflix crosswalk %s\n%s", q.Name, prefixes)
	fmt.Fprintf(&b, "SELECT %s WHERE {\n%s\n}", q.Select, q.Where)
	if q.GroupBy != "" {
		b.WriteString(" GROUP BY " + q.GroupBy)
	}
	if q.Limit > 0 {
		fmt.Fprintf(&b, " LIMIT %d", q.Limit)
	}
	if q.Offset > 0 {
		fmt.Fprintf(&b, " OFFSET %d", q.Offset)
	}
	return b.String()
}

// Answers SELECT queries as SPARQL TSV and names the index it serves
type Endpoint interface {
	Select(ctx context.Context, q Query) ([]byte, error)
	Index(ctx context.Context) (string, error)
}

// HTTP client for the SPARQL endpoint that retries busy and failing servers
type QLever struct {
	URL       string
	HTTP      *http.Client
	UserAgent string
	Attempts  int
	Backoff   time.Duration
	Pace      time.Duration
	Log       *slog.Logger

	last time.Time
}

// Client for endpoint with eight attempts, a two second starting backoff, and one request a second
func NewQLever(endpoint string, log *slog.Logger) *QLever {
	return &QLever{
		URL:       strings.TrimRight(endpoint, "/"),
		HTTP:      &http.Client{Timeout: 5 * time.Minute},
		UserAgent: "DiscoFlix-crosswalk/1 (+https://github.com/nickheyer/DiscoFlix)",
		Attempts:  8,
		Backoff:   2 * time.Second,
		Pace:      time.Second,
		Log:       log,
	}
}

// Runs one query, retrying network failures, busy answers, and server errors with backoff
func (c *QLever) Select(ctx context.Context, q Query) ([]byte, error) {
	u := c.URL + "?" + url.Values{"query": {q.Text()}}.Encode()
	return c.retry(ctx, q.Name, q.Offset, func() ([]byte, error) {
		body, err := c.get(ctx, u, "text/tab-separated-values")
		if err != nil {
			return nil, err
		}
		return body, exportError(body)
	})
}

// Reads the name-index string from the stats command
func (c *QLever) Index(ctx context.Context) (string, error) {
	body, err := c.retry(ctx, "stats", 0, func() ([]byte, error) { return c.get(ctx, c.URL+"?cmd=stats", "application/json") })
	if err != nil {
		return "", err
	}
	var stats struct {
		NameIndex string `json:"name-index"`
	}
	if err := json.Unmarshal(body, &stats); err != nil {
		return "", fmt.Errorf("stats: %w", err)
	}
	if stats.NameIndex == "" {
		return "", errors.New("stats: no name-index in the answer")
	}
	return stats.NameIndex, nil
}

// Repeats one request with doubling backoff until it succeeds, times out, or fails for good
func (c *QLever) retry(ctx context.Context, name string, offset int, call func() ([]byte, error)) ([]byte, error) {
	var last error
	wait := c.Backoff
	for attempt := 1; attempt <= c.Attempts; attempt++ {
		body, err := call()
		switch {
		case err == nil:
			return body, nil
		case errors.Is(err, ErrTimeout), !retryable(err):
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		last = err
		c.Log.Warn("qlever request failed, retrying", "query", name, "offset", offset, "attempt", attempt, "wait", wait, "error", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
		wait = min(wait*2, time.Minute)
	}
	return nil, fmt.Errorf("%s: gave up after %d attempts: %w", name, c.Attempts, last)
}

// Non-success answer with the exception QLever reported
type statusError struct {
	status    int
	exception string
}

func (e *statusError) Error() string {
	return fmt.Sprintf("qlever answered %d: %s", e.status, e.exception)
}

func retryable(err error) bool {
	if se, ok := errors.AsType[*statusError](err); ok {
		return se.status >= 500
	}
	return true
}

// Performs one paced request and classifies QLever's JSON error answers
func (c *QLever) get(ctx context.Context, u, accept string) ([]byte, error) {
	if wait := time.Until(c.last.Add(c.Pace)); wait > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}
	c.last = time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, http.NoBody)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", c.UserAgent)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusOK {
		return body, nil
	}
	var answer struct {
		Exception string `json:"exception"`
	}
	_ = json.Unmarshal(body, &answer)
	if answer.Exception == "" {
		answer.Exception = strings.TrimSpace(string(body[:min(len(body), 300)]))
	}
	switch {
	case strings.Contains(answer.Exception, "timed out"):
		return nil, fmt.Errorf("%w: %s", ErrTimeout, answer.Exception)
	case res.StatusCode == http.StatusTooManyRequests:
		return nil, fmt.Errorf("%w: %s", errBusy, answer.Exception)
	}
	return nil, &statusError{status: res.StatusCode, exception: answer.Exception}
}

// Failure QLever appended to a TSV body it could not finish
func exportError(body []byte) error {
	i := bytes.Index(body, []byte(exportMarker))
	if i < 0 {
		return nil
	}
	msg := string(body[i:])
	if _, after, ok := strings.Cut(msg, "The error message was:"); ok {
		msg = strings.TrimSpace(after)
	}
	if strings.Contains(msg, "timed out") {
		return fmt.Errorf("%w: %s", ErrTimeout, msg)
	}
	return fmt.Errorf("qlever export failed: %s", msg)
}

// One parsed TSV page
type Table struct {
	Vars []string
	Rows [][]string
}

// Splits a SPARQL TSV body into its header variables and rows
func ParseTSV(body []byte) (Table, error) {
	text := strings.TrimRight(string(body), "\n")
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || lines[0] == "" {
		return Table{}, errors.New("qlever: empty TSV answer")
	}
	t := Table{Vars: strings.Split(lines[0], "\t")}
	for n, line := range lines[1:] {
		cells := strings.Split(line, "\t")
		if len(cells) != len(t.Vars) {
			return Table{}, fmt.Errorf("qlever: TSV row %d has %d cells, header has %d", n+2, len(cells), len(t.Vars))
		}
		t.Rows = append(t.Rows, cells)
	}
	return t, nil
}

const entityPrefix = "<http://www.wikidata.org/entity/Q"

// Reads the number of a wikidata entity IRI
func QID(term string) (int64, bool) {
	rest, ok := strings.CutPrefix(term, entityPrefix)
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSuffix(rest, ">"), 10, 64)
	return n, err == nil && n > 0 && strings.HasSuffix(rest, ">")
}

// Splits an RDF literal into its text and language tag, bare numbers come back as text
func Literal(term string) (text, lang string, ok bool) {
	if term == "" {
		return "", "", false
	}
	if term[0] != '"' {
		return term, "", !strings.HasPrefix(term, "<") && !strings.HasPrefix(term, "_:")
	}
	end := strings.LastIndexByte(term, '"')
	if end == 0 {
		return "", "", false
	}
	text, suffix := term[1:end], term[end+1:]
	switch {
	case suffix == "", strings.HasPrefix(suffix, "^^"):
		return text, "", true
	case strings.HasPrefix(suffix, "@"):
		return text, strings.ToLower(suffix[1:]), true
	}
	return "", "", false
}

// Reads an integer or decimal literal
func Number(term string) (float64, bool) {
	text, _, ok := Literal(term)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(text, 64)
	return f, err == nil
}

// Reads the leading integer of a series ordinal such as 3 or 12a
func Ordinal(term string) (int, bool) {
	text, _, ok := Literal(term)
	if !ok {
		return 0, false
	}
	end := 0
	for end < len(text) && text[end] >= '0' && text[end] <= '9' {
		end++
	}
	n, err := strconv.Atoi(text[:end])
	return n, err == nil && n > 0
}
