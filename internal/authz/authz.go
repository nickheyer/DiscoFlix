// Package authz embeds OpenFGA over its own SQLite file and applies staged tuple changes
package authz

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	openfgav1 "github.com/openfga/api/proto/openfga/v1"
	"github.com/openfga/language/pkg/go/transformer"
	"github.com/openfga/openfga/pkg/server"
	"github.com/openfga/openfga/pkg/storage/migrate"
	"github.com/openfga/openfga/pkg/storage/sqlcommon"
	"github.com/openfga/openfga/pkg/storage/sqlite"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/authzoutbox"
)

// FileName is the authorization database file inside the data directory
const FileName = "authz.db"

const storeName = "discoflix"

// Op is one staged relationship tuple change
type Op struct {
	Delete    bool
	Object    string
	Relation  string
	Subject   string
	Condition string
	Context   map[string]any
}

// Write stages a tuple insert
func Write(object, relation, subject string) Op {
	return Op{Object: object, Relation: relation, Subject: subject}
}

// Delete stages a tuple removal
func Delete(object, relation, subject string) Op {
	return Op{Delete: true, Object: object, Relation: relation, Subject: subject}
}

// Service answers relationship checks and drains the outbox into the OpenFGA store
type Service struct {
	srv     *server.Server
	storeID string
	modelID string
	ent     *ent.Client
	log     *slog.Logger
	mu      sync.Mutex

	hooksMu sync.RWMutex
	hooks   []func()
}

// OnChange registers a callback run after tuples are applied, so visibility caches can drop stale answers
func (s *Service) OnChange(fn func()) {
	s.hooksMu.Lock()
	defer s.hooksMu.Unlock()
	s.hooks = append(s.hooks, fn)
}

func (s *Service) changed() {
	s.hooksMu.RLock()
	hooks := append([]func(){}, s.hooks...)
	s.hooksMu.RUnlock()
	for _, fn := range hooks {
		fn()
	}
}

// Open migrates and opens the authorization store, then ensures the model matches Model
func Open(ctx context.Context, dataDir string, entc *ent.Client, log *slog.Logger) (*Service, error) {
	path := filepath.Join(dataDir, FileName)
	flog := slogLogger{log.With("component", "openfga")}
	if err := migrate.RunMigrations(migrate.MigrationConfig{Engine: "sqlite", URI: path, Logger: flog, Timeout: time.Minute, PingTimeout: 10 * time.Second}); err != nil {
		return nil, fmt.Errorf("authz: migrate: %w", err)
	}
	ds, err := sqlite.New(path, &sqlcommon.Config{Logger: flog, MaxTuplesPerWriteField: 1000, MaxTypesPerModelField: 100})
	if err != nil {
		return nil, fmt.Errorf("authz: datastore: %w", err)
	}
	srv, err := server.NewServerWithOpts(
		server.WithDatastore(ds),
		server.WithLogger(flog),
	)
	if err != nil {
		ds.Close()
		return nil, fmt.Errorf("authz: server: %w", err)
	}
	s := &Service{srv: srv, ent: entc, log: log}
	if err := s.ensureStore(ctx); err != nil {
		srv.Close()
		return nil, err
	}
	if err := s.ensureModel(ctx); err != nil {
		srv.Close()
		return nil, err
	}
	return s, nil
}

func (s *Service) ensureStore(ctx context.Context) error {
	res, err := s.srv.ListStores(ctx, &openfgav1.ListStoresRequest{PageSize: wrapperspb.Int32(100)})
	if err != nil {
		return fmt.Errorf("authz: list stores: %w", err)
	}
	for _, st := range res.GetStores() {
		if st.GetName() == storeName {
			s.storeID = st.GetId()
			return nil
		}
	}
	created, err := s.srv.CreateStore(ctx, &openfgav1.CreateStoreRequest{Name: storeName})
	if err != nil {
		return fmt.Errorf("authz: create store: %w", err)
	}
	s.storeID = created.GetId()
	return nil
}

