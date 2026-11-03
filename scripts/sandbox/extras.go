package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"syscall"
	"time"
)

func extraCommand() bool {
	if len(os.Args) < 2 {
		return false
	}
	switch os.Args[1] {
	case "certificate":
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		must(err)
		serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
		must(err)
		cert := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "sandbox.test"}, DNSNames: []string{"sandbox.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
		must(err)
		raw, err := x509.MarshalPKCS8PrivateKey(key)
		must(err)
		json.NewEncoder(os.Stdout).Encode(map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}))})
	case "manager":
		must(os.MkdirAll("/data/configs", 0700))
		b, err := os.ReadFile("/config/example.yaml")
		must(err)
		must(os.WriteFile("/data/configs/example.yaml", b, 0600))
		must(os.Chdir("/data"))
		must(syscall.Exec("/manager", []string{"/manager"}, os.Environ()))
	case "udp":
		result := map[string]any{}
		body, err := udpRequest(os.Args[2], os.Args[3])
		if err != nil {
			result["error"] = err.Error()
		} else {
			result["body"] = body
		}
		json.NewEncoder(os.Stdout).Encode(result)
	default:
		return false
	}
	return true
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
func udpOrigin() {
	conn, err := net.ListenPacket("udp", ":8081")
	must(err)
	defer conn.Close()
	buf := make([]byte, 2048)
	for {
		n, addr, err := conn.ReadFrom(buf)
		if err != nil {
			return
		}
		b, _ := json.Marshal(map[string]string{"marker": "isolated-udp", "payload": string(buf[:n]), "remote": addr.String()})
		conn.WriteTo(b, addr)
	}
}
func udpRequest(proxy, origin string) (string, error) {
	c, err := net.DialTimeout("tcp", proxy+":7890", 3*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(8 * time.Second))
	c.Write([]byte{5, 1, 0})
	ack := make([]byte, 2)
	if _, err = io.ReadFull(c, ack); err != nil {
		return "", err
	}
	if ack[1] != 0 {
		return "", fmt.Errorf("SOCKS auth: %v", ack)
	}
	c.Write([]byte{5, 3, 0, 1, 0, 0, 0, 0, 0, 0})
	head := make([]byte, 4)
	if _, err = io.ReadFull(c, head); err != nil {
		return "", err
	}
	if head[1] != 0 {
		return "", fmt.Errorf("UDP associate: %v", head)
	}
	size := 4
	if head[3] == 4 {
		size = 16
	}
	if head[3] != 1 && head[3] != 4 {
		return "", fmt.Errorf("unexpected address: %v", head)
	}
	addr := make([]byte, size+2)
	if _, err = io.ReadFull(c, addr); err != nil {
		return "", err
	}
	u, err := net.DialTimeout("udp", net.JoinHostPort(proxy, fmt.Sprint(binary.BigEndian.Uint16(addr[size:]))), 3*time.Second)
	if err != nil {
		return "", err
	}
	defer u.Close()
	u.SetDeadline(time.Now().Add(8 * time.Second))
	packet := append([]byte{0, 0, 0, 1}, net.ParseIP(origin).To4()...)
	packet = append(packet, 0x1f, 0x91)
	packet = append(packet, []byte("review-udp-probe")...)
	if _, err = u.Write(packet); err != nil {
		return "", err
	}
	buf := make([]byte, 2048)
	n, err := u.Read(buf)
	if err != nil {
		return "", err
	}
	if n < 4 {
		return "", fmt.Errorf("short response")
	}
	offset := 10
	if buf[3] == 4 {
		offset = 22
	}
	if buf[3] == 3 {
		offset = 7 + int(buf[4])
	}
	if n < offset {
		return "", fmt.Errorf("short address")
	}
	return string(buf[offset:n]), nil
}
