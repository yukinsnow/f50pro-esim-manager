// F50 eSIM manager: fixed operations, mature LPAC protocol engine, no raw API.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const base = "/data/adb/f50-esim"
const tools = "/data/user/0/com.minikano.f50_sms/files/"

type Input struct {
	ICCID            string `json:"iccid"`
	Nickname         string `json:"nickname"`
	ActivationCode   string `json:"activationCode"`
	ConfirmationCode string `json:"confirmationCode"`
	SeqNumber        string `json:"seqNumber"`
	JobID            string `json:"jobId"`
}
type Result struct {
	OK    bool        `json:"ok"`
	Data  interface{} `json:"data,omitempty"`
	Error string      `json:"error,omitempty"`
}

var digits = regexp.MustCompile(`^[0-9]{18,22}$`)
var jobPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func emit(r Result) { json.NewEncoder(os.Stdout).Encode(r) }
func fail(e error)  { emit(Result{Error: e.Error()}) }
func command(ctx context.Context, name string, args ...string) ([]byte, error) {
	c := exec.CommandContext(ctx, name, args...)
	c.Env = append(os.Environ(), "PATH=/system/bin:/system/xbin")
	return c.Output()
}
func guard() error {
	ctx, c := context.WithTimeout(context.Background(), 6*time.Second)
	defer c()
	b, e := command(ctx, tools+"curl", "--noproxy", "*", "-g", "-fsS", "--max-time", "4", "http://[::1]:8080/goform/goform_get_cmd_process?isTest=false&cmd=sim_slot,sim_iccid&multi_data=1")
	if e != nil {
		return errors.New("无法核对原厂卡槽状态")
	}
	var d map[string]string
	if json.Unmarshal(b, &d) != nil || d["sim_slot"] != "12" || d["sim_iccid"] == "" {
		return errors.New("请先在原厂后台选择物理 SIM2")
	}
	// Profiles may change ICCID; immutable EID is verified after every SELECT.
	return nil
}

type Bridge struct {
	ch        byte
	uncertain bool
	closeOK   bool
	ctx       context.Context
	cardFP    string
}

