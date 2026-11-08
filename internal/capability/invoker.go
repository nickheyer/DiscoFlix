package capability

import (
	"context"
	"fmt"

	connect "connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connectinprocess"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

// Invoker calls registered capabilities in-process as a trusted principal through the full interceptor chain
type Invoker struct {
	reg    *Registry
	client *connect.Client
}

// NewInvoker builds an invoker over the server every transport registers its handlers on
func NewInvoker(reg *Registry, server *connect.Server) *Invoker {
	return &Invoker{reg: reg, client: connect.NewClient(connectinprocess.New(server))}
}

// NewInput returns an empty request message for a procedure
func (v *Invoker) NewInput(procedure string) (proto.Message, *Entry, error) {
	e, ok := v.reg.Get(procedure)
	if !ok {
		return nil, nil, fmt.Errorf("capability: %s is not registered", procedure)
	}
	msg, err := newMessage(e.Input)
	if err != nil {
		return nil, nil, err
	}
	return msg, e, nil
}

// Invoke runs a unary capability as p, so validation, authorization, and approval all apply
func (v *Invoker) Invoke(ctx context.Context, p Principal, procedure string, input proto.Message) (proto.Message, error) {
	return v.call(WithTrusted(ctx, p), procedure, input)
}

// InvokeApproved runs a destructive capability whose approval card was accepted
func (v *Invoker) InvokeApproved(ctx context.Context, p Principal, procedure string, input proto.Message) (proto.Message, error) {
	return v.call(WithApproved(WithTrusted(ctx, p)), procedure, input)
}

func (v *Invoker) call(ctx context.Context, procedure string, input proto.Message) (proto.Message, error) {
	e, ok := v.reg.Get(procedure)
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, "capability not registered: "+procedure)
	}
	if e.ServerStreaming || e.ClientStreaming {
		return nil, connect.NewError(connect.CodeUnimplemented, procedure+" streams and cannot be invoked in-process")
	}
	if got, want := input.ProtoReflect().Descriptor().FullName(), e.Input.FullName(); got != want {
		return nil, fmt.Errorf("capability: %s takes %s, got %s", procedure, want, got)
	}
	out, err := newMessage(e.Output)
	if err != nil {
		return nil, err
	}
	spec := connect.Spec{StreamType: connect.StreamTypeUnary, Schema: methodDescriptor(e), Procedure: e.Procedure}
	if err := v.client.CallUnary(ctx, spec, input, out); err != nil {
		return nil, err
	}
	return out, nil
}

func methodDescriptor(e *Entry) protoreflect.MethodDescriptor {
	sd, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(e.Service))
	if err != nil {
		return nil
	}
	svc, ok := sd.(protoreflect.ServiceDescriptor)
	if !ok {
		return nil
	}
	return svc.Methods().ByName(protoreflect.Name(e.Method))
}

func newMessage(md protoreflect.MessageDescriptor) (proto.Message, error) {
	mt, err := protoregistry.GlobalTypes.FindMessageByName(md.FullName())
	if err != nil {
		return nil, fmt.Errorf("capability: message type %s: %w", md.FullName(), err)
	}
	return mt.New().Interface(), nil
}
