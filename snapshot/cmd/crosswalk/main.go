// Builds, signs, publishes, and verifies the Wikidata crosswalk snapshot from the command line
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"os"
	"os/signal"
	"slices"
	"strings"
	"time"

	"github.com/nickheyer/DiscoFlix/snapshot"
)

const usage = `usage:
  crosswalk keys init --dir <dir>
  crosswalk build --out crosswalk.sqlite [--endpoint url] [--limit N] [--pace 1s]
  crosswalk publish --repo <dir> --root root.json --online-key online.key --sqlite crosswalk.sqlite
  crosswalk verify --repo <dir> --root root.json`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	err := run(ctx, os.Args[1:], os.Stdout, log)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "crosswalk:", err)
		os.Exit(1)
	}
}

// Dispatches one subcommand
func run(ctx context.Context, args []string, out io.Writer, log *slog.Logger) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	switch args[0] {
	case "keys":
		if len(args) < 2 || args[1] != "init" {
			return errors.New(usage)
		}
		return keysInit(args[2:], out)
	case "build":
		return build(ctx, args[1:], out, log)
	case "publish":
		return publish(ctx, args[1:], out)
	case "verify":
		return verify(ctx, args[1:], out)
	}
	return errors.New(usage)
}

// Fails with the usage text when any named flag value is empty
func required(values map[string]string) error {
	for _, name := range slices.Sorted(maps.Keys(values)) {
		if values[name] == "" {
			return fmt.Errorf("--%s is required\n%s", name, usage)
		}
	}
	return nil
}

// Writes a new root key, online key, and signed root
func keysInit(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("keys init", flag.ContinueOnError)
	dir := fs.String("dir", "", "directory for root.key, online.key, and root.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := required(map[string]string{"dir": *dir}); err != nil {
		return err
	}
	rootID, onlineID, err := snapshot.InitKeys(*dir, time.Now())
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "root key   %s\nonline key %s\nwrote %s/{%s,%s,%s}\n", rootID, onlineID, *dir, snapshot.RootKeyFile, snapshot.OnlineKeyFile, snapshot.RootFile)
	return err
}

// Extracts the crosswalk from QLever and writes the sqlite file
func build(ctx context.Context, args []string, out io.Writer, log *slog.Logger) error {
	fs := flag.NewFlagSet("build", flag.ContinueOnError)
	path := fs.String("out", "", "crosswalk sqlite file to write")
	endpoint := fs.String("endpoint", snapshot.DefaultEndpoint, "QLever Wikidata SPARQL endpoint")
	limit := fs.Int("limit", 0, "keep at most this many items per kind")
	pace := fs.Duration("pace", time.Second, "least time between two QLever requests")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := required(map[string]string{"out": *path}); err != nil {
		return err
	}
	if *limit < 0 || *pace < 0 {
		return errors.New("--limit and --pace must not be negative")
	}
	start := time.Now()
	q := snapshot.NewQLever(*endpoint, log)
	q.Pace = *pace
	x := &snapshot.Extractor{Endpoint: q, Limit: *limit, Log: log}
	d, err := x.Extract(ctx)
	if err != nil {
		return err
	}
	c, err := snapshot.Write(ctx, *path, d, time.Now())
	if err != nil {
		return err
	}
	lines := []string{
		fmt.Sprintf("wrote %s version %s, %d bytes in %s", *path, c.Meta.Version, c.Bytes, time.Since(start).Round(time.Second)),
		fmt.Sprintf("qlever index %s", c.Meta.QLeverIndex),
		fmt.Sprintf("items %d: %s", c.Meta.Items, counts(c.Kinds)),
		fmt.Sprintf("xids %d: %s", c.Meta.XIDs, counts(c.XIDs)),
		fmt.Sprintf("titles: %s", counts(c.Titles)),
		fmt.Sprintf("values without a catalog form: %s", counts(d.Skipped)),
		fmt.Sprintf("ids claimed by two items: %s", counts(d.Collisions)),
		fmt.Sprintf("qlever rows: %s", counts(d.Rows)),
	}
	_, err = fmt.Fprintln(out, strings.Join(lines, "\n"))
	return err
}

// Renders a count map in key order
func counts[N int | int64](m map[string]N) string {
	if len(m) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(m))
	for _, k := range slices.Sorted(maps.Keys(m)) {
		parts = append(parts, fmt.Sprintf("%s %d", k, m[k]))
	}
	return strings.Join(parts, ", ")
}

// Signs the crosswalk into a flat TUF repository
func publish(ctx context.Context, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("publish", flag.ContinueOnError)
	o := snapshot.PublishOptions{}
	fs.StringVar(&o.Repo, "repo", "", "flat repository directory")
	fs.StringVar(&o.Root, "root", "", "trusted root.json")
	fs.StringVar(&o.OnlineKey, "online-key", "", "online ed25519 private key")
	fs.StringVar(&o.SQLite, "sqlite", "", "crosswalk sqlite file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := required(map[string]string{"repo": o.Repo, "root": o.Root, "online-key": o.OnlineKey, "sqlite": o.SQLite}); err != nil {
		return err
	}
	o.Now = time.Now()
	p, err := snapshot.Publish(ctx, o)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "published %s (%d bytes) for crosswalk %s sha256 %s\nroot v%d, targets v%d, snapshot v%d, timestamp v%d\n",
		p.Target, p.TargetLength, p.Custom.Version, p.Custom.SQLiteSHA256, p.RootVersion, p.TargetsVersion, p.SnapshotVersion, p.TimestampVersion)
	return err
}

// Downloads the published crosswalk through a TUF client and checks it
func verify(ctx context.Context, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	repo := fs.String("repo", "", "flat repository directory")
	root := fs.String("root", "", "trusted root.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := required(map[string]string{"repo": *repo, "root": *root}); err != nil {
		return err
	}
	c, err := snapshot.Verify(ctx, *repo, *root)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "verified crosswalk %s built %s, %d items, %d xids, sqlite sha256 %s (%d bytes)\n", c.Version, c.BuiltAt, c.Items, c.XIDs, c.SQLiteSHA256, c.SQLiteLength)
	return err
}
