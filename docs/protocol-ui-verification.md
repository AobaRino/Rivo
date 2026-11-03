# 协议编辑与摘要验证

日期：2026-10-22。页面：本地 Vite 开发页面。未启动或接入真实 Mihomo；测试输入仅为示例数据。

## 自动检查

- 前端 94 项测试通过（7 个文件），含 28 种出站类型的 Schema 表单渲染、嵌套字段、未知字段、无操作保留、锚点保护、原生端口与 DNS 值、引用循环和块级行数。
- Go 测试通过。生产构建通过；协议 Schema 与表单代码按需加载，包含完整 Schema 的共享块约 730 KB、gzip 156 KB，构建报告体积提示。
- 内核解析器类型/顶层字段审计：28 种类型，无缺失类型；补充两个独立字段覆盖后无缺失顶层标签。结果见 [JSON](protocol-schema-audit.json)。此审计不覆盖所有嵌套字段组合与实网行为。

## 页面操作

| 操作 | 结果 |
| --- | --- |
| 新建 direct | 只写 name/type，不强制服务器或端口，不补 udp/tls 等默认值 |
| 新建 AnyTLS | 表单输入的地址、数字端口、密码进入节点 YAML；密码使用遮挡输入 |
| 节点改名 | dialer-proxy 随引用目标改名更新 |
| WireGuard 多 Peer | 表单增加 peers、server、port、public-key、allowed-ips 和 ip；YAML 对应，重新编辑 Peer 端口成功 |
| VLESS + Reality + XHTTP | 原有 Reality、UUID 等保持，network 修改与 xhttp-opts/path/headers 写入草稿 |
| 任意请求头 | 连续新增两个键、改键名和改值，节点 YAML 均对应 |
| DNS 更多字段 | 修改 listen 并增加 prefer-h3，保留原有 nameserver 和其他字段 |
| 保存摘要 | 单列显示 DNS +2/−1、节点 +16/−1，分别对应 DNS 一行替换加一行新增，以及节点一行替换、XHTTP 五行新增、WireGuard 十行新增 |
| 取消预览 | 未保存修改仍在，可继续编辑 |
| 删除测试节点 | 从草稿删除成功 |
| 放弃修改 | 恢复上次保存内容，4 个原有节点，保存按钮恢复禁用 |
| 无操作编辑 | 打开原有 Reality 节点直接更新草稿，保存按钮仍禁用，未补默认字段 |

实测过程中修复了密码事件漏记、嵌套控件读旧值、条件对象重复呈现、可选条件误标必填、数组空项显示和字典键名不可编辑的问题，并增加了对应的静态/结构回归检查。

本轮没有点击确认保存测试数据；保存 API 的持久化与修订冲突仍由现有 Go 测试覆盖。页面/配置/API 不代表全部协议握手或路由器网络功能已通过。

## 清理与重启核对

- 所有未保存测试内容已在页面上放弃，测试节点不存在。
- `.local/state.json` 与测试前备份的 SHA-256 一致：`FB64AFA53855DF9AB69DE3B649F1151E2B02F4B5537ECA1A1C88D9337BAEA2B6`。
- 原有 20 条修订记录未变。
- 开发服务重启后，模拟运行的 mode/logLevel/running/selected 与重启前完全一致。
- 页面 HTTP 200；新 API 接受 `mixed-port: 0`、`dns.enhanced-mode: normal` 和无服务器端口的 direct 节点，继续明确返回 `coreValidated: false`。
- 本轮未连接远程 Docker 主机，未操作任何现有容器或电脑网络设置。

截图保存在忽略目录 `.local/protocol-review/save-summary.png`。
