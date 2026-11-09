package catalog

import (
	"context"
	"errors"
	"fmt"
	"strings"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connectproto"

	"github.com/nickheyer/DiscoFlix/internal/capability"
	catalogv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/catalog/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/catalog/v1/catalogv1connect"
)

// Handler serves CatalogService over Connect
type Handler struct {
	catalogv1connect.UnimplementedCatalogServiceHandler
	svc *Service
}

// NewHandler wraps the catalog service
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

func principal(ctx context.Context) (capability.Principal, error) {
	p, ok := capability.PrincipalFrom(ctx)
	if !ok {
		return p, connect.NewError(connect.CodeUnauthenticated, "sign in to continue")
	}
	return p, nil
}

func mapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err.Error())
	case errors.Is(err, ErrUnknownSource):
		return connect.NewError(connect.CodeNotFound, err.Error())
	case errors.Is(err, ErrBadKind), errors.Is(err, ErrBadField):
		return connect.NewError(connect.CodeInvalidArgument, err.Error())
	case errors.Is(err, ErrMerged):
		return connect.NewError(connect.CodeFailedPrecondition, err.Error())
	case errors.Is(err, ErrNotLaunched):
		return connect.NewError(connect.CodeUnavailable, "the workflow runtime is still starting")
	}
	return err
}

// noMatch explains an empty resolution, naming the sources that could not take part and attaching every outcome
func noMatch(title string, outcomes []Outcome) error {
	var down []string
	for _, o := range outcomes {
		switch o.State {
		case StateUnreachable, StateMissing, StateBudget, StateOpen:
			down = append(down, o.Source)
		}
	}
	msg := fmt.Sprintf("no title matched %q", title)
	if len(down) > 0 {
		msg += ", and these sources could not answer: " + strings.Join(down, ", ")
	}
	err := connect.NewError(connect.CodeNotFound, msg)
	detail, derr := connectproto.NewErrorDetail(&catalogv1.NoMatch{Title: title, Sources: outcomesProto(outcomes)})
	if derr != nil {
		return err
	}
	return err.WithDetail(detail)
}

func (h *Handler) SearchEntities(ctx context.Context, req *catalogv1.SearchEntitiesRequest) (*catalogv1.SearchEntitiesResponse, error) {
	hits, outcomes, err := h.svc.Search(ctx, req.GetQuery(), KindString(req.GetKind()), int(req.GetYear()), int(req.GetLimit()), req.GetLocalOnly())
	if err != nil {
		return nil, mapErr(err)
	}
	out := &catalogv1.SearchEntitiesResponse{Sources: outcomesProto(outcomes)}
	for _, hit := range hits {
		c, err := h.svc.hitProto(ctx, hit)
		if err != nil {
			return nil, err
		}
		out.Candidates = append(out.Candidates, c)
	}
	return out, nil
}

func (h *Handler) ResolveTitle(ctx context.Context, req *catalogv1.ResolveTitleRequest) (*catalogv1.ResolveTitleResponse, error) {
	res, err := h.svc.ResolveTitle(ctx, req.GetTitle(), KindString(req.GetKind()), int(req.GetYear()), req.GetLocalOnly())
	if errors.Is(err, ErrNoMatch) {
		return nil, noMatch(req.GetTitle(), res.Outcomes)
	}
	if err != nil {
		return nil, mapErr(err)
	}
	e, err := h.svc.EntityProto(ctx, res.Hit.Entity)
	if err != nil {
		return nil, err
	}
	card, err := h.svc.EntityCard(ctx, res.Hit.Entity, res.Confidence, res.Explanation)
	if err != nil {
		return nil, err
	}
	out := &catalogv1.ResolveTitleResponse{Entity: e, Confidence: float32(res.Confidence), Explanation: res.Explanation, Sources: outcomesProto(res.Outcomes), Card: card}
	for _, alt := range res.Alternatives {
		c, err := h.svc.hitProto(ctx, alt)
		if err != nil {
			return nil, err
		}
		out.Alternatives = append(out.Alternatives, c)
	}
	return out, nil
}

func (h *Handler) GetEntity(ctx context.Context, req *catalogv1.GetEntityRequest) (*catalogv1.GetEntityResponse, error) {
	e, err := h.svc.GetEntity(ctx, req.GetId())
	if err != nil {
		return nil, mapErr(err)
	}
	ep, err := h.svc.EntityProto(ctx, e)
	if err != nil {
		return nil, err
	}
	claims, err := h.svc.Claims(ctx, e.ID)
	if err != nil {
		return nil, err
	}
	art, err := h.svc.ReadyArtwork(ctx, e.ID)
	if err != nil {
		return nil, err
	}
	children, err := h.svc.Children(ctx, e.ID)
	if err != nil {
		return nil, err
	}
	out := &catalogv1.GetEntityResponse{Entity: ep, Claims: claims, Artwork: art}
	for _, c := range children {
		cp, err := h.svc.EntityProto(ctx, c)
		if err != nil {
			return nil, err
		}
		out.Children = append(out.Children, cp)
	}
	return out, nil
}

