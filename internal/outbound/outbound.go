// Package outbound is the one client layer every external call goes through, with limits, caching, breaking, and provenance
package outbound

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/sony/gobreaker/v2"
	"golang.org/x/time/rate"
)

// Policy describes how one source may be called
type Policy struct {
	Name  string
	Title string
	// Requests per second, zero means unlimited
	Rate  float64
	Burst int
	// Calls per UTC day, zero means unlimited
	Budget  int
	Timeout time.Duration
	// How long a stored GET answers without a network call
	CacheTTL time.Duration
	License  string
}

// Request is one outbound call with the provenance keys stored on its record
type Request struct {
	Method    string
	URL       string
	Header    http.Header
	Body      []byte
	Namespace string
	ExtValue  string
	Kind      string
	// Skip the cache and fetch again
	Fresh bool
	// Count and limit the call but keep the body out of the record store
	NoRecord bool
	// Query parameters removed from the stored URL, the cache key, and error text
	Redact []string
}

// safeURL strips the redacted query parameters so credentials never reach records or logs
func (r Request) safeURL() (string, error) {
	if len(r.Redact) == 0 {
		return r.URL, nil
	}
	u, err := url.Parse(r.URL)
	if err != nil {
		return "", err
	}
	q := u.Query()
	for _, k := range r.Redact {
		q.Del(k)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// Response is the answer with the record that proves where it came from
type Response struct {
	Status   int
	Header   http.Header
	Body     []byte
	RecordID string
	// The request URL with redacted parameters removed, as stored on the record
	URL       string
	Cached    bool
	FetchedAt time.Time
	stream    *http.Response
}

// Record is one stored response
type Record struct {
	ID        string
	Source    string
	Namespace string
	ExtValue  string
	Kind      string
	URL       string
	Status    int
	ETag      string
	Body      []byte
	License   string
	FetchedAt time.Time
}

// Recorder persists records, daily counters, and health per source
type Recorder interface {
	Latest(ctx context.Context, source, url string) (*Record, error)
	Save(ctx context.Context, r *Record) (string, error)
	Touch(ctx context.Context, id string, at time.Time) error
	LoadCalls(ctx context.Context, source string) (calls int, resetAt time.Time, err error)
	StoreCalls(ctx context.Context, source string, calls int, resetAt time.Time) error
	Health(ctx context.Context, source string, ok bool, detail string, at time.Time) error
}

// Health is the live view of one source
type Health struct {
	Breaker   string
	Calls     int
	Budget    int
	LastOK    time.Time
	LastError string
	LastErrAt time.Time
}

var (
	ErrUnknownSource = errors.New("outbound: source not registered")
	ErrBudget        = errors.New("outbound: daily budget exhausted")
	ErrOpen          = errors.New("outbound: circuit open after repeated failures")
)

// StatusError reports a non-success HTTP status
type StatusError struct {
	Status int
	URL    string
	Body   []byte
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("outbound: %s answered %d", e.URL, e.Status)
}

// Transient reports whether an error should count against the circuit and be retried
func Transient(err error) bool {
	if se, ok := errors.AsType[*StatusError](err); ok {
		return se.Status == 429 || se.Status >= 500
	}
	if _, ok := errors.AsType[net.Error](err); ok {
		return true
	}
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF)
}

type source struct {
	policy  Policy
	limiter *rate.Limiter
	breaker *gobreaker.CircuitBreaker[*Response]

	mu        sync.Mutex
	loaded    bool
	calls     int
	resetAt   time.Time
	lastOK    time.Time
	lastErr   string
	lastErrAt time.Time
}

// Client routes every request through its source policy
type Client struct {
	http      *http.Client
	rec       Recorder
	log       *slog.Logger
	userAgent string
	now       func() time.Time

	mu      sync.RWMutex
	sources map[string]*source
}

// New builds a client over a recorder, every request carries the user agent
func New(rec Recorder, userAgent string, log *slog.Logger) *Client {
	return &Client{
		http:      &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 4, IdleConnTimeout: 90 * time.Second}},
		rec:       rec,
		log:       log,
		userAgent: userAgent,
		now:       time.Now,
		sources:   map[string]*source{},
	}
}

// SetHTTPClient swaps the transport, for tests and proxies
func (c *Client) SetHTTPClient(h *http.Client) { c.http = h }

