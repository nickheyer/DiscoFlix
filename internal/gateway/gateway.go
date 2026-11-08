// Package gateway assembles the HTTP surface, every RPC, realtime, health, and the web client
package gateway

import (
	"context"
	"encoding/json"
	"errors"
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
	Interceptors []connect.ServerInterceptor
	Register     func(*connect.Server)
	Session      func(http.Handler) http.Handler
	Websocket    http.Handler
	ShellLogin   http.Handler
	IsAdmin      func(*http.Request) bool
	Health       func(context.Context) error
	Web          fs.FS
	Log          *slog.Logger
}

// WebsocketPath is where Centrifuge clients connect
const WebsocketPath = "/connection/websocket"

// NewHandler builds the root handler with sessions loaded for every route
func NewHandler(d Deps) http.Handler {
	srv := connect.NewServer(d.Interceptors...)
	d.Register(srv)
	mux := http.NewServeMux()
	connecthttp.Mount(mux, srv, connecthttp.WithGRPC(), connecthttp.WithGRPCWeb(), connecthttp.WithHTTPGet(), connecthttp.WithSendGzip())
	mux.Handle(WebsocketPath, d.Websocket)
	mux.Handle("GET /shell/session", d.ShellLogin)
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

// Serve runs the handler with HTTP/1.1 and cleartext HTTP/2 until ctx ends, reporting the bound address
func Serve(ctx context.Context, addr string, handler http.Handler, log *slog.Logger, onListen func(net.Addr)) error {
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		Protocols:         protocols,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	log.Info("http listening", "addr", ln.Addr().String())
	if onListen != nil {
		onListen(ln.Addr())
	}
	errc := make(chan error, 1)
	go func() { errc <- server.Serve(ln) }()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
