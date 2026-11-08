package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/setting"
)

// Settings reads and writes JSON values in the settings table
type Settings struct{ ent *ent.Client }

// NewSettings returns a settings accessor over the client
func NewSettings(entc *ent.Client) *Settings { return &Settings{ent: entc} }

// Get decodes the value stored under key into out, reporting false when unset
func (s *Settings) Get(ctx context.Context, key string, out any) (bool, error) {
	row, err := s.ent.Setting.Get(ctx, key)
	if ent.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(row.Value, out); err != nil {
		return false, fmt.Errorf("store: setting %s: %w", key, err)
	}
	return true, nil
}

// GetString returns the string stored under key or def
func (s *Settings) GetString(ctx context.Context, key, def string) (string, error) {
	var v string
	ok, err := s.Get(ctx, key, &v)
	if err != nil || !ok {
		return def, err
	}
	return v, nil
}

// Set stores value under key, replacing any previous value
func (s *Settings) Set(ctx context.Context, key string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.ent.Setting.Create().SetID(key).SetValue(raw).
		OnConflictColumns(setting.FieldID).UpdateValue().UpdateUpdatedAt().
		Exec(ctx)
}