// Register installs or replaces the policy of one source, keeping its counters
func (c *Client) Register(p Policy) {
	if p.Timeout == 0 {
		p.Timeout = 20 * time.Second
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.sources[p.Name]
	if !ok {
		s = &source{}
		c.sources[p.Name] = s
	}
	s.policy = p
	if p.Rate > 0 {
		s.limiter = rate.NewLimiter(rate.Limit(p.Rate), max(p.Burst, 1))
	} else {
		s.limiter = nil
	}
	s.breaker = gobreaker.NewCircuitBreaker[*Response](gobreaker.Settings{
		Name:        p.Name,
		MaxRequests: 1,
		Interval:    time.Minute,
		Timeout:     time.Minute,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			return counts.ConsecutiveFailures >= 5
		},
		IsSuccessful: func(err error) bool { return err == nil || !Transient(err) },
	})
}

// Policies lists the registered policies by name
func (c *Client) Policies() map[string]Policy {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]Policy, len(c.sources))
	for name, s := range c.sources {
		out[name] = s.policy
	}
	return out
}

func (c *Client) source(name string) (*source, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	s, ok := c.sources[name]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownSource, name)
	}
	return s, nil
}

// dayStart is the UTC midnight the budget counts from
func dayStart(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// consume reserves one call against the daily budget, loading the stored counter on first use
func (c *Client) consume(ctx context.Context, s *source) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := c.now()
	if !s.loaded {
		calls, resetAt, err := c.rec.LoadCalls(ctx, s.policy.Name)
		if err != nil {
			return err
		}
		s.calls, s.resetAt, s.loaded = calls, resetAt, true
	}
	if day := dayStart(now); s.resetAt.Before(day) {
		s.calls, s.resetAt = 0, day
	}
	if s.policy.Budget > 0 && s.calls >= s.policy.Budget {
		return ErrBudget
	}
	s.calls++
	return c.rec.StoreCalls(ctx, s.policy.Name, s.calls, s.resetAt)
}

// Do performs one call under the source policy, answering from the record store when fresh enough
func (c *Client) Do(ctx context.Context, name string, req Request) (*Response, error) {
	s, err := c.source(name)
	if err != nil {
		return nil, err
	}
	if req.Method == "" {
		req.Method = http.MethodGet
	}
	safe, err := req.safeURL()
	if err != nil {
		return nil, err
	}
	var latest *Record
	if req.Method == http.MethodGet && !req.NoRecord {
		if latest, err = c.rec.Latest(ctx, name, safe); err != nil {
			return nil, err
		}
		if latest != nil && !req.Fresh && latest.Status < 400 && s.policy.CacheTTL > 0 && c.now().Sub(latest.FetchedAt) < s.policy.CacheTTL {
			return &Response{Status: latest.Status, Body: latest.Body, RecordID: latest.ID, URL: safe, Cached: true, FetchedAt: latest.FetchedAt}, nil
		}
	}
	if s.limiter != nil {
		if err := s.limiter.Wait(ctx); err != nil {
			return nil, err
		}
	}
	if err := c.consume(ctx, s); err != nil {
		return nil, err
	}
	res, err := s.breaker.Execute(func() (*Response, error) { return c.fetch(ctx, s, req, safe, latest) })
	if errors.Is(err, gobreaker.ErrOpenState) || errors.Is(err, gobreaker.ErrTooManyRequests) {
		err = ErrOpen
	}
	c.health(ctx, s, err)
	return res, err
}