func (h *Handler) LookupExternal(ctx context.Context, req *catalogv1.LookupExternalRequest) (*catalogv1.LookupExternalResponse, error) {
	e, created, outcomes, err := h.svc.LookupExternal(ctx, strings.ToLower(req.GetNamespace()), req.GetValue(), KindString(req.GetKind()))
	if err != nil {
		return nil, mapErr(err)
	}
	ep, err := h.svc.EntityProto(ctx, e)
	if err != nil {
		return nil, err
	}
	return &catalogv1.LookupExternalResponse{Entity: ep, Created: created, Sources: outcomesProto(outcomes)}, nil
}

func (h *Handler) PinField(ctx context.Context, req *catalogv1.PinFieldRequest) (*catalogv1.PinFieldResponse, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	if req.GetValue() == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, "a pinned field needs a value")
	}
	if err := h.svc.Pin(ctx, req.GetEntityId(), req.GetField(), req.GetValue().AsInterface(), p.UserID); err != nil {
		return nil, mapErr(err)
	}
	e, err := h.svc.GetEntity(ctx, req.GetEntityId())
	if err != nil {
		return nil, mapErr(err)
	}
	ep, err := h.svc.EntityProto(ctx, e)
	if err != nil {
		return nil, err
	}
	return &catalogv1.PinFieldResponse{Entity: ep}, nil
}

func (h *Handler) UnpinField(ctx context.Context, req *catalogv1.UnpinFieldRequest) (*catalogv1.UnpinFieldResponse, error) {
	if err := h.svc.Unpin(ctx, req.GetEntityId(), req.GetField()); err != nil {
		return nil, mapErr(err)
	}
	e, err := h.svc.GetEntity(ctx, req.GetEntityId())
	if err != nil {
		return nil, mapErr(err)
	}
	ep, err := h.svc.EntityProto(ctx, e)
	if err != nil {
		return nil, err
	}
	return &catalogv1.UnpinFieldResponse{Entity: ep}, nil
}

func (h *Handler) RefreshEntity(ctx context.Context, req *catalogv1.RefreshEntityRequest) (*catalogv1.RefreshEntityResponse, error) {
	id, err := h.svc.Refresh(ctx, req.GetEntityId())
	if err != nil {
		return nil, mapErr(err)
	}
	return &catalogv1.RefreshEntityResponse{WorkflowId: id}, nil
}

func (h *Handler) GetCatalogStatus(ctx context.Context, _ *catalogv1.GetCatalogStatusRequest) (*catalogv1.GetCatalogStatusResponse, error) {
	st, err := h.svc.Status(ctx)
	if err != nil {
		return nil, mapErr(err)
	}
	return st, nil
}

func (h *Handler) ConfigureSource(ctx context.Context, req *catalogv1.ConfigureSourceRequest) (*catalogv1.ConfigureSourceResponse, error) {
	if err := h.svc.ConfigureSource(ctx, req.GetSource(), req.GetEnabled(), req.GetOptions()); err != nil {
		return nil, mapErr(err)
	}
	src, err := h.svc.SourceProto(ctx, req.GetSource())
	if err != nil {
		return nil, mapErr(err)
	}
	return &catalogv1.ConfigureSourceResponse{Source: src}, nil
}

func (h *Handler) ConfigureCatalog(ctx context.Context, req *catalogv1.ConfigureCatalogRequest) (*catalogv1.ConfigureCatalogResponse, error) {
	if err := h.svc.ConfigureCatalog(ctx, req.GetMirrorUrl(), req.GetPeers(), req.GetLanguage()); err != nil {
		return nil, mapErr(err)
	}
	_, peers, lang := h.svc.CatalogSettings()
	return &catalogv1.ConfigureCatalogResponse{Snapshot: h.svc.SnapshotProto(), Peers: peers, Language: lang}, nil
}

func (h *Handler) UpdateSnapshot(_ context.Context, _ *catalogv1.UpdateSnapshotRequest) (*catalogv1.UpdateSnapshotResponse, error) {
	id, err := h.svc.UpdateSnapshot(true)
	if err != nil {
		return nil, mapErr(err)
	}
	return &catalogv1.UpdateSnapshotResponse{WorkflowId: id}, nil
}

func (h *Handler) ImportDataset(ctx context.Context, req *catalogv1.ImportDatasetRequest) (*catalogv1.ImportDatasetResponse, error) {
	id, err := h.svc.ImportDataset(ctx, req.GetDataset(), req.GetEnabled())
	if err != nil {
		return nil, mapErr(err)
	}
	st, err := h.svc.Status(ctx)
	if err != nil {
		return nil, mapErr(err)
	}
	out := &catalogv1.ImportDatasetResponse{WorkflowId: id}
	for _, d := range st.GetDatasets() {
		if d.GetDataset() == req.GetDataset() {
			out.Dataset = d
		}
	}
	return out, nil
}
