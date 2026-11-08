// Package realtime embeds Centrifuge for WebSocket fan-out of timeline events
package realtime

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/centrifugal/centrifuge"
)

// Authorizer reports whether a user may subscribe to a realtime channel name
type Authorizer func(ctx context.Context, userID, channel string) (bool, error)

// Authenticator resolves the user behind an HTTP upgrade request, empty when anonymous
type Authenticator func(r *http.Request) (userID string, err error)

// Node wraps the Centrifuge node with DiscoFlix channel rules
type Node struct {
	node *centrifuge.Node
	log  *slog.Logger
}

const (
	historySize = 500
	historyTTL  = 24 * time.Hour
)

// New builds a node whose subscriptions are gated by authorize
func New(log *slog.Logger, version string, authorize Authorizer) (*Node, error) {
	node, err := centrifuge.New(centrifuge.Config{
		Name:           "discoflix",
		Version:        version,
		LogLevel:       centrifuge.LogLevelInfo,
		LogHandler:     logHandler(log.With("component", "centrifuge")),
		HistoryMetaTTL: 48 * time.Hour,
	})
	if err != nil {
		return nil, fmt.Errorf("realtime: node: %w", err)
	}
	node.OnConnecting(func(ctx context.Context, e centrifuge.ConnectEvent) (centrifuge.ConnectReply, error) {
		if cred, ok := centrifuge.GetCredentials(ctx); !ok || cred.UserID == "" {
			return centrifuge.ConnectReply{}, centrifuge.DisconnectInvalidToken
		}
		return centrifuge.ConnectReply{}, nil
	})
	node.OnConnect(func(client *centrifuge.Client) {
		client.OnSubscribe(func(e centrifuge.SubscribeEvent, cb centrifuge.SubscribeCallback) {
			allowed, err := authorize(client.Context(), client.UserID(), e.Channel)
			if err != nil {
				log.Error("subscribe authorization failed", "channel", e.Channel, "error", err)
				cb(centrifuge.SubscribeReply{}, centrifuge.ErrorInternal)
				return
			}
			if !allowed {
				cb(centrifuge.SubscribeReply{}, centrifuge.ErrorPermissionDenied)
				return
			}
			cb(centrifuge.SubscribeReply{Options: centrifuge.SubscribeOptions{
				EnableRecovery:    true,
				EnablePositioning: true,
				AllowedDeltaTypes: []centrifuge.DeltaType{centrifuge.DeltaTypeFossil},
			}}, nil)
		})
		client.OnPublish(func(e centrifuge.PublishEvent, cb centrifuge.PublishCallback) {
			cb(centrifuge.PublishReply{}, centrifuge.ErrorPermissionDenied)
		})
	})
	return &Node{node: node, log: log}, nil
}

// Run starts the node
func (n *Node) Run() error { return n.node.Run() }

// Shutdown stops the node and disconnects every client
func (n *Node) Shutdown(ctx context.Context) error { return n.node.Shutdown(ctx) }

// Publish stores the payload in channel history and pushes it to subscribers
func (n *Node) Publish(channel string, data []byte) error {
	_, err := n.node.Publish(channel, data, centrifuge.WithHistory(historySize, historyTTL), centrifuge.WithDelta(true))
	return err
}

// Disconnect closes every connection of a user, used when a session is revoked
func (n *Node) Disconnect(userID string) error {
	return n.node.Disconnect(userID)
}

// WebsocketHandler authenticates the upgrade request and serves the Centrifuge protocol
func (n *Node) WebsocketHandler(authn Authenticator) http.Handler {
	ws := centrifuge.NewWebsocketHandler(n.node, centrifuge.WebsocketConfig{CheckOrigin: sameOrigin})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, err := authn(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		if userID == "" {
			http.Error(w, "sign in to connect", http.StatusUnauthorized)
			return
		}
		ctx := centrifuge.SetCredentials(r.Context(), &centrifuge.Credentials{UserID: userID})
		ws.ServeHTTP(w, r.WithContext(ctx))
	})
}

// sameOrigin accepts upgrades without an Origin header or from the host that served the page
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

func logHandler(log *slog.Logger) centrifuge.LogHandler {
	return func(e centrifuge.LogEntry) {
		attrs := make([]any, 0, len(e.Fields)*2+2)
		for k, v := range e.Fields {
			attrs = append(attrs, k, v)
		}
		if e.Error != nil {
			attrs = append(attrs, "error", e.Error)
		}
		switch e.Level {
		case centrifuge.LogLevelTrace, centrifuge.LogLevelDebug:
			log.Debug(e.Message, attrs...)
		case centrifuge.LogLevelInfo:
			log.Info(e.Message, attrs...)
		case centrifuge.LogLevelWarn:
			log.Warn(e.Message, attrs...)
		default:
			log.Error(e.Message, attrs...)
		}
	}
}