// ensureModel writes Model when the latest stored model differs from it
func (s *Service) ensureModel(ctx context.Context) error {
	want, err := transformer.TransformDSLToProto(Model)
	if err != nil {
		return fmt.Errorf("authz: parse model: %w", err)
	}
	res, err := s.srv.ReadAuthorizationModels(ctx, &openfgav1.ReadAuthorizationModelsRequest{StoreId: s.storeID, PageSize: wrapperspb.Int32(1)})
	if err != nil {
		return fmt.Errorf("authz: read models: %w", err)
	}
	if models := res.GetAuthorizationModels(); len(models) == 1 && sameModel(models[0], want) {
		s.modelID = models[0].GetId()
		return nil
	}
	written, err := s.srv.WriteAuthorizationModel(ctx, &openfgav1.WriteAuthorizationModelRequest{
		StoreId:         s.storeID,
		SchemaVersion:   want.GetSchemaVersion(),
		TypeDefinitions: want.GetTypeDefinitions(),
		Conditions:      want.GetConditions(),
	})
	if err != nil {
		return fmt.Errorf("authz: write model: %w", err)
	}
	s.modelID = written.GetAuthorizationModelId()
	s.log.Info("authorization model written", "model_id", s.modelID)
	return nil
}

func sameModel(have, want *openfgav1.AuthorizationModel) bool {
	h := &openfgav1.AuthorizationModel{SchemaVersion: have.GetSchemaVersion(), TypeDefinitions: have.GetTypeDefinitions(), Conditions: have.GetConditions()}
	w := &openfgav1.AuthorizationModel{SchemaVersion: want.GetSchemaVersion(), TypeDefinitions: want.GetTypeDefinitions(), Conditions: want.GetConditions()}
	hj, err1 := protojson.Marshal(h)
	wj, err2 := protojson.Marshal(w)
	return err1 == nil && err2 == nil && string(hj) == string(wj)
}

// Check reports whether subject has relation on object, with optional contextual values
func (s *Service) Check(ctx context.Context, subject, relation, object string, contextual map[string]any) (bool, error) {
	req := &openfgav1.CheckRequest{
		StoreId:              s.storeID,
		AuthorizationModelId: s.modelID,
		TupleKey:             &openfgav1.CheckRequestTupleKey{User: subject, Relation: relation, Object: object},
	}
	if len(contextual) > 0 {
		st, err := structpb.NewStruct(contextual)
		if err != nil {
			return false, fmt.Errorf("authz: context: %w", err)
		}
		req.Context = st
	}
	res, err := s.srv.Check(ctx, req)
	if err != nil {
		return false, fmt.Errorf("authz: check %s#%s@%s: %w", object, relation, subject, err)
	}
	return res.GetAllowed(), nil
}

// ListObjects returns every object of objectType on which subject has relation
func (s *Service) ListObjects(ctx context.Context, subject, relation, objectType string) ([]string, error) {
	res, err := s.srv.ListObjects(ctx, &openfgav1.ListObjectsRequest{
		StoreId:              s.storeID,
		AuthorizationModelId: s.modelID,
		Type:                 objectType,
		Relation:             relation,
		User:                 subject,
	})
	if err != nil {
		return nil, fmt.Errorf("authz: list objects: %w", err)
	}
	return res.GetObjects(), nil
}

// ListUsers returns the user ids holding relation on object, and whether the wildcard user grants it to everyone
func (s *Service) ListUsers(ctx context.Context, object, relation string) ([]string, bool, error) {
	typ, id, ok := strings.Cut(object, ":")
	if !ok {
		return nil, false, fmt.Errorf("authz: object %q needs a type", object)
	}
	res, err := s.srv.ListUsers(ctx, &openfgav1.ListUsersRequest{
		StoreId:              s.storeID,
		AuthorizationModelId: s.modelID,
		Object:               &openfgav1.Object{Type: typ, Id: id},
		Relation:             relation,
		UserFilters:          []*openfgav1.UserTypeFilter{{Type: "user"}},
	})
	if err != nil {
		return nil, false, fmt.Errorf("authz: list users: %w", err)
	}
	var ids []string
	everyone := false
	for _, u := range res.GetUsers() {
		switch v := u.GetUser().(type) {
		case *openfgav1.User_Object:
			ids = append(ids, v.Object.GetId())
		case *openfgav1.User_Wildcard:
			everyone = true
		}
	}
	return ids, everyone, nil
}

// Has reports whether the exact tuple is stored, without evaluating the model
func (s *Service) Has(ctx context.Context, object, relation, subject string) (bool, error) {
	res, err := s.srv.Read(ctx, &openfgav1.ReadRequest{
		StoreId:  s.storeID,
		TupleKey: &openfgav1.ReadRequestTupleKey{User: subject, Relation: relation, Object: object},
		PageSize: wrapperspb.Int32(1),
	})
	if err != nil {
		return false, fmt.Errorf("authz: read %s#%s@%s: %w", object, relation, subject, err)
	}
	return len(res.GetTuples()) > 0, nil
}