func (b *Bridge) raw(tx []byte) ([]byte, error) {
	if b.uncertain {
		return nil, errors.New("本次通道已失效，拒绝继续发送或自动补救；请核对状态")
	}
	if e := guard(); e != nil {
		b.uncertain = true
		return nil, e
	}
	ctx0, c0 := context.WithTimeout(b.ctx, 6*time.Second)
	state, se := command(ctx0, tools+"curl", "--noproxy", "*", "-g", "-fsS", "--max-time", "4", "http://[::1]:8080/goform/goform_get_cmd_process?isTest=false&cmd=sim_slot,sim_iccid&multi_data=1")
	c0()
	var snap map[string]string
	if se != nil || json.Unmarshal(state, &snap) != nil || snap["sim_slot"] != "12" || snap["sim_iccid"] == "" {
		b.uncertain = true
		return nil, errors.New("卡身份无法确认，停止发送APDU")
	}
	h := sha256.Sum256([]byte(snap["sim_iccid"]))
	fp := hex.EncodeToString(h[:])
	if b.cardFP == "" {
		b.cardFP = fp
	} else if b.cardFP != fp {
		b.uncertain = true
		return nil, errors.New("卡状态已变化（可能是刷新），停止旧通道操作；请重新读取，不要重复写入")
	}
	ctx, c := context.WithTimeout(b.ctx, 18*time.Second)
	defer c()
	s := strings.ToUpper(hex.EncodeToString(tx))
	out, e := command(ctx, tools+"sendat", "-c", fmt.Sprintf("AT+CSIM=%d,\"%s\"", len(s), s), "-n", "0")
	if e != nil {
		b.uncertain = true
		return nil, errors.New("APDU 通信中断，结果不确定；禁止自动重试")
	}
	re := regexp.MustCompile(`\+CSIM:\s*([0-9]+),\s*"?([a-fA-F0-9]+)`)
	m := re.FindSubmatch(out)
	if m == nil {
		b.uncertain = true
		return nil, errors.New("modem 未返回有效 APDU，结果不确定")
	}
	n, _ := strconv.Atoi(string(m[1]))
	if n != len(m[2]) {
		b.uncertain = true
		return nil, errors.New("APDU 长度不符")
	}
	r, e := hex.DecodeString(string(m[2]))
	if e != nil || len(r) < 2 {
		b.uncertain = true
		return nil, errors.New("APDU 响应无效")
	}
	return r, nil
}
func sw(r []byte) int {
	if len(r) < 2 {
		return 0
	}
	return int(r[len(r)-2])<<8 | int(r[len(r)-1])
}
func (b *Bridge) open(aid []byte) (int, error) {
	r, e := b.raw([]byte{0, 0x70, 0, 0, 1})
	if e != nil {
		return -1, e
	}
	if len(r) != 3 || sw(r) != 0x9000 {
		return -1, errors.New("无法打开卡逻辑通道")
	}
	b.ch = r[0]
	if b.ch < 1 || b.ch > 3 {
		return -1, errors.New("不支持的逻辑通道")
	}
	t := append([]byte{b.ch, 0xa4, 4, 0, byte(len(aid))}, aid...)
	t = append(t, 0)
	r, e = b.raw(t)
	if e != nil {
		return -1, e
	}
	if sw(r) != 0x9000 && sw(r)>>8 != 0x61 {
		return -1, errors.New("无法选择 ISD-R")
	}
	// Verify immutable EID before handing a channel to LPAC (including writes).
	r, e = b.raw([]byte{0x80 | b.ch, 0xe2, 0x91, 0, 6, 0xbf, 0x3e, 3, 0x5c, 1, 0x5a, 0})
	if e != nil {
		return -1, e
	}
	var all []byte
	for n := 0; n < 32; n++ {
		all = append(all, r[:len(r)-2]...)
		if sw(r)>>8 != 0x61 {
			break
		}
		r, e = b.raw([]byte{b.ch, 0xc0, 0, 0, byte(sw(r))})
		if e != nil {
			return -1, e
		}
	}
	if sw(r) != 0x9000 || len(all) != 21 || !bytes.Equal(all[:5], []byte{0xbf, 0x3e, 0x12, 0x5a, 0x10}) {
		return -1, errors.New("EID验证失败")
	}
	h := sha256.Sum256(all[5:])
	want, e := os.ReadFile(base + "/eid.sha256")
	if e != nil || strings.TrimSpace(string(want)) != hex.EncodeToString(h[:]) {
		return -1, errors.New("EID与绑定9esim不符，已拒绝操作")
	}
	return int(b.ch), nil
}
func (b *Bridge) close() error {
	if b.ch == 0 {
		return nil
	}
	if b.uncertain {
		return errors.New("通道状态不确定，未盲目关闭其他通道")
	}
	ch := b.ch
	b.ch = 0
	r, e := b.raw([]byte{0, 0x70, 0x80, ch, 0})
	if e != nil || sw(r) != 0x9000 {
		return errors.New("通道关闭未确认")
	}
	b.closeOK = true
	return nil
}

