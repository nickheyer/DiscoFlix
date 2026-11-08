package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	atlasmigrate "ariga.io/atlas/sql/migrate"
)

const revisionTable = "atlas_schema_revisions"

// revisions stores applied migration versions in the application database
type revisions struct{ db *sql.DB }

func (r *revisions) init(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS `+revisionTable+` (
		version TEXT PRIMARY KEY,
		description TEXT NOT NULL,
		type INTEGER NOT NULL,
		applied INTEGER NOT NULL,
		total INTEGER NOT NULL,
		executed_at DATETIME NOT NULL,
		execution_time INTEGER NOT NULL,
		error TEXT NOT NULL DEFAULT '',
		error_stmt TEXT NOT NULL DEFAULT '',
		hash TEXT NOT NULL,
		partial_hashes TEXT NOT NULL DEFAULT '[]',
		operator_version TEXT NOT NULL DEFAULT ''
	)`)
	if err != nil {
		return fmt.Errorf("store: create revision table: %w", err)
	}
	return nil
}

func (r *revisions) Ident() *atlasmigrate.TableIdent {
	return &atlasmigrate.TableIdent{Name: revisionTable}
}

func (r *revisions) ReadRevisions(ctx context.Context) ([]*atlasmigrate.Revision, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT version, description, type, applied, total, executed_at, execution_time, error, error_stmt, hash, partial_hashes, operator_version FROM `+revisionTable+` ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("store: read revisions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []*atlasmigrate.Revision
	for rows.Next() {
		rev, err := scanRevision(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rev)
	}
	return out, rows.Err()
}

func (r *revisions) ReadRevision(ctx context.Context, version string) (*atlasmigrate.Revision, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT version, description, type, applied, total, executed_at, execution_time, error, error_stmt, hash, partial_hashes, operator_version FROM `+revisionTable+` WHERE version = ?`, version)
	if err != nil {
		return nil, fmt.Errorf("store: read revision: %w", err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		return nil, atlasmigrate.ErrRevisionNotExist
	}
	return scanRevision(rows)
}

func (r *revisions) WriteRevision(ctx context.Context, rev *atlasmigrate.Revision) error {
	partial, err := json.Marshal(rev.PartialHashes)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO `+revisionTable+` (version, description, type, applied, total, executed_at, execution_time, error, error_stmt, hash, partial_hashes, operator_version)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(version) DO UPDATE SET description = excluded.description, type = excluded.type, applied = excluded.applied, total = excluded.total,
		executed_at = excluded.executed_at, execution_time = excluded.execution_time, error = excluded.error, error_stmt = excluded.error_stmt,
		hash = excluded.hash, partial_hashes = excluded.partial_hashes, operator_version = excluded.operator_version`,
		rev.Version, rev.Description, int64(rev.Type), rev.Applied, rev.Total, rev.ExecutedAt.UTC().Format(time.RFC3339Nano), int64(rev.ExecutionTime),
		rev.Error, rev.ErrorStmt, rev.Hash, string(partial), rev.OperatorVersion)
	if err != nil {
		return fmt.Errorf("store: write revision: %w", err)
	}
	return nil
}

func (r *revisions) DeleteRevision(ctx context.Context, version string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM `+revisionTable+` WHERE version = ?`, version)
	if err != nil {
		return fmt.Errorf("store: delete revision: %w", err)
	}
	return nil
}

func scanRevision(rows *sql.Rows) (*atlasmigrate.Revision, error) {
	var (
		rev       atlasmigrate.Revision
		typ, exec int64
		executed  string
		partial   string
	)
	if err := rows.Scan(&rev.Version, &rev.Description, &typ, &rev.Applied, &rev.Total, &executed, &exec, &rev.Error, &rev.ErrorStmt, &rev.Hash, &partial, &rev.OperatorVersion); err != nil {
		return nil, fmt.Errorf("store: scan revision: %w", err)
	}
	rev.Type = atlasmigrate.RevisionType(typ)
	rev.ExecutionTime = time.Duration(exec)
	t, err := time.Parse(time.RFC3339Nano, executed)
	if err != nil {
		return nil, fmt.Errorf("store: revision time: %w", err)
	}
	rev.ExecutedAt = t
	if err := json.Unmarshal([]byte(partial), &rev.PartialHashes); err != nil {
		return nil, errors.Join(errors.New("store: revision partial hashes"), err)
	}
	return &rev, nil
}