// Stage records tuple changes in the outbox inside the caller's transaction
func Stage(ctx context.Context, tx *ent.Tx, ops ...Op) error {
	for _, op := range ops {
		c := tx.AuthzOutbox.Create().
			SetObject(op.Object).
			SetRelation(op.Relation).
			SetSubject(op.Subject).
			SetCondition(op.Condition)
		if op.Delete {
			c.SetOp(authzoutbox.OpDelete)
		} else {
			c.SetOp(authzoutbox.OpWrite)
		}
		if len(op.Context) > 0 {
			raw, err := json.Marshal(op.Context)
			if err != nil {
				return fmt.Errorf("authz: stage context: %w", err)
			}
			c.SetConditionContext(raw)
		}
		if _, err := c.Save(ctx); err != nil {
			return fmt.Errorf("authz: stage: %w", err)
		}
	}
	return nil
}

// Flush applies every unapplied outbox row in order, so callers read their own writes
func (s *Service) Flush(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		rows, err := s.ent.AuthzOutbox.Query().
			Where(authzoutbox.AppliedAtIsNil()).
			Order(ent.Asc(authzoutbox.FieldID)).
			Limit(200).
			All(ctx)
		if err != nil {
			return fmt.Errorf("authz: read outbox: %w", err)
		}
		if len(rows) == 0 {
			return nil
		}
		if err := s.apply(ctx, rows); err != nil {
			ids := make([]int64, len(rows))
			for i, r := range rows {
				ids[i] = r.ID
			}
			_ = s.ent.AuthzOutbox.Update().Where(authzoutbox.IDIn(ids...)).AddAttempts(1).SetLastError(err.Error()).Exec(ctx)
			return err
		}
	}
}

func (s *Service) apply(ctx context.Context, rows []*ent.AuthzOutbox) error {
	writes := &openfgav1.WriteRequestWrites{OnDuplicate: "ignore"}
	deletes := &openfgav1.WriteRequestDeletes{OnMissing: "ignore"}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
		if r.Op == authzoutbox.OpDelete {
			deletes.TupleKeys = append(deletes.TupleKeys, &openfgav1.TupleKeyWithoutCondition{Object: r.Object, Relation: r.Relation, User: r.Subject})
			continue
		}
		key := &openfgav1.TupleKey{Object: r.Object, Relation: r.Relation, User: r.Subject}
		if r.Condition != "" {
			cond := &openfgav1.RelationshipCondition{Name: r.Condition}
			if len(r.ConditionContext) > 0 {
				var m map[string]any
				if err := json.Unmarshal(r.ConditionContext, &m); err != nil {
					return fmt.Errorf("authz: outbox %d context: %w", r.ID, err)
				}
				st, err := structpb.NewStruct(m)
				if err != nil {
					return fmt.Errorf("authz: outbox %d context: %w", r.ID, err)
				}
				cond.Context = st
			}
			key.Condition = cond
		}
		writes.TupleKeys = append(writes.TupleKeys, key)
	}
	req := &openfgav1.WriteRequest{StoreId: s.storeID, AuthorizationModelId: s.modelID}
	if len(writes.TupleKeys) > 0 {
		req.Writes = writes
	}
	if len(deletes.TupleKeys) > 0 {
		req.Deletes = deletes
	}
	if _, err := s.srv.Write(ctx, req); err != nil {
		return fmt.Errorf("authz: write tuples: %w", err)
	}
	now := time.Now()
	if err := s.ent.AuthzOutbox.Update().Where(authzoutbox.IDIn(ids...)).SetAppliedAt(now).Exec(ctx); err != nil {
		return fmt.Errorf("authz: mark applied: %w", err)
	}
	s.changed()
	return nil
}

// Run drains the outbox on a timer until ctx ends, covering crashes between commit and flush
func (s *Service) Run(ctx context.Context) error {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		if err := s.Flush(ctx); err != nil && !errors.Is(err, context.Canceled) {
			s.log.Warn("authz outbox flush failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// Close stops the embedded server
func (s *Service) Close() {
	s.srv.Close()
}
