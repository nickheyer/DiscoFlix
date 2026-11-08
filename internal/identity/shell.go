package identity

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/store/ent/user"
)

// ShellToken is a single-use loopback credential the desktop shell opens the window with
type ShellToken struct {
	mu      sync.Mutex
	value   string
	expires time.Time
}

// NewShellToken mints a token valid for one minute
func NewShellToken() (*ShellToken, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	return &ShellToken{value: base64.RawURLEncoding.EncodeToString(raw), expires: time.Now().Add(time.Minute)}, nil
}

// Rotate mints a new token valid for one minute and returns it
func (t *ShellToken) Rotate() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.value = base64.RawURLEncoding.EncodeToString(raw)
	t.expires = time.Now().Add(time.Minute)
	return t.value
}

// redeem consumes the token when it matches and has not expired
func (t *ShellToken) redeem(candidate string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.value == "" || time.Now().After(t.expires) {
		return false
	}
	ok := subtle.ConstantTimeCompare([]byte(t.value), []byte(candidate)) == 1
	if ok {
		t.value = ""
	}
	return ok
}

// ShellLoginHandler signs the first administrator in from the loopback shell and redirects to the app
func (s *Service) ShellLoginHandler(token *ShellToken) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !net.ParseIP(host).IsLoopback() {
			http.Error(w, "loopback only", http.StatusForbidden)
			return
		}
		if token == nil || !token.redeem(r.URL.Query().Get("token")) {
			http.Error(w, "token expired", http.StatusForbidden)
			return
		}
		required, err := s.SetupRequired(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if required {
			http.Redirect(w, r, "/setup", http.StatusFound)
			return
		}
		admin, err := s.ent.User.Query().Where(user.SystemAdmin(true), user.StatusEQ(user.StatusActive)).Order(user.ByCreatedAt()).First(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		meta := Meta{RemoteAddr: r.RemoteAddr, UserAgent: r.UserAgent()}
		if err := s.login(r.Context(), admin, "shell", meta); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		s.audit(r.Context(), admin, "login", "shell", meta, admin.DisplayName+" signed in from the desktop shell")
		http.Redirect(w, r, "/", http.StatusFound)
	})
}
