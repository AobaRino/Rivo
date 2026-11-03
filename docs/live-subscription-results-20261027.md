# 真实订阅与自建 Hysteria2 验证（2026-10-27）

使用用户授权的测试主机，新建三个专属 Docker 容器，在 Mihomo v1.19.32 上通过管理器真实保存并应用配置。没有修改原有容器或 Windows 的代理设置。

## 结果

| 对象 | 加载 | HTTPS 连接检查 |
| --- | --- | --- |
| 订阅 Shadowsocks | 33 / 33 | 30 成功，3 未通过 |
| 订阅 AnyTLS | 70 / 70 | 66 成功，4 未通过 |
| 自建 Hysteria2 | 1 / 1 | 多次超时 |

订阅原文为 Base64 编码的 URI 列表，直接交给 Mihomo 原生 HTTP provider，未使用第三方转换服务。订阅 103 项与自建节点共同出现在同一 select 组中，共 104 项。管理器重启后，provider 仍加载 103 项，代理组仍有 104 项。原生 provider 手动刷新返回 204，最后一次重新下载返回 200，内容仍有效；本次测试不需要续期。

连接检查使用 Google 的 HTTPS `generate_204`，并发 4，首轮超时 6 秒；失败项以并发 2、12 秒超时复查。成功结果分别为 Shadowsocks 259–2660 ms、AnyTLS 710–4856 ms，这是包含连接建立的探测耗时，不是带宽测试。

分别选择一个通过检查的 Shadowsocks、AnyTLS 节点，再通过核心 mixed-port 建立真实 HTTPS CONNECT 访问 Cloudflare：两者均返回 HTTP 200、TLS 1.3，出口地区 HK。直连控制请求也正常返回。这些结果证明实际代理请求成功，不能保证所有网站或节点长期可用。

## 未通过的订阅项

未通过的节点为 3 个 Shadowsocks 节点和 4 个 AnyTLS 节点，其中 2 个 AnyTLS 节点标注为 IPv6。公开记录不包含订阅节点名称、服务器地址或认证参数。

测试主机没有 IPv6 默认路由，独立 Docker 网络也未启用 IPv6。因此不能据本次结果判断标注 v6 的两项在具备 IPv6 出口时是否可用。其余失败项也仅代表从本次测试路径未通过，不等于已经证明服务端失效。

## Hysteria2

按分享链接填写服务器、443 端口、密码和 SNI；`insecure=0` 映射为 `skip-cert-verify: false`，没有关闭证书校验。配置通过真实内核校验并加载。

多次原生延迟检查和一次实际代理 HTTPS 请求均失败，核心日志为 `context deadline exceeded`。容器内解析得到真实 IPv4，未命中 fake-IP 网段；目标 TCP 443 可建立连接，独立 UDP DNS 控制请求有响应。这些控制检查不能证明目标 UDP 443 或 QUIC 链路可用，尚不能区分服务端监听、防火墙与中间网络路径原因。

## 对管理器的发现

1. 本次配置以 `MATCH,LiveMixed` 为兜底，未指定 provider 的下载代理时，订阅请求也走了当前 HY2，因 HY2 超时导致下载失败。在 provider 中显式填写 `proxy: DIRECT` 后，原生下载和刷新成功。应保留可配置的下载代理，并在界面明确说明；不能普遍假设直连适用于所有订阅。
2. 当前“应用成功”表示配置校验、内核运行及监听检查通过，不包含远程 provider 的可用性。首次应用时曾出现内核运行正常但 provider 为 0 项。需要另行展示 provider 下载状态、节点数量、更新时间和错误，避免把内核启动成功解释为订阅已就绪。是否把首次必需 provider 加载失败作为事务回退条件，应与已有缓存可继续使用等情况区分。
3. provider 内节点的单项检查使用 `/providers/proxies/{provider}/{name}/healthcheck`；自建节点使用 `/proxies/{name}/delay`。测试脚本首次使用了错误端点，返回的 404 已排除；上述 96 / 103 结果来自纠正后的完整重测。

原生行为参考：[provider 配置](https://wiki.metacubex.one/config/proxy-providers/)、[支持的订阅内容格式](https://wiki.metacubex.one/config/proxy-providers/content/)、[v1.19.32 provider API 实现](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/hub/route/provider.go)、[Hysteria2 配置](https://wiki.metacubex.one/config/proxies/hysteria2/)。

## 隔离与清理

容器使用独立 bridge 网络以访问授权的公网节点，非 root、只读根目录、移除 capabilities、禁止提权，并限制资源。不发布宿主机端口，不挂载 Docker socket 或其他服务数据；未启用 TUN、透明代理或宿主机网络模式。

测试后删除本次三个容器、专属网络、测试镜像及运行数据。删除本机和远端的订阅原文、真实配置、打包文件、节点缓存等含凭据文件，仅保留脱敏汇总和测试脚本。原有 12 个容器快照无差异，原有网络和卷未变，路由恢复到测试前状态。本地工作台草稿哈希未变。

脱敏原始结果位于 `.local/subscription-test-20261027/`，包括 `connectivity-summary.json`、`traffic-summary.json`、`retry-results.json`、`final-probes.json`、`cleanup.json`。
