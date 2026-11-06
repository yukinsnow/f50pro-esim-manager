package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidate(t *testing.T) {
	bad := []struct {
		op string
		i  Input
	}{{"purge", Input{}}, {"delete", Input{ICCID: "1;reboot"}}, {"enable", Input{ICCID: ""}}, {"nickname", Input{ICCID: "12345678901234567890", Nickname: "bad\nname"}}, {"download", Input{ActivationCode: "LPA:1$127.0.0.1/x$abc"}}, {"download", Input{ActivationCode: "reboot"}}, {"notification-send", Input{SeqNumber: "-1"}}}
	for _, x := range bad {
		if _, e := validate(x.op, x.i); e == nil {
			t.Fatal("accepted invalid", x.op)
		}
	}
	good := []struct {
		op string
		i  Input
	}{{"list", Input{}}, {"info", Input{}}, {"enable", Input{ICCID: "12345678901234567890"}}, {"nickname", Input{ICCID: "12345678901234567890", Nickname: "中文别名"}}, {"download", Input{ActivationCode: "LPA:1$rsp.example.com$abc"}}, {"notification-send", Input{SeqNumber: "1"}}}
	for _, x := range good {
		if _, e := validate(x.op, x.i); e != nil {
			t.Fatal(x.op, e)
		}
	}
}
func TestPendingShape(t *testing.T) {
	b, _ := json.Marshal(Result{OK: true, Data: map[string]interface{}{"pending": true, "jobId": "123"}})
	var x map[string]interface{}
	json.Unmarshal(b, &x)
	if x["ok"] != true {
		t.Fatal(string(b))
	}
}
func TestStatusWord(t *testing.T) {
	if sw([]byte{0x90, 0}) != 0x9000 || sw(nil) != 0 {
		t.Fatal("SW")
	}
}
func TestPublicIP(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "192.168.0.1", "10.0.0.1", "169.254.1.2", "100.64.0.1", "::1", "fc00::1"} {
		if publicIP(net.ParseIP(s)) {
			t.Fatal("accepted", s)
		}
	}
	if !publicIP(net.ParseIP("1.1.1.1")) {
		t.Fatal("public")
	}
}
func TestPoisonedBridgeNeverSends(t *testing.T) {
	b := Bridge{uncertain: true}
	if _, e := b.raw([]byte{0, 0x70, 0, 0, 1}); e == nil {
		t.Fatal("poison ignored")
	}
}
func TestDurableFailure(t *testing.T) {
	p := filepath.Join(t.TempDir(), "missing", "result.json")
	if e := atomic(p, Result{OK: true}); e == nil {
		t.Fatal("ignored persistence failure")
	}
}
func TestDurableSuccess(t *testing.T) {
	p := filepath.Join(t.TempDir(), "result.json")
	if e := atomic(p, Result{OK: true}); e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(p)
	if e != nil || !strings.Contains(string(b), `"ok":true`) {
		t.Fatal("missing result")
	}
}
