// Fields follow the pinned Mihomo v1.19.32 configuration reference.
// Option notes cross-checked with https://wiki.metacubex.one/config/proxies/.
// All endpoints and credentials below are placeholders, not usable accounts.
export type NodeExample = { id: string; type: string; label: string; note: string; yaml: string }
const uuid = '00000000-0000-4000-8000-000000000001'
export const nodeExamples: NodeExample[] = [
  {
    id: 'vless-reality',
    type: 'vless',
    label: 'VLESS · Reality',
    note: 'UUID、公钥、short-id 和伪装域名都要与服务端一致。',
    yaml: `# VLESS + TCP + Reality；地址和认证信息均需替换
name: 我的 Reality 节点  # 自定义名称，不可与其他节点或代理组重名
type: vless  # 协议类型；切换协议请选用对应示例
server: node.example.com  # 服务器域名或 IP
port: 443  # 服务端端口，1–65535
uuid: ${uuid}  # 服务端分配的用户 UUID

# 传输与流控
network: tcp  # 本例使用 TCP；VLESS 还支持 ws / http / h2 / grpc / xhttp
# 改传输方式时需同步设置对应的 *-opts，不能只改 network
flow: xtls-rprx-vision  # 备选：xtls-rprx-vision；不用 Vision 时删除此行
udp: true  # true 允许 UDP / false 禁用 UDP
# packet-encoding: xudp  # 备选：xudp / packetaddr；省略为原始编码，按服务端选择

# Reality；本例必须保留 tls: true
tls: true
servername: www.example.com  # 服务端允许的 SNI，通常是伪装站点域名
client-fingerprint: chrome  # 常用备选：chrome / firefox / safari / ios / android / edge / random
reality-opts:
  public-key: "替换为服务端公钥"  # 服务端私钥对应的公钥，不要填私钥
  short-id: "0123456789abcdef"  # 服务端 shortIds 中的一项，保留引号

# 可选出站设置：需要时去掉行首的 #
# ip-version: dual  # 备选：dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
# interface-name: eth0  # 运行 Mihomo 的设备上的出口网卡
# dialer-proxy: 前置代理名称  # 已有节点或代理组名称，不可引用自己
`,
  },
  {
    id: 'vless-ws',
    type: 'vless',
    label: 'VLESS · WebSocket + TLS',
    note: '适用于使用 WebSocket 的节点。path 和 Host 按服务端或 CDN 配置填写。',
    yaml: `# VLESS + WebSocket + TLS；填写服务端提供的参数
name: 我的 VLESS WS 节点  # 自定义且不重复的名称
type: vless
server: node.example.com  # 服务器或 CDN 地址
port: 443  # 服务端端口，1–65535
uuid: ${uuid}  # 用户 UUID
tls: true  # true 使用 WSS / false 使用明文 WS，须与服务端一致
servername: node.example.com  # TLS 证书域名
network: ws  # 本例使用 ws；其他备选：tcp / http / h2 / grpc / xhttp
# 换传输方式需删除 ws-opts，并填写对应的 *-opts；本例不配置 Vision flow
udp: true  # true 允许 UDP / false 禁用 UDP
ws-opts:
  path: /ws  # 服务端 WebSocket 路径
  headers:
    Host: node.example.com  # HTTP Host
  # max-early-data: 2048  # Early Data 字节数，服务端支持时再启用
  # early-data-header-name: Sec-WebSocket-Protocol  # 与上面的 Early Data 配套
  # v2ray-http-upgrade: false  # true / false，按服务端传输配置选择

# 可选 TLS 与出站设置
# client-fingerprint: chrome  # 常用备选：chrome / firefox / safari / ios / random
# skip-cert-verify: false  # false 校验证书；true 跳过校验
# packet-encoding: xudp  # xudp / packetaddr；省略为原始 UDP 编码
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'vless-xhttp',
    type: 'vless',
    label: 'VLESS · XHTTP + TLS',
    note: 'XHTTP 的路径和模式需与服务端兼容；更多传输参数可直接在 YAML 中补充。',
    yaml: `# VLESS + XHTTP + TLS；填写服务端提供的参数
name: 我的 VLESS XHTTP 节点  # 自定义且不重复的名称
type: vless
server: node.example.com  # 服务器域名或 IP
port: 443  # 服务端端口
uuid: ${uuid}  # 用户 UUID
tls: true  # true / false；本例使用 TLS
servername: node.example.com  # TLS 证书域名 / SNI
client-fingerprint: chrome  # 常用备选：chrome / firefox / safari / ios / random
network: xhttp  # 本例使用 xhttp，其他传输需更换对应 *-opts
xhttp-opts:
  path: /xhttp  # 与服务端路径一致
  mode: auto  # 备选：auto / stream-one / stream-up / packet-up
  # host: node.example.com  # 自定义 HTTP 主机名
  # headers:
  #   X-Custom-Header: "自定义请求头的值"
  # no-grpc-header: false  # true / false，是否不添加 gRPC 请求头
  # x-padding-bytes: "100-1000"  # 额外填充字节数，支持固定值或范围

# 可选设置
# udp: true  # true 允许 UDP / false 禁用 UDP
# packet-encoding: xudp  # xudp / packetaddr；省略为原始 UDP 编码
# skip-cert-verify: false  # false 校验证书；true 跳过校验
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'ss',
    type: 'ss',
    label: 'Shadowsocks',
    note: 'cipher 和密码必须与服务端一致。SS 2022 需使用对应长度的 Base64 密钥。',
    yaml: `# Shadowsocks；加密方式和密码必须与服务端一致
name: 我的 Shadowsocks 节点  # 自定义且不重复的名称
type: ss
server: node.example.com  # 服务器域名或 IP
port: 8388  # 服务端端口
# 常用 AEAD：chacha20-ietf-poly1305 / aes-128-gcm / aes-256-gcm
# SS 2022：2022-blake3-aes-128-gcm / 2022-blake3-aes-256-gcm / 2022-blake3-chacha20-poly1305
cipher: chacha20-ietf-poly1305
password: "替换为节点密码"  # SS 2022 使用对应长度的 Base64 密钥
udp: true  # true 允许 UDP / false 禁用 UDP

# 可选：仅服务端配置了插件时启用；不同插件的 plugin-opts 不通用
# 常见插件：obfs / v2ray-plugin / shadow-tls / restls
# 下方是 obfs 示例；整块去掉 # 后使用
# plugin: obfs
# plugin-opts:
#   mode: tls  # 备选：tls / http
#   host: www.example.com  # 服务端使用的混淆域名

# udp-over-tcp: false  # true / false；启用前确认服务端支持 UoT
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'vmess',
    type: 'vmess',
    label: 'VMess · WebSocket + TLS',
    note: '此例使用 WebSocket。纯 TCP 节点改用 network: tcp，并移除 ws-opts。',
    yaml: `# VMess + WebSocket + TLS；填写服务端提供的参数
name: 我的 VMess 节点  # 自定义且不重复的名称
type: vmess
server: node.example.com  # 服务器或 CDN 地址
port: 443  # 服务端端口
uuid: ${uuid}  # 用户 UUID
alterId: 0  # 0 使用 AEAD；非 0 为旧协议，按服务端填写
cipher: auto  # 备选：auto / aes-128-gcm / chacha20-poly1305 / none / zero
tls: true  # true 使用 TLS / false 不使用，须与服务端一致
servername: node.example.com  # TLS 证书域名 / SNI
network: ws  # 备选：tcp / ws / http / h2 / grpc / mkcp / mekya
# 改为 tcp 时删除 ws-opts；其他传输需填写对应 *-opts
udp: true  # true 允许 UDP / false 禁用 UDP
ws-opts:
  path: /vmess  # 服务端 WebSocket 路径
  headers:
    Host: node.example.com  # HTTP Host

# 可选设置
# client-fingerprint: chrome  # 常用备选：chrome / firefox / safari / ios / random
# skip-cert-verify: false  # false 校验证书；true 跳过校验
# packet-encoding: xudp  # xudp / packetaddr；省略为原始 UDP 编码
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'trojan',
    type: 'trojan',
    label: 'Trojan',
    note: 'SNI 使用服务端证书对应的域名，默认保留证书校验。',
    yaml: `# Trojan；默认使用 TCP + TLS
name: 我的 Trojan 节点  # 自定义且不重复的名称
type: trojan
server: node.example.com  # 服务器域名或 IP
port: 443  # 服务端端口
password: "替换为节点密码"  # 与服务端认证密码一致
sni: node.example.com  # 服务端证书域名
udp: true  # true 允许 UDP / false 禁用 UDP
# client-fingerprint: chrome  # 常用备选：chrome / firefox / safari / ios / random
# skip-cert-verify: false  # false 校验证书；true 跳过校验
# alpn: [h2, http/1.1]  # TLS 协商协议列表，按服务端要求填写

# 可选传输：省略 network 使用 TCP；也支持 ws / grpc
# WebSocket 示例：需要时整块去掉 #
# network: ws
# ws-opts:
#   path: /trojan  # 与服务端路径一致
#   headers:
#     Host: node.example.com
# gRPC 方案：删除上面的 network/ws-opts，再启用下方两项
# network: grpc
# grpc-opts:
#   grpc-service-name: trojan  # 与服务端服务名称一致

# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'hysteria2',
    type: 'hysteria2',
    label: 'Hysteria2',
    note: '端口使用 UDP。混淆参数仅在服务端启用时添加。',
    yaml: `# Hysteria2；底层使用 QUIC / UDP
name: 我的 Hysteria2 节点  # 自定义且不重复的名称
type: hysteria2
server: node.example.com  # 服务器域名或 IP
port: 443  # 服务端 UDP 端口；配置 ports 后也要保留
password: "替换为认证密码"  # 按服务端认证配置填写
sni: node.example.com  # TLS 证书域名
# skip-cert-verify: false  # false 校验证书；true 跳过校验
# alpn: [h3]  # 可选，必须与服务端兼容

# 可选带宽：up/down 均省略或为 0 时使用 BBR
# up: "100 Mbps"  # 上行带宽；不写单位时为 Mbps
# down: "500 Mbps"  # 下行带宽，按实际网络设置
# bbr-profile: standard  # 使用 BBR 时可选 standard / conservative / aggressive

# 可选混淆：未启用时整块保留为注释
# obfs: salamander  # 备选：salamander / gecko，须与服务端一致
# obfs-password: "替换为混淆密码"
# obfs-min-packet-size: 512  # 仅 gecko，最小包大小，字节
# obfs-max-packet-size: 1200  # 仅 gecko，最大包大小，字节

# 可选端口跳跃：需要服务端支持
# ports: "20000-30000"  # 支持单端口、逗号列表或范围，如 "443,20000-30000"
# hop-interval: "15-30"  # 单位秒；支持固定值或一个范围
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'tuic',
    type: 'tuic',
    label: 'TUIC · v5',
    note: '此例使用 UUID 和密码认证；ALPN 与服务端保持一致。',
    yaml: `# TUIC v5；UUID 和密码必须同时填写
name: 我的 TUIC 节点  # 自定义且不重复的名称
type: tuic
server: node.example.com  # 服务器域名或 IP
port: 443  # 服务端 UDP 端口
uuid: ${uuid}  # v5 用户 UUID
password: "替换为节点密码"  # v5 用户密码
# 使用 v4 时删除 uuid/password，并改用 token；不要同时启用两套认证
# token: "替换为 TUIC v4 Token"
sni: node.example.com  # TLS 证书域名
alpn: [h3]  # 与服务端约定的 ALPN 列表
congestion-controller: bbr  # 备选：cubic / new_reno / bbr
udp-relay-mode: native  # 备选：native / quic；按服务端能力选择

# 可选设置：去掉行首 # 后生效
# bbr-profile: standard  # 使用 bbr 时可选 standard / conservative / aggressive
# heartbeat-interval: 10000  # 心跳间隔，毫秒
# request-timeout: 8000  # 建立代理连接的超时，毫秒
# reduce-rtt: false  # true / false；启用 0-RTT，需考虑重放风险
# disable-sni: false  # true 不发送 SNI / false 发送
# skip-cert-verify: false  # false 校验证书；true 跳过校验
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'anytls',
    type: 'anytls',
    label: 'AnyTLS',
    note: '使用 TLS 和密码认证，不需要填写 UUID。',
    yaml: `# AnyTLS；使用密码认证，无需 UUID
name: 我的 AnyTLS 节点  # 自定义且不重复的名称
type: anytls
server: node.example.com  # 服务器域名或 IP
port: 443  # 服务端端口
password: "替换为节点密码"  # 与服务端认证密码一致
sni: node.example.com  # TLS 证书域名
udp: true  # true 允许 UDP / false 禁用 UDP
# client-fingerprint: chrome  # 常用备选：chrome / firefox / safari / ios / random
# skip-cert-verify: false  # false 校验证书；true 跳过校验
# alpn: [h2, http/1.1]  # 可选，按服务端要求设置协议列表

# 可选会话管理：数值按实际需要填写
# idle-session-check-interval: 30  # 检查空闲会话的间隔，秒
# idle-session-timeout: 30  # 空闲会话超时，秒
# min-idle-session: 0  # 最少保留的空闲会话数，非负整数
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'socks5',
    type: 'socks5',
    label: 'SOCKS5',
    note: '用户名和密码可按需填写；UDP 转发还需要服务端支持。',
    yaml: `# SOCKS5；按服务端要求选择是否认证
name: 我的 SOCKS5 节点  # 自定义且不重复的名称
type: socks5
server: node.example.com  # 服务器域名或 IP
port: 1080  # 服务端端口
username: "替换为用户名"  # 无认证服务端：删除 username 和 password 两行
password: "替换为密码"
udp: true  # true / false；开启 UDP 还需要服务端支持 UDP ASSOCIATE

# 可选 SOCKS over TLS：普通 SOCKS5 不要开启
# tls: false  # true 使用 TLS / false 不使用，须与服务端一致
# skip-cert-verify: false  # 使用 TLS 时：false 校验证书 / true 跳过
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
# dialer-proxy: 前置代理名称  # 已有节点或代理组，不可引用自己
`,
  },
  {
    id: 'http',
    type: 'http',
    label: 'HTTP / HTTPS 代理',
    note: 'HTTPS 代理设置 tls: true，普通 HTTP 代理使用 false。',
    yaml: `# HTTP / HTTPS 代理；tls 控制到代理服务器的连接是否加密
name: 我的 HTTP 代理  # 自定义且不重复的名称
type: http
server: node.example.com  # 服务器域名或 IP
port: 8080  # 普通 HTTP 常用 8080；HTTPS 常用 443，以服务端为准
tls: false  # false = HTTP 代理 / true = HTTPS 代理
# sni: node.example.com  # 仅 TLS：服务器证书域名
# skip-cert-verify: false  # 仅 TLS：false 校验证书 / true 跳过

# 可选认证：服务端要求认证时同时启用两行
# username: "替换为用户名"
# password: "替换为密码"
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
# dialer-proxy: 前置代理名称  # 已有节点或代理组，不可引用自己
`,
  },
  {
    id: 'wireguard',
    type: 'wireguard',
    label: 'WireGuard',
    note: '隧道地址、私钥、公钥和目标网段按服务端配置填写。',
    yaml: `# WireGuard peers 模式；隧道地址和密钥按服务端配置填写
name: 我的 WireGuard 节点  # 自定义且不重复的名称
type: wireguard
ip: 10.0.0.2  # 客户端隧道 IPv4 地址，不带 /32
# ipv6: "fd00::2"  # 可选：客户端隧道 IPv6 地址，不带前缀长度
private-key: "替换为客户端 Base64 私钥"  # 客户端私钥，仅填写在顶层
peers:
  - server: node.example.com  # 对端服务器域名或 IP
    port: 51820  # 对端 UDP 端口
    public-key: "替换为服务端 Base64 公钥"  # 对端公钥
    # pre-shared-key: "替换为 Base64 预共享密钥"  # 仅服务端配置了 PSK 时启用
    allowed-ips: [0.0.0.0/0]  # 必填 CIDR 列表；双栈可填 [0.0.0.0/0, "::/0"]
    # reserved: [0, 0, 0]  # 按服务端要求填写 3 个字节，每项 0–255
# 使用 peers 后，不要再在顶层填写 server/port/public-key
udp: true  # true 允许转发 UDP / false 禁用 UDP；WireGuard 隧道本身仍走 UDP
# mtu: 1420  # 隧道 MTU，字节；按网络环境调整
# persistent-keepalive: 25  # 保活间隔，秒；0 关闭
# remote-dns-resolve: true  # true 经隧道解析 DNS / false 不启用
# dns: [1.1.1.1, 8.8.8.8]  # 与 remote-dns-resolve: true 配套
`,
  },
  {
    id: 'snell',
    type: 'snell',
    label: 'Snell',
    note: '协议版本和预共享密钥与服务端一致。',
    yaml: `# Snell；版本、密钥及混淆设置必须与服务端一致
name: 我的 Snell 节点  # 自定义且不重复的名称
type: snell
server: node.example.com  # 服务器域名或 IP
port: 44046  # 服务端端口
psk: "替换为预共享密钥"  # 服务端 PSK
version: 4  # 备选：1 / 2 / 3 / 4 / 5，按服务端版本选择
udp: true  # true / false；只有 v3/v4/v5 支持 UDP
# reuse: false  # true / false；仅 v4/v5 支持

# 可选混淆：下方为 HTTP/TLS 混淆，服务端未配置时不要启用
# obfs-opts:
#   mode: http  # 此配置块可选 http / tls
#   host: www.example.com  # 服务端使用的混淆域名
# 另支持 shadow-tls / restls / jls；需额外认证等配套字段，参阅协议文档
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'ssh',
    type: 'ssh',
    label: 'SSH',
    note: '使用 SSH 服务建立代理连接。密钥认证可直接补充 private-key 等原生字段。',
    yaml: `# SSH；本例使用密码认证，可改为下方的私钥方案
name: 我的 SSH 节点  # 自定义且不重复的名称
type: ssh
server: node.example.com  # SSH 服务器域名或 IP
port: 22  # SSH 端口，按服务端配置填写
username: "替换为 SSH 用户名"  # 服务端账户
password: "替换为 SSH 密码"  # 密码认证；改用私钥时删除此行

# 备选认证：私钥内容或文件路径，两种写法选一种
# private-key: /path/to/id_ed25519  # 路径位于运行 Mihomo 的设备上
# 内嵌私钥写法：整块去掉 #，保留每行缩进
# private-key: |
#   -----BEGIN OPENSSH PRIVATE KEY-----
#   替换为私钥内容
#   -----END OPENSSH PRIVATE KEY-----
# private-key-passphrase: "替换为私钥口令"  # 仅私钥已加密时填写

# 可选：核对服务端主机公钥后填写；省略 host-key 会接受所有主机密钥
# host-key:
#   - "ssh-ed25519 替换为已核对的主机公钥"
# host-key-algorithms: [ssh-ed25519]  # 常用备选：ssh-ed25519 / rsa-sha2-256 / rsa-sha2-512
# ip-version: dual  # dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
`,
  },
  {
    id: 'direct',
    type: 'direct',
    label: 'Direct · 指定出口',
    note: '直连出站没有服务器地址；可以按需指定出口网卡。',
    yaml: `# Direct：自定义直连出站，无需 server、port 和认证信息
name: 指定出口直连  # 自定义且不重复的名称
type: direct  # 直连类型

# 可选出站设置：需要哪一项就去掉对应行首的 #
# interface-name: eth0  # 运行 Mihomo 的设备上的出口网卡名称
# ip-version: dual  # 备选：dual / ipv4 / ipv6 / ipv4-prefer / ipv6-prefer
# dual 使用双栈；ipv4/ipv6 仅使用指定地址族；*-prefer 优先指定地址族
# tfo: false  # true / false；TCP Fast Open，需要系统支持
# mptcp: false  # true / false；多路径 TCP，需要系统与网络支持
# dialer-proxy: 前置代理名称  # 经已有节点或代理组建立连接；不可引用自己
`,
  },
]
