# Mihomo 配置编辑审查与复用记录

基准：Mihomo v1.19.32。源码、版本、许可证见 [第三方来源](../THIRD_PARTY_NOTICES.md)。

## 采用的实现

采用 MIT 的 meta-json-schema 1.19.32，复用中文字段说明、枚举、嵌套对象、传输层及条件约束。表单使用 Apache-2.0 的 react-jsonschema-form 6.11.0。没有自己维护另一份只有少数协议的表单枚举。

OpenClash 的协议分类与可选字段处理适合作为交互参考；其 UCI 转换不适合当前 YAML 原文作为唯一配置来源的设计。Nikki 的 editor/profile 与透明代理配置分离适合作为边界参考；防火墙、DNS 劫持和 mixin 没有搬入本地原型。GUI.for.Clash 提供源码编辑的退路，但其整体重序列化方案没有替代本项目的局部修改机制。

## 已落实

- 节点编辑覆盖内核解析器中的 28 种出站类型：ss、ssr、socks5、http、vmess、vless、snell、trojan、hysteria、hysteria2、wireguard、tuic、shadowquic、gost-relay、direct、dns、reject、rematch、ssh、mieru、anytls、sudoku、masque、trusttunnel、openvpn、tailscale、zerotier、easytier。
- 可选字段搜索与添加，显式移除字段；嵌套对象、数组、字典键值编辑，以及单节点 YAML 字段视图。已存在但 Schema 不认识的字段保留。未填写与 `false`、`0`、空列表分别处理。
- 内核选项结构的顶层字段审计找出了上游缺失的 SSR `udp`、MASQUE `name-cert-verify`，以独立覆盖文件补充。`node scripts/audit-schema.mjs .local/upstream/mihomo` 可重复检查 28 种类型的顶层 `proxy` 标签。
- “更多字段”复用同一引擎编辑通用、DNS、TUN、嗅探、profile、NTP、TLS、实验设置、TUIC 服务，以及已有代理组、订阅和规则集。常用页面仍提供原有简化操作。
- 修复节点统一强制 server/port 的错误；direct/dns/reject 和使用 peers 的 WireGuard 不再被错误拒绝。代理组支持六种策略，已有 include-all 组不再被常用编辑器误拦截。
- 节点或组改名同步更新已有组成员、普通规则、节点 dialer-proxy、provider 下载代理与 override.dialer-proxy、监听器 proxy；删除保护检查这些引用。检查代理组与 dialer-proxy 的混合循环。
- 所有表单编辑进入原 YAML 草稿和现有保存预览。仅改动所需范围，保留未修改的注释、未知字段、顺序、标量类型和换行。锚点、合并键、删除带注释结构等不能安全处理时要求使用完整源码。
- 保存摘要改为单列，只显示配置块与 `+新增行 / −删除行`；不再列具体实体、字段值或分栏。详细内容由 YAML 差异显示。

## 实测与限制

Schema 只负责字段定义和静态提示，不是 Mihomo 内核本身。表单为了展示可选字段会投影 Schema；原始条件约束仍用未修改的上游 Schema 校验。草稿允许暂时不完整。打开表单不等于配置已验证，也不触发网络连接。

当前的覆盖审计仅证明解析器类型与顶层选项名称覆盖；不证明所有嵌套选项组合、目标平台编译标签、握手和网络行为。Tailscale/EasyTier 等还取决于内核编译选项。没有为每种协议取得真实服务端，不能据此承诺“所有组合均已实网通过”。

现有 Go 校验器仍是有限静态校验，后续接入真实内核时，应使用同一目标版本执行 `mihomo -t`，然后在隔离环境验证实际连接；不要把 Schema 提示当作最终运行结果。原有独立 Docker 测试证明的仍是其报告列出的项目，不扩大到此次新增的全部协议。

源码视图为不常见结构、未来字段和高级逻辑规则提供完整编辑能力。复杂规则/DNS 参数中的名称引用仍需在完整源码中核对，不声称所有字符串引用都可自动改名。真实内核更新、资源下载、订阅解析、路由器部署和透明代理未接入页面。

## 升级流程

### MetaCubeX 规则预设（2026-10-28）

规则集页面可生成「国内直连、国外代理」预设，来源为 [MetaCubeX/meta-rules-dat 的 meta 分支](https://github.com/MetaCubeX/meta-rules-dat/tree/meta)，格式及引用方式参考 [Mihomo 官方 RULE-SET 配置](https://wiki.metacubex.one/example/conf/)。仅引用公开规则文件 URL，没有内置或复制其规则内容。

使用 `geosite/private.mrs`、`geoip/private.mrs`、`geosite/cn.mrs`、`geosite/geolocation-!cn.mrs` 和 `geoip/cn.mrs`。局域网、国内域名与国内 IP 直连；国外域名和 MATCH 使用用户选择的已有代理组。局域网 IP 使用 `no-resolve`，国内 IP 规则允许解析未匹配域名，避免将未知国内域名一律交给代理。国外域名在国内 IP 规则之前匹配。

5 个原生 HTTP rule-provider 默认 `interval: 86400`，下载代理也是所选代理组，缓存文件名交给 Mihomo 按 URL 生成。定时更新由内核负责，和 GEO 数据库更新分别配置；本地页面不下载规则或创建定时任务。预设仅修改 `rule-providers`、主 `rules` 和 `mode: rule`，经现有草稿、摘要、YAML 差异与确认保存流程持久化。主规则列表的替换范围在生成前展示，其他配置保留；同名不同来源和无法安全编辑的 YAML 结构会拒绝生成。

### 可选服务分组（2026-10-28）

服务分类参考 [Aethersailor 的完整配置](https://github.com/Aethersailor/Custom_OpenClash_Rules/blob/main/cfg/yaml/Custom_Clash_Full.yaml)，规则内容仍全部来自 MetaCubeX。提供游戏、办公与系统、AI、流媒体、通讯与网络、开发六类共 23 个可选分组，支持搜索、勾选常用服务和逐项选择默认出口。没有复制 Aethersailor 的规则数据或实现代码；已核对所引用的 MetaCubeX MRS 文件存在。

生成原生 `select` 代理组、HTTP MRS `rule-provider` 和 `RULE-SET` 规则。默认出口放在组的 `proxies` 首项，其余已有代理组、自建节点与订阅 `use` 保持可选。启动默认值仍可能被 Mihomo 的历史选中状态覆盖，不代表重置运行中的选择。服务规则优先于通用国内外规则；国内服务及下载例外优先直连，OneDrive、Bing、YouTube、Gemini、Apple TV+ 等具体分类优先于对应的大类。Steam 分类不能覆盖所有已安装游戏的独立服务器流量。

每个服务生成项在 YAML 中以 `x-manager-service` 标记归属，勾选状态与默认出口直接从 YAML 恢复，支持改名后再次生成。取消勾选时清理无引用的预设项，其他配置仍在引用的项保留；同名用户配置、重复归属或循环出口拒绝生成。所有变更仍经过原有配置块行数摘要、YAML 差异与确认保存，不在生成时下载、更新内核或部署路由器。

### 内核与 Schema

1. 固定目标内核标签和 Schema 提交，核对许可证。
2. 原样替换 vendored Schema，保留来源和版本记录。
3. 运行类型/顶层字段审计，核对 `overrides.json` 是否已由上游补齐。
4. 回归无操作编辑、嵌套数组/字典、条件字段、默认值、未知字段、引用、保存与放弃流程。
5. 使用目标版本内核在隔离容器中补齐语义与协议连接测试。