// HTTPS uses device curl with certificate verification, not Go resolver/static libc.
func publicIP(ip net.IP) bool {
	return ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsUnspecified() && !(ip.To4() != nil && ip.To4()[0] == 100 && ip.To4()[1] >= 64 && ip.To4()[1] <= 127)
}
func resolvePublic(ctx context.Context, host string) (string, error) {
	if ip := net.ParseIP(host); ip != nil {
		if !publicIP(ip) {
			return "", errors.New("拒绝非公网LPA地址")
		}
		return ip.String(), nil
	}
	// Android's network DNS via its local forwarder, with public resolver fallback.
	resolver := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, "127.0.0.1:53")
	}}
	ips, e := resolver.LookupIP(ctx, "ip", host)
	if e != nil {
		return "", errors.New("SM-DP+ DNS解析失败")
	}
	if len(ips) == 0 {
		return "", errors.New("SM-DP+ DNS无结果")
	}
	for _, ip := range ips {
		if !publicIP(ip) {
			return "", errors.New("拒绝解析到本地网络的LPA目标")
		}
	}
	for _, ip := range ips {
		if ip.To4() != nil {
			return ip.String(), nil
		}
	}
	return ips[0].String(), nil
}
func httpRequest(ctx context.Context, p map[string]interface{}) (map[string]interface{}, error) {
	u, _ := p["url"].(string)
	parsed, e := url.Parse(u)
	if e != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" || parsed.Port() != "" && parsed.Port() != "443" {
		return nil, errors.New("LPA 服务器必须为 HTTPS 443")
	}
	ip := net.ParseIP(parsed.Hostname())
	if ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()) {
		return nil, errors.New("拒绝本地 LPA 目标")
	}
	resolved, e := resolvePublic(ctx, parsed.Hostname())
	if e != nil {
		return nil, e
	}
	tx, _ := p["tx"].(string)
	body, e := hex.DecodeString(tx)
	if e != nil {
		return nil, e
	}
	tmp, e := os.MkdirTemp(base, "http-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(tmp)
	os.Chmod(tmp, 0700)
	path := filepath.Join(tmp, "body")
	if e = os.WriteFile(path, body, 0600); e != nil {
		return nil, e
	}
	args := []string{"-q", "--noproxy", "*", "--proto", "=https", "--connect-timeout", "20", "--max-time", "90", "-sS", "-X", "POST", "-o", filepath.Join(tmp, "reply"), "-w", "%{http_code}", "--data-binary", "@" + path}
	if hs, ok := p["headers"].([]interface{}); ok {
		for _, h := range hs {
			s, ok := h.(string)
			if !ok || strings.ContainsAny(s, "\r\n") {
				return nil, errors.New("无效 HTTPS header")
			}
			args = append(args, "-H", s)
		}
	}
	addr := resolved
	if strings.Contains(addr, ":") {
		addr = "[" + addr + "]"
	}
	args = append(args, "--resolve", parsed.Hostname()+":443:"+addr, u)
	out, e := command(ctx, tools+"curl", args...)
	if e != nil {
		return nil, errors.New("LPA HTTPS 失败；检查联网和服务器证书，不会自动重试")
	}
	rx, e := os.ReadFile(filepath.Join(tmp, "reply"))
	if e != nil || len(rx) > 16*1024*1024 {
		return nil, errors.New("LPA 响应过大或不可读")
	}
	status, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return map[string]interface{}{"rcode": status, "rx": hex.EncodeToString(rx)}, nil
}
func runLPAC(ctx context.Context, args ...string) (interface{}, error) {
	if e := guard(); e != nil {
		return nil, e
	}
	b := &Bridge{ctx: ctx}
	cmd := exec.CommandContext(ctx, base+"/lpac")
	argRead, argWrite, e := os.Pipe()
	if e != nil {
		return nil, e
	}
	defer argRead.Close()
	defer argWrite.Close()
	cmd.ExtraFiles = []*os.File{argRead}
	cmd.Env = []string{"PATH=/system/bin", "LPAC_APDU=stdio", "LPAC_HTTP=stdio", "F50_LPAC_ARG_FD=3"}
	in, e := cmd.StdinPipe()
	if e != nil {
		return nil, e
	}
	out, e := cmd.StdoutPipe()
	if e != nil {
		return nil, e
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if e = cmd.Start(); e != nil {
		return nil, e
	}
	argRead.Close()
	for _, a := range args {
		argWrite.Write(append([]byte(a), 0))
	}
	argWrite.Close()
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 4096), 32*1024*1024)
	var final map[string]interface{}
	var bridgeErr error
	for scanner.Scan() {
		var x struct {
			Type    string                 `json:"type"`
			Payload map[string]interface{} `json:"payload"`
		}
		if json.Unmarshal(scanner.Bytes(), &x) != nil {
			continue
		}
		if x.Type == "lpa" {
			if _, ok := x.Payload["code"]; ok {
				final = x.Payload
			}
			// REFRESH may invalidate/reassign old channel even if ICCID is unchanged.
			if len(args) > 1 && (args[1] == "enable" || args[1] == "disable") {
				b.ch = 0
				b.uncertain = true
			}
			continue
		}
		var p map[string]interface{}
		if x.Type == "apdu" {
			f, _ := x.Payload["func"].(string)
			s, _ := x.Payload["param"].(string)
			tx, _ := hex.DecodeString(s)
			code := 0
			data := ""
			var err error
			switch f {
			case "connect":
				err = guard()
			case "disconnect":
				err = b.close()
			case "logic_channel_open":
				code, err = b.open(tx)
			case "logic_channel_close":
				err = b.close()
			case "transmit":
				var rx []byte
				rx, err = b.raw(tx)
				data = hex.EncodeToString(rx)
			default:
				err = errors.New("不支持的 APDU 回调")
			}
			if err != nil {
				code = -1
				bridgeErr = err
			}
			p = map[string]interface{}{"ecode": code, "data": data}
		} else if x.Type == "http" {
			p, e = httpRequest(ctx, x.Payload)
			if e != nil {
				bridgeErr = e
				p = map[string]interface{}{"rcode": 599, "rx": ""}
			}
		} else {
			continue
		}
		reply, _ := json.Marshal(map[string]interface{}{"type": x.Type, "payload": p})
		if _, e = in.Write(append(reply, '\n')); e != nil {
			break
		}
	}
	in.Close()
	wait := cmd.Wait()
	ce := b.close()
	// Preserve terminal success instead of reporting cleanup as mutation failure.
	if final != nil && len(args) > 1 && args[0] == "profile" && args[1] != "list" {
		if c, ok := final["code"].(float64); ok && c == 0 {
			return final["data"], nil
		}
	}
	if bridgeErr != nil {
		return nil, bridgeErr
	}
	if ce != nil {
		return nil, ce
	}
	if scanner.Err() != nil {
		return nil, errors.New("LPA 返回数据过大或通信异常")
	}
	if final == nil {
		return nil, fmt.Errorf("LPA 未返回结果（%v）", wait)
	}
	code, _ := final["code"].(float64)
	if code != 0 {
		return nil, fmt.Errorf("LPA 操作失败：%v", final["message"])
	}
	return final["data"], nil
}
func lock() (*os.File, error) {
	f, e := os.OpenFile(base+"/manager.lock", os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("读卡器忙，等待当前操作完成")
	}
	if e = os.Mkdir(base+"/read.lock", 0700); e != nil {
		f.Close()
		return nil, errors.New("只读查看器正在使用读卡器")
	}
	return f, nil
}
func unlock(f *os.File) {
	if f == nil {
		return
	}
	os.Remove(base + "/read.lock")
	f.Close()
}
func validate(op string, i Input) ([]string, error) {
	switch op {
	case "list":
		return []string{"profile", "list"}, nil
	case "info":
		return []string{"chip", "info"}, nil
	case "notifications":
		return []string{"notification", "list"}, nil
	case "nickname", "enable", "disable", "delete":
		if !digits.MatchString(i.ICCID) {
			return nil, errors.New("ICCID 格式无效")
		}
		a := []string{"profile", op, i.ICCID}
		if op == "nickname" {
			if len([]byte(i.Nickname)) > 64 || strings.ContainsAny(i.Nickname, "\x00\r\n") {
				return nil, errors.New("昵称需为最多64字节的单行文本")
			}
			a = append(a, i.Nickname)
		}
		if op == "enable" || op == "disable" {
			a = append(a, "1")
		}
		return a, nil
	case "download":
		parts := strings.Split(i.ActivationCode, "$")
		if len(parts) < 3 || len(parts) > 5 || parts[0] != "LPA:1" || len(i.ActivationCode) > 4096 || strings.ContainsAny(i.ActivationCode, "\r\n\x00") {
			return nil, errors.New("激活码应为 LPA:1$服务器$匹配码")
		}
		if strings.ContainsAny(parts[1], "/:@?# ") || !strings.Contains(parts[1], ".") {
			return nil, errors.New("无效 SM-DP+ 域名")
		}
		if len(i.ConfirmationCode) > 128 || strings.ContainsAny(i.ConfirmationCode, "\x00\r\n") {
			return nil, errors.New("无效确认码")
		}
		a := []string{"profile", "download", "-a", i.ActivationCode}
		if i.ConfirmationCode != "" {
			a = append(a, "-c", i.ConfirmationCode)
		}
		return a, nil
	case "notification-send":
		if i.SeqNumber == "all" {
			return []string{"notification", "process", "-a"}, nil
		}
		if _, e := strconv.ParseUint(i.SeqNumber, 10, 32); e != nil {
			return nil, errors.New("请选择通知序号或all")
		}
		return []string{"notification", "process", i.SeqNumber}, nil
	}
	return nil, errors.New("不支持的操作")
}
func preflight(ctx context.Context, op string, i Input) error {
	if op != "enable" && op != "disable" && op != "delete" && op != "nickname" {
		return nil
	}
	d, e := runLPAC(ctx, "profile", "list")
	if e != nil {
		return e
	}
	ps, ok := d.([]interface{})
	if !ok {
		return errors.New("配置列表格式异常")
	}
	for _, p := range ps {
		m, _ := p.(map[string]interface{})
		if m["iccid"] != i.ICCID {
			continue
		}
		state, _ := m["profileState"].(string)
		enabled := strings.Contains(strings.ToLower(state), "enabled")
		if op == "delete" && enabled {
			return errors.New("不能删除正在启用的配置，请先停用或切换")
		}
		if op == "enable" && enabled {
			return errors.New("该配置已经启用")
		}
		if op == "disable" && !enabled {
			return errors.New("该配置已经停用")
		}
		return nil
	}
	return errors.New("目标配置不存在，已停止")
}
func atomic(path string, r Result) error {
	b, e := json.Marshal(r)
	if e != nil {
		return e
	}
	return durable(path, b)
}
func durable(path string, b []byte) error {
	tmp := path + ".new"
	f, e := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	if e == nil {
		e = f.Sync()
	}
	f.Close()
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e == nil {
		defer d.Close()
		return d.Sync()
	}
	return e
}
func execute(op string, i Input) Result {
	var f *os.File
	var e error
	if os.Getenv("F50_INHERIT_LOCK") == "1" {
		f = os.NewFile(3, "inherited-manager-lock")
	} else {
		f, e = lock()
	}
	if e != nil {
		return Result{Error: e.Error()}
	}
	defer unlock(f)
	ctx, c := context.WithTimeout(context.Background(), 12*time.Minute)
	defer c()
	a, e := validate(op, i)
	if e != nil {
		return Result{Error: e.Error()}
	}
	if e = preflight(ctx, op, i); e != nil {
		return Result{Error: e.Error()}
	}
	d, e := runLPAC(ctx, a...)
	if e != nil {
		if op != "list" && op != "info" && op != "notifications" {
			return Result{Error: "写入结果未确认，禁止重复提交。请重新读取配置核对。 " + e.Error(), Data: map[string]interface{}{"outcomeUnknown": true, "doNotRetry": true}}
		}
		return Result{Error: e.Error()}
	}
	if op == "list" || op == "info" || op == "notifications" {
		return Result{OK: true, Data: d}
	}
	verified := false
	available := false
	var readback interface{}
	if op != "notification-send" {
		readback, e = runLPAC(ctx, "profile", "list")
		available = e == nil
		verified = available && op != "download"
		if verified && op != "download" {
			found := false
			match := false
			if ps, ok := readback.([]interface{}); ok {
				for _, p := range ps {
					m, _ := p.(map[string]interface{})
					if m["iccid"] == i.ICCID {
						found = true
						switch op {
						case "enable":
							match = m["profileState"] == "enabled"
						case "disable":
							match = m["profileState"] == "disabled"
						case "nickname":
							match = m["profileNickname"] == i.Nickname
						}
					}
				}
				if op == "delete" {
					match = !found
				}
			}
			verified = match
		}
	}
	return Result{OK: true, Data: map[string]interface{}{"result": d, "readback": readback, "readbackAvailable": available, "verified": verified, "applied": true, "message": "卡已返回成功；请核对最新配置状态。断网时不要重复提交。"}}
}
func rsaKey() (*rsa.PrivateKey, error) {
	path := base + "/manager-rsa.key"
	raw, e := os.ReadFile(path)
	if e == nil {
		return x509.ParsePKCS1PrivateKey(raw)
	}
	k, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		return nil, e
	}
	if e = durable(path, x509.MarshalPKCS1PrivateKey(k)); e != nil {
		return nil, e
	}
	return k, nil
}
func decodeInput(arg string) ([]byte, error) {
	if !strings.HasPrefix(arg, "enc1.") {
		return base64.StdEncoding.DecodeString(arg)
	}
	k, e := rsaKey()
	if e != nil {
		return nil, e
	}
	var all []byte
	chunks := strings.Split(strings.TrimPrefix(arg, "enc1."), ".")
	if len(chunks) > 32 {
		return nil, errors.New("encrypted input too long")
	}
	for _, c := range chunks {
		b, e := base64.RawURLEncoding.DecodeString(c)
		if e != nil {
			return nil, e
		}
		p, e := rsa.DecryptPKCS1v15(rand.Reader, k, b)
		if e != nil {
			return nil, errors.New("encrypted input invalid")
		}
		all = append(all, p...)
	}
	return all, nil
}
func main() {
	syscall.Umask(0077)
	if len(os.Args) < 2 {
		fail(errors.New("missing operation"))
		return
	}
	op := os.Args[1]
	var i Input
	if len(os.Args) > 2 && os.Args[2] != "" {
		b, e := decodeInput(os.Args[2])
		if e != nil || len(b) > 8192 || json.Unmarshal(b, &i) != nil {
			fail(errors.New("输入格式无效"))
			return
		}
	}
	if op == "worker" {
		if !jobPattern.MatchString(i.JobID) {
			return
		}
		var req struct {
			Op    string
			Input Input
		}
		path := base + "/jobs/" + i.JobID
		raw, e := os.ReadFile(path + ".request")
		if e != nil || json.Unmarshal(raw, &req) != nil {
			return
		}
		result := execute(req.Op, req.Input)
		os.Remove(path + ".request")
		if e = atomic(path+".json", result); e != nil { /* retain pending as unknown; never replay */
		}
		return
	}
	if op == "status" {
		_, e := os.Stat(base + "/lpac")
		k, ke := rsaKey()
		publicKey := map[string]interface{}{}
		if ke == nil {
			publicKey = map[string]interface{}{"n": k.N.Text(16), "e": k.E}
		}
		emit(Result{OK: true, Data: map[string]interface{}{"publicKey": publicKey, "engineReady": e == nil, "engine": "LPAC 2.3.0 + F50 AT", "writesVerified": false, "cardReady": guard() == nil, "supported": []string{"list", "info", "enable", "disable", "delete", "nickname", "download", "notifications", "notification-send"}}})
		return
	}
	if op == "job" {
		if !jobPattern.MatchString(i.JobID) {
			fail(errors.New("无效任务ID"))
			return
		}
		b, e := os.ReadFile(base + "/jobs/" + i.JobID + ".json")
		if e != nil {
			fail(errors.New("任务记录不存在，请刷新列表确认状态，勿重复操作"))
			return
		}
		os.Stdout.Write(b)
		return
	}
	if op == "download" && (len(os.Args) < 3 || !strings.HasPrefix(os.Args[2], "enc1.")) {
		fail(errors.New("下载参数必须加密，拒绝明文激活码"))
		return
	}
	if _, e := validate(op, i); e != nil {
		fail(e)
		return
	}
	if op == "list" || op == "info" || op == "notifications" {
		emit(execute(op, i))
		return
	}
	// Start sensitive operations in a detached private job. Never retry them automatically.
	if e := guard(); e != nil {
		fail(e)
		return
	}
	f, e := lock()
	if e != nil {
		fail(e)
		return
	}
	defer func() { unlock(f) }()
	if e = os.MkdirAll(base+"/jobs", 0700); e != nil {
		fail(e)
		return
	}
	for _, x := range mustGlob(base + "/jobs/*.json") {
		b, _ := os.ReadFile(x)
		var r Result
		if json.Unmarshal(b, &r) == nil {
			if m, ok := r.Data.(map[string]interface{}); ok && (m["pending"] == true || m["outcomeUnknown"] == true) {
				fail(errors.New("已有未完成的写入任务，先检查状态，禁止重复提交"))
				return
			}
		}
	}
	idBytes := make([]byte, 16)
	if _, e = rand.Read(idBytes); e != nil {
		fail(e)
		return
	}
	id := hex.EncodeToString(idBytes)
	path := base + "/jobs/" + id
	req, _ := json.Marshal(map[string]interface{}{"Op": op, "Input": i})
	if e = durable(path+".request", req); e != nil {
		fail(e)
		return
	}
	pending := Result{OK: true, Data: map[string]interface{}{"pending": true, "jobId": id}}
	if e = atomic(path+".json", pending); e != nil {
		os.Remove(path + ".request")
		fail(e)
		return
	}
	arg, _ := json.Marshal(Input{JobID: id})
	cmd := exec.Command(base+"/manager", "worker", base64.StdEncoding.EncodeToString(arg))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	dev, _ := os.OpenFile("/dev/null", os.O_RDWR, 0)
	cmd.Stdin = dev
	cmd.Stdout = dev
	cmd.Stderr = dev
	// Pass locked descriptor; parent must not remove read.lock during transfer.
	cmd.ExtraFiles = []*os.File{f}
	cmd.Env = append(os.Environ(), "F50_INHERIT_LOCK=1")
	if e = cmd.Start(); e != nil {
		atomic(path+".json", Result{Error: "后台任务启动失败"})
		fail(e)
		return
	}
	cmd.Process.Release()
	f.Close()
	f = nil
	emit(pending)
}
func mustGlob(s string) []string { x, _ := filepath.Glob(s); return x }

// Compile-time references ensure all stdio / process paths remain supported.
var _ io.Reader
var _ = http.MethodPost
