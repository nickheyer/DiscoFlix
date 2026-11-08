// Package config layers flags, environment, file, and database settings and keeps secrets encrypted at rest
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"filippo.io/age"
)

const (
	secretsFile = "secrets.age"
	keyFile     = "secrets.key"
)

// Secrets is a small encrypted key value store bound to a key file in the data directory
type Secrets struct {
	mu       sync.Mutex
	path     string
	identity *age.X25519Identity
	values   map[string]string
}

// OpenSecrets loads or creates the key file and the encrypted secrets file
func OpenSecrets(dataDir string) (*Secrets, error) {
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return nil, err
	}
	identity, err := loadOrCreateIdentity(filepath.Join(dataDir, keyFile))
	if err != nil {
		return nil, err
	}
	s := &Secrets{path: filepath.Join(dataDir, secretsFile), identity: identity, values: map[string]string{}}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func loadOrCreateIdentity(path string) (*age.X25519Identity, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		id, err := age.GenerateX25519Identity()
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, []byte(id.String()+"\n"), 0o600); err != nil {
			return nil, fmt.Errorf("config: write key: %w", err)
		}
		return id, nil
	}
	if err != nil {
		return nil, err
	}
	id, err := age.ParseX25519Identity(string(bytes.TrimSpace(data)))
	if err != nil {
		return nil, fmt.Errorf("config: parse key: %w", err)
	}
	return id, nil
}

func (s *Secrets) load() error {
	f, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	r, err := age.Decrypt(f, s.identity)
	if err != nil {
		return fmt.Errorf("config: decrypt secrets: %w", err)
	}
	plain, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	return json.Unmarshal(plain, &s.values)
}

func (s *Secrets) save() error {
	plain, err := json.Marshal(s.values)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	w, err := age.Encrypt(f, s.identity.Recipient())
	if err != nil {
		_ = f.Close()
		return err
	}
	if _, err := w.Write(plain); err != nil {
		_ = f.Close()
		return err
	}
	if err := w.Close(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Get returns a secret value and whether it exists
func (s *Secrets) Get(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.values[key]
	return v, ok
}

// Set stores a secret and rewrites the encrypted file
func (s *Secrets) Set(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
	return s.save()
}

// GetOrCreate returns the existing secret or stores the one produced by gen
func (s *Secrets) GetOrCreate(key string, gen func() (string, error)) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.values[key]; ok {
		return v, nil
	}
	v, err := gen()
	if err != nil {
		return "", err
	}
	s.values[key] = v
	return v, s.save()
}
