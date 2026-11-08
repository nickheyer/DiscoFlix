package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/confmap"
	"github.com/knadh/koanf/providers/env/v2"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/providers/posflag"
	"github.com/knadh/koanf/v2"
	"github.com/spf13/pflag"
)

// FileName is the bootstrap configuration file inside the data directory
const FileName = "config.yaml"

// Config is everything the process needs before the database is open
type Config struct {
	DataDir   string
	Addr      string
	PublicURL string
	LogLevel  string
	LogFormat string
	Headless  bool
}

// DefaultDataDir follows each platform's convention for application data
func DefaultDataDir() string {
	if v := os.Getenv("DISCOFLIX_DATA_DIR"); v != "" {
		return v
	}
	switch runtime.GOOS {
	case "windows":
		if v := os.Getenv("LOCALAPPDATA"); v != "" {
			return filepath.Join(v, "DiscoFlix")
		}
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "DiscoFlix")
		}
	default:
		if v := os.Getenv("XDG_DATA_HOME"); v != "" {
			return filepath.Join(v, "discoflix")
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".local", "share", "discoflix")
		}
	}
	return "discoflix-data"
}

// Flags registers the process flags on a flag set
func Flags(fs *pflag.FlagSet) {
	fs.String("data-dir", DefaultDataDir(), "directory holding databases, secrets, and config")
	fs.String("addr", ":5001", "listen address")
	fs.String("public-url", "", "origin users reach the server at, needed behind a proxy")
	fs.String("log-level", "info", "debug, info, warn, or error")
	fs.String("log-format", "", "text or json, detected from the terminal when empty")
	fs.Bool("headless", false, "never start the desktop shell")
}

// Load layers defaults, the config file, DISCOFLIX_ environment variables, and flags
func Load(fs *pflag.FlagSet) (Config, error) {
	k := koanf.New(".")
	if err := k.Load(confmap.Provider(map[string]any{
		"data_dir":    DefaultDataDir(),
		"server.addr": ":5001",
		"log.level":   "info",
	}, "."), nil); err != nil {
		return Config{}, err
	}
	dataDir := k.String("data_dir")
	if fs != nil {
		if v, err := fs.GetString("data-dir"); err == nil && fs.Changed("data-dir") {
			dataDir = v
		}
	}
	if v := os.Getenv("DISCOFLIX_DATA_DIR"); v != "" {
		dataDir = v
	}
	path := filepath.Join(dataDir, FileName)
	if _, err := os.Stat(path); err == nil {
		if err := k.Load(file.Provider(path), yaml.Parser()); err != nil {
			return Config{}, fmt.Errorf("config: %s: %w", path, err)
		}
	}
	if err := k.Load(env.Provider(".", env.Opt{
		Prefix: "DISCOFLIX_",
		TransformFunc: func(key, value string) (string, any) {
			key = strings.ToLower(strings.TrimPrefix(key, "DISCOFLIX_"))
			switch key {
			case "data_dir", "headless":
				return key, value
			}
			return strings.Replace(key, "_", ".", 1), value
		},
	}), nil); err != nil {
		return Config{}, err
	}
	if fs != nil {
		if err := k.Load(posflag.ProviderWithFlag(fs, ".", k, func(f *pflag.Flag) (string, any) {
			key := strings.ReplaceAll(f.Name, "-", "_")
			switch key {
			case "addr", "public_url":
				key = "server." + key
			case "log_level", "log_format":
				key = "log." + strings.TrimPrefix(key, "log_")
			}
			return key, posflag.FlagVal(fs, f)
		}), nil); err != nil {
			return Config{}, err
		}
	}
	c := Config{
		DataDir:   k.String("data_dir"),
		Addr:      k.String("server.addr"),
		PublicURL: k.String("server.public_url"),
		LogLevel:  k.String("log.level"),
		LogFormat: k.String("log.format"),
		Headless:  k.Bool("headless"),
	}
	if c.DataDir == "" {
		c.DataDir = dataDir
	}
	return c, nil
}
