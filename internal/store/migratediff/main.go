// Command migratediff writes a new versioned migration from the Ent schema into internal/store/migrations
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/schema"
	_ "modernc.org/sqlite"

	"github.com/nickheyer/DiscoFlix/internal/store/ent/migrate"
)

func main() {
	name := flag.String("name", "", "migration name")
	dirPath := flag.String("dir", "internal/store/migrations", "migration directory")
	rehash := flag.Bool("rehash", false, "rewrite atlas.sum after editing a migration by hand")
	flag.Parse()
	var err error
	switch {
	case *rehash:
		err = hash(*dirPath)
	case *name == "":
		fmt.Fprintln(os.Stderr, "migratediff: -name or -rehash is required")
		os.Exit(2)
	default:
		err = run(context.Background(), *name, *dirPath)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "migratediff:", err)
		os.Exit(1)
	}
}

// run replays the directory on an in-memory database and diffs it against the Ent schema
func run(ctx context.Context, name, dirPath string) error {
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(1)")
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	dir, err := atlasmigrate.NewLocalDir(dirPath)
	if err != nil {
		return err
	}
	m, err := schema.NewMigrate(entsql.OpenDB(dialect.SQLite, db),
		schema.WithDir(dir),
		schema.WithMigrationMode(schema.ModeReplay),
		schema.WithDialect(dialect.SQLite),
		schema.WithFormatter(atlasmigrate.DefaultFormatter),
		schema.WithDropColumn(true),
		schema.WithDropIndex(true),
	)
	if err != nil {
		return err
	}
	return m.NamedDiff(ctx, name, migrate.Tables...)
}

// hash recomputes the directory checksum file so a hand-edited migration is accepted at boot
func hash(dirPath string) error {
	dir, err := atlasmigrate.NewLocalDir(dirPath)
	if err != nil {
		return err
	}
	sum, err := dir.Checksum()
	if err != nil {
		return err
	}
	return atlasmigrate.WriteSumFile(dir, sum)
}
