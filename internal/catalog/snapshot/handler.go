package snapshot

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"

	"github.com/caasmo/go-sqlite-rsync/sqlitersync"
	"github.com/coder/websocket"
)

// Serves the crosswalk version and the rsync origin that peers replicate from
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+VersionPath, s.serveVersion)
	mux.HandleFunc("GET "+RsyncPath, s.serveRsync)
	return mux
}

// Answers with the version and sha256 of the crosswalk in use
func (s *Service) serveVersion(w http.ResponseWriter, _ *http.Request) {
	version, sum, ok, err := s.identity()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case err != nil:
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
	case !ok:
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": ErrNotDownloaded.Error()})
	default:
		_ = json.NewEncoder(w).Encode(peerVersion{Version: version, SQLiteSHA256: sum})
	}
}

// Runs the sqlite3_rsync origin over a WebSocket while the file is held still
func (s *Service) serveRsync(w http.ResponseWriter, r *http.Request) {
	s.file.RLock()
	defer s.file.RUnlock()
	s.mu.RLock()
	present := s.db != nil
	s.mu.RUnlock()
	if !present {
		http.Error(w, ErrNotDownloaded.Error(), http.StatusNotFound)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		s.log.Warn("crosswalk rsync handshake failed", "remote", r.RemoteAddr, "error", err)
		return
	}
	nc := websocket.NetConn(r.Context(), conn, websocket.MessageBinary)
	stats, err := sqlitersync.Origin(r.Context(), nc, s.path, nil)
	if cerr := nc.Close(); err == nil && cerr != nil && !errors.Is(cerr, net.ErrClosed) {
		err = cerr
	}
	if err != nil {
		s.log.Warn("crosswalk rsync to peer failed", "remote", r.RemoteAddr, "error", err)
		return
	}
	s.log.Info("crosswalk rsync to peer finished", "remote", r.RemoteAddr, "pages", stats.PageUpdates, "sent", stats.BytesSent)
}
