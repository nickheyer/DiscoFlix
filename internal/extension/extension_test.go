package extension

import (
	"errors"
	"testing"

	cardv1 "github.com/nickheyer/DiscoFlix/sdk/go/pb/discoflix/card/v1"
)

func TestRegistryCards(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(BuiltinCard(&cardv1.SystemNotice{})); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(BuiltinCard(&cardv1.BootReport{})); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(BuiltinCard(&cardv1.SystemNotice{})); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate = %v", err)
	}
	cs, ok := r.CardSchema("type.googleapis.com/discoflix.card.v1.BootReport")
	if !ok || cs.Describe().ID != "discoflix.card.boot-report" || cs.Describe().Origin != "builtin" {
		t.Fatalf("schema = %v %+v", ok, cs)
	}
	if _, ok := r.CardSchema("type.googleapis.com/acme.Unknown"); ok {
		t.Fatal("unknown type resolved")
	}
	if len(Of[CardSchema](r)) != 2 || len(Of[Notifier](r)) != 0 || len(r.Kinds()) != 1 {
		t.Fatalf("counts = %d %d %v", len(Of[CardSchema](r)), len(Of[Notifier](r)), r.Kinds())
	}
	if err := r.Register(builtinCard{}); err == nil {
		t.Fatal("empty card accepted")
	}
}
