package capability

import (
	"context"

	capabilityv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1"
	"github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/capability/v1/capabilityv1connect"
)

// Handler serves the registry over CapabilityService
type Handler struct {
	capabilityv1connect.UnimplementedCapabilityServiceHandler
	reg *Registry
}

// NewHandler returns the CapabilityService implementation for reg
func NewHandler(reg *Registry) *Handler { return &Handler{reg: reg} }

func (h *Handler) ListCapabilities(ctx context.Context, _ *capabilityv1.ListCapabilitiesRequest) (*capabilityv1.ListCapabilitiesResponse, error) {
	res := &capabilityv1.ListCapabilitiesResponse{}
	for e := range h.reg.All() {
		res.Capabilities = append(res.Capabilities, &capabilityv1.CapabilityEntry{
			Procedure:        e.Procedure,
			Name:             e.Name,
			Scope:            e.Scope,
			Effect:           e.Effect,
			Object:           e.Object,
			Slash:            e.Slash,
			Public:           e.Public,
			Title:            e.Title,
			Description:      e.Description,
			InputType:        string(e.Input.FullName()),
			OutputType:       string(e.Output.FullName()),
			InputSchemaJson:  string(e.InputSchema),
			OutputSchemaJson: string(e.OutputSchema),
			ServerStreaming:  e.ServerStreaming,
		})
	}
	return res, nil
}