// fetch performs the HTTP exchange, revalidating with the stored etag and recording the outcome
func (c *Client) fetch(ctx context.Context, s *source, req Request, safe string, latest *Record) (*Response, error) {
	ctx, cancel := context.WithTimeout(ctx, s.policy.Timeout)
	defer cancel()
	hreq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, bytes.NewReader(req.Body))
	if err != nil {
		return nil, err
	}
	maps.Copy(hreq.Header, req.Header)
	hreq.Header.Set("User-Agent", c.userAgent)
	if latest != nil && latest.ETag != "" && latest.Status < 400 {
		hreq.Header.Set("If-None-Match", latest.ETag)
	}
	hres, err := c.http.Do(hreq)
	if err != nil {
		return nil, err
	}
	defer func() { _ = hres.Body.Close() }()
	now := c.now()
	if hres.StatusCode == http.StatusNotModified && latest != nil {
		if err := c.rec.Touch(ctx, latest.ID, now); err != nil {
			return nil, err
		}
		return &Response{Status: latest.Status, Header: hres.Header, Body: latest.Body, RecordID: latest.ID, URL: safe, FetchedAt: now}, nil
	}
	body, err := io.ReadAll(io.LimitReader(hres.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	out := &Response{Status: hres.StatusCode, Header: hres.Header, Body: body, URL: safe, FetchedAt: now}
	if !req.NoRecord && hres.StatusCode < 500 && hres.StatusCode != http.StatusTooManyRequests {
		rec := &Record{Source: s.policy.Name, Namespace: req.Namespace, ExtValue: req.ExtValue, Kind: req.Kind, URL: safe, Status: hres.StatusCode, ETag: hres.Header.Get("ETag"), Body: body, License: s.policy.License, FetchedAt: now}
		if out.RecordID, err = c.rec.Save(ctx, rec); err != nil {
			return nil, err
		}
	}
	if hres.StatusCode >= 400 {
		return out, &StatusError{Status: hres.StatusCode, URL: safe, Body: body}
	}
	return out, nil
}

// health remembers the latest outcome in memory and in the recorder
func (c *Client) health(ctx context.Context, s *source, err error) {
	now := c.now()
	s.mu.Lock()
	if err == nil {
		s.lastOK = now
	} else {
		s.lastErr, s.lastErrAt = err.Error(), now
	}
	s.mu.Unlock()
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	if herr := c.rec.Health(ctx, s.policy.Name, err == nil, detail, now); herr != nil {
		c.log.Warn("record source health", "source", s.policy.Name, "error", herr)
	}
}

// GetJSON performs a GET and decodes the body into out
func (c *Client) GetJSON(ctx context.Context, name string, req Request, out any) (*Response, error) {
	res, err := c.Do(ctx, name, req)
	if err != nil {
		return res, err
	}
	if err := json.Unmarshal(res.Body, out); err != nil {
		return res, fmt.Errorf("outbound: decode %s: %w", res.URL, err)
	}
	return res, nil
}

// State reports the live health of a source
func (c *Client) State(name string) (Health, bool) {
	s, err := c.source(name)
	if err != nil {
		return Health{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return Health{Breaker: s.breaker.State().String(), Calls: s.calls, Budget: s.policy.Budget, LastOK: s.lastOK, LastError: s.lastErr, LastErrAt: s.lastErrAt}, true
}

// Stream performs one call under the source policy and hands back the open body for large downloads
func (c *Client) Stream(ctx context.Context, name string, req Request) (*http.Response, error) {
	s, err := c.source(name)
	if err != nil {
		return nil, err
	}
	if req.Method == "" {
		req.Method = http.MethodGet
	}
	safe, err := req.safeURL()
	if err != nil {
		return nil, err
	}
	if s.limiter != nil {
		if err := s.limiter.Wait(ctx); err != nil {
			return nil, err
		}
	}
	if err := c.consume(ctx, s); err != nil {
		return nil, err
	}
	res, err := s.breaker.Execute(func() (*Response, error) {
		hreq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, bytes.NewReader(req.Body))
		if err != nil {
			return nil, err
		}
		maps.Copy(hreq.Header, req.Header)
		hreq.Header.Set("User-Agent", c.userAgent)
		hres, err := c.http.Do(hreq)
		if err != nil {
			return nil, err
		}
		if hres.StatusCode >= 400 {
			body, _ := io.ReadAll(io.LimitReader(hres.Body, 4096))
			_ = hres.Body.Close()
			return nil, &StatusError{Status: hres.StatusCode, URL: safe, Body: body}
		}
		return &Response{Status: hres.StatusCode, Header: hres.Header, URL: safe, FetchedAt: c.now(), stream: hres}, nil
	})
	if errors.Is(err, gobreaker.ErrOpenState) || errors.Is(err, gobreaker.ErrTooManyRequests) {
		err = ErrOpen
	}
	c.health(ctx, s, err)
	if err != nil {
		return nil, err
	}
	return res.stream, nil
}
