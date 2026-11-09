package display

import "testing"

func TestParse(t *testing.T) {
	for _, name := range []string{"auto", "all", "desktop", "web"} {
		m, err := Parse(name)
		if err != nil || string(m) != name {
			t.Fatalf("Parse(%q) = %q, %v", name, m, err)
		}
	}
	if _, err := Parse("tray"); err == nil {
		t.Fatal("unknown mode accepted")
	}
	if !All.Window() || !Desktop.Window() || Web.Window() || Auto.Window() {
		t.Fatal("window modes are all and desktop")
	}
	if !Desktop.Loopback() || All.Loopback() || Web.Loopback() {
		t.Fatal("only desktop stays on loopback")
	}
}
