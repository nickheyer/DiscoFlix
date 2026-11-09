package svc

import (
	"encoding/binary"
	"encoding/xml"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestTaskXMLEscapesAndQuotes(t *testing.T) {
	doc := taskXML(`C:\Program Files\Disco & Flix\discoflix.exe`, serveArgs(`D:\media data`), `D:\media data`, "S-1-5-21-1-2-3-1001")
	var task struct {
		Users   []string `xml:"Principals>Principal>UserId"`
		Logon   string   `xml:"Triggers>LogonTrigger>UserId"`
		Command string   `xml:"Actions>Exec>Command"`
		Args    string   `xml:"Actions>Exec>Arguments"`
		Policy  string   `xml:"Settings>MultipleInstancesPolicy"`
		Limit   string   `xml:"Settings>ExecutionTimeLimit"`
	}
	dec := xml.NewDecoder(strings.NewReader(strings.Replace(doc, `encoding="UTF-16"`, `encoding="UTF-8"`, 1)))
	if err := dec.Decode(&task); err != nil {
		t.Fatalf("task XML does not parse: %v", err)
	}
	if task.Command != `C:\Program Files\Disco & Flix\discoflix.exe` {
		t.Errorf("command %q", task.Command)
	}
	if task.Args != `serve --display web --data "D:\media data"` {
		t.Errorf("arguments %q", task.Args)
	}
	if task.Logon != "S-1-5-21-1-2-3-1001" || len(task.Users) != 1 || task.Users[0] != task.Logon {
		t.Errorf("principal %v and logon user %q", task.Users, task.Logon)
	}
	if task.Policy != "IgnoreNew" || task.Limit != "PT0S" {
		t.Errorf("settings %q %q", task.Policy, task.Limit)
	}
}

func TestUTF16LEHasBOM(t *testing.T) {
	b := utf16LE("<\u00e9>")
	if b[0] != 0xFF || b[1] != 0xFE {
		t.Fatalf("missing byte order mark % x", b[:2])
	}
	units := make([]uint16, (len(b)-2)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(b[2+2*i:])
	}
	if got := string(utf16.Decode(units)); got != "<\u00e9>" {
		t.Fatalf("round trip %q", got)
	}
}
