// Package gateway assembles the HTTP surface, every RPC, realtime, health, and the web client
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"time"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Deps are the components the gateway exposes
type Deps struct {
	Server     *connect.Server
	Session    func(http.Handler) http.Handler
	Websocket  http.Handler
	ShellLogin http.Handler
	// Extra plain HTTP routes keyed by method and pattern, such as OAuth callbacks
	Routes  map[string]http.Handler
	IsAdmin func(*http.Request) bool
	Health  func(context.Context) error
	Web     fs.FS
	Log     *slog.Logger
}

// WebsocketPath is where Centrifuge clients connect
const WebsocketPath = "/connection/websocket"

// NewHandler builds the root handler with sessions loaded for every route
func NewHandler(d Deps) http.Handler {
	mux := http.NewServeMux()
	connecthttp.Mount(mux, d.Server, connecthttp.WithGRPC(), connecthttp.WithGRPCWeb(), connecthttp.WithHTTPGet(), connecthttp.WithSendGzip())
	mux.Handle(WebsocketPath, d.Websocket)
	mux.Handle("GET /shell/session", d.ShellLogin)
	for pattern, h := range d.Routes {
		mux.Handle(pattern, h)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		status := http.StatusOK
		body := map[string]string{"status": "ok"}
		if err := d.Health(r.Context()); err != nil {
			status = http.StatusServiceUnavailable
			body = map[string]string{"status": "degraded", "error": err.Error()}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	})
	mux.Handle("GET /metrics", adminOnly(d.IsAdmin, promhttp.Handler()))
	mux.Handle("/", NewSPA(d.Web))
	return d.Session(mux)
}

func adminOnly(isAdmin func(*http.Request) bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r) {
			http.Error(w, "administrators only", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Listen binds a TCP address without serving it yet
func Listen(ctx context.Context, addr string) (net.Listener, error) {
	return (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
}

// Server serves one handler on every listener handed to it with HTTP/1.1 and cleartext HTTP/2
type Server struct {
	srv  *http.Server
	log  *slog.Logger
	errc chan error
}

// NewServer prepares a server for handler
func NewServer(handler http.Handler, log *slog.Logger) *Server {
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	return &Server{
		srv: &http.Server{
			Handler:           handler,
			Protocols:         protocols,
			ReadHeaderTimeout: 15 * time.Second,
			IdleTimeout:       2 * time.Minute,
		},
		log:  log,
		errc: make(chan error, 1),
	}
}

// Serve accepts connections on ln in the background, reporting the first failure to Wait
func (s *Server) Serve(ln net.Listener) {
	go func() {
		err := s.srv.Serve(ln)
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			return
		}
		select {
		case s.errc <- fmt.Errorf("%s: %w", ln.Addr(), err):
		default:
		}
	}()
}

// Wait blocks until ctx ends or a listener fails, then shuts the server down
func (s *Server) Wait(ctx context.Context) error {
	var err error
	select {
	case <-ctx.Done():
	case err = <-s.errc:
		s.log.Error("http serve failed", "error", err)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if serr := s.srv.Shutdown(shutdownCtx); err == nil {
		err = serr
	}
	return err
}
