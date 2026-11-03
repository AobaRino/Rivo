# 路由器适配前复查 — 2026-10-27

当前代码可以进入路由器平台适配阶段。配置编辑、原生内核校验、显式代理应用、内核与 Schema 更新回退已经复测；透明接管、DNS 接管、procd 管理和独立网络回滚仍需实现及单独验证。本次没有向路由器安装程序，也没有修改其网络和服务。

## 实际目标设备

通过 SSH 只读检查得到：

| 项目 | 结果 |
| --- | --- |
| 固件 | ImmortalWrt 25.12.0，r37854-4b24da3b4c5c |
| 平台 | x86/64、x86_64，QEMU Q35，Intel i3-1215U |
| Linux | 6.12.87 |
| 软件包 | APK；没有 opkg |
| 防火墙 | firewall4 + nftables，已有 `inet fw4` |
| 服务管理 | procd、ubus、rpcd、uhttpd；cgroup v2 已挂载 |
| 内存、磁盘 | 内存约 1.9 GiB，可用约 1.56 GiB；ext4 根分区约 31.9 GiB，可用约 31.7 GiB；无 swap |
| 现有代理 | Daed 1.27.0-r1 已启用并运行；检查结束 PID 仍为 23783 |
| DNS | dnsmasq-full 2.91-r3 已占用 53 端口 |
| 其他网络功能 | WireGuard UDP 51820，IPsec UDP 500/4500，IPv4/IPv6 均有策略规则指向表 220 |

`command -v tc` 能找到 `/sbin/tc`，实际执行却返回 `applet not found`。平台探测必须执行必要命令验证能力，不能仅凭文件存在判断。Daed 的 eBPF 挂载详情本次未能通过 tc 核实，因此不能从 nft 规则推断没有代理接管。

只读原始证据保存在本地忽略目录 `.local/router-review-20261027.json`、`router-services-20261027.json` 和 `router-packages-20261027.json`。没有将登录口令写入项目文件。

## 本次修复

| 问题 | 影响与修复 |
| --- | --- |
| P1：后台轮询覆盖编辑器保存版本 | 页面 A 保留旧文本，后台却接收页面 B 的新 revision，原来可能用新 If-Match 覆盖 B。现在轮询只更新运行状态，草稿、revision、保存时间保留为编辑基线；检测其他页面保存后提示主动载入，旧版本保存返回 409。 |
| P1：升级失败可能污染旧资源 | 原来的内核版本切换共用资源目录。现在升级和回退都使用候选配置及资源副本，通过检查后一起提交指针；失败恢复原目录，清理候选副本。 |
| P1：同一目录可能启动两个管理器 | Linux 使用持有至退出的 flock 锁，第二实例拒绝启动；不删除锁文件 inode，避免锁失效。 |
| P2：运行中的 cache.db 被直接复制 | 先暂存资源；旧内核停止后再次复制 cache.db，以关闭后的数据作为候选缓存。文件需为普通文件，受大小限制，使用临时文件及 fsync 后替换。 |
| P2：provider 路径检查不一致 | 使用 Linux 路径语义检查目标路径；拒绝绝对路径、越界路径、管理器保留文件，以及 proxy/rule provider 规范化后使用相同缓存文件。缺省路径保留缺省。 |
| P2：内核运行与订阅可用混淆 | 新增只读订阅状态接口，读取内核报告的节点数、更新时间，区分 loaded / empty / missing；不返回订阅链接、认证信息或节点明细。加载成功不代表连通性测试通过。 |
| P2：频繁轮询全部历史 | 新增 `/api/status`，不包含 YAML 和历史，仅在内核操作或已应用版本变化时取完整状态。 |
| P2：订阅表单补写间隔 | 省略的 interval 不再自动变成 3600；清空会删除字段，其他配置和注释保留。 |
| 开发依赖漏洞 | Vitest 升级到 4.1.12，修复其 mocker 依赖公告中的问题，npm audit 复查为 0 项。 |

主要实现见 `web/src/lib/workspaceSync.ts`、`web/src/App.tsx`、`cmd/manager/core_lock_linux.go`、`core_config.go`、`core_manager.go`、`core_providers.go` 和 `web/src/components/ProviderStatus.tsx`。

## 验证范围

- TypeScript 检查、生产构建通过；前端 105 项测试通过。
- Go 全套测试在正常 Windows 用户环境和独立 Linux 容器通过；Linux go vet 通过。Windows 沙箱临时目录曾阻止原子重命名，使用正常用户临时目录复测通过。
- Linux amd64 和 arm64 交叉构建通过；本次仅实际运行 amd64。
- 在之前的 Docker 测试机创建全新 `mm-sandbox-router-review-20261027` 环境，共 44 条自动化检查记录通过，含环境和原容器核对。
- 使用未修改的官方 Mihomo v1.19.31、v1.19.32、v1.19.33 和精确 Schema 包缓存。隔离 TLS 源站重现发布下载及损坏场景；v1.19.33 Schema 未发布场景由固定测试响应模拟，不代表当前 npm 发布状态。
- 复测更新、回退、Schema 同步及缺失降级、包损坏、候选二进制变动、并发与陈旧请求、服务重启和升级中断恢复。
- 复测保存与应用分离、注释与未知字段保留、真实 `mihomo -t` 拒绝、端口占用、候选进程崩溃、应用中断恢复、订阅与自建节点共存，以及真实显式 HTTP 代理转发到受控源站。
- 新增故障注入：修改候选资源文件后杀死候选内核，确认恢复后旧资源内容未变，候选目录被清理。
- 新增第二管理实例拒绝启动、轻量轮询不含配置、订阅 1 节点与零节点状态及信息最小化检查。
- 真实页面验证两页面保存冲突、保留本页修改、取消载入、确认载入、取消预览、放弃修改、确认保存、订阅间隔缺省/增加/删除的摘要与 YAML 对应、真实应用及 provider 状态。

测试容器使用非 root、只读根文件系统、全部 capability 移除、no-new-privileges、资源上限和 internal 网络；不映射宿主端口、不挂载 Docker socket，不访问现有业务目录。浏览器使用临时回环 SSH 转发连接本次测试容器。全程使用受控订阅，不复用私人订阅令牌。

清理已完成：本次 3 个容器、internal 网络、测试镜像和远端测试目录均已删除，临时浏览器页与 SSH 转发已关闭。原有 12 个容器的 ID、启动时间、重启次数、状态、镜像、端口和网络没有变化，原有卷未变，宿主路由与基线完全一致。本地 `.local/state.json` SHA256 保持 `fb64afa53855df9ab69de3b649f1151e2b02f4b5537eca1a1c88d9337baea2b6`。结果和截图保存在 `.local/review-router-20261027/`。

这些测试不证明所有协议组合、公网出口、OpenWrt 服务重载、真实透明转发、IPv6、掉电或路由器失联恢复已经可用。

## 首版架构和实施顺序

### 1. 先做安装和服务，不接管流量

首个支持范围固定为 **ImmortalWrt 25.12 / x86_64 / APK / fw4**。通过相同 SDK 构建 APK 包，验证升级、保留配置、卸载和开机服务；后续再扩展其他平台。

- 路由器运行静态 Go 程序和预构建前端，不安装 Node 或 Vite。补齐安装后的绝对路径和静态资源服务。
- LuCI 提供入口，管理 API 通过认证网关和最小 rpcd ACL 访问；每次操作验证会话及 CSRF，敏感响应禁止缓存。不得直接把当前无鉴权 Go API 改为监听 LAN。
- 管理服务使用普通账号。特权 agent 通过受权限保护的 Unix socket 接收固定结构的有限操作，校验调用者和参数；没有任意命令执行接口。
- 将当前 Go 直接启动子进程的实现抽为 Runtime 接口。路由器由 **procd 唯一负责 Mihomo 生命周期**，Go 管理器调用 agent 请求服务变更，避免两个 supervisor 争抢进程。现有 Docker 模式继续使用直接进程适配器。
- Mihomo 控制接口和 secret 保持回环访问，浏览器通过管理 API 查询。
- 默认只提供编辑、校验、内核管理和显式代理；安装不会停 Daed、改 DNS 或添加网络接管规则。

### 2. 网络操作单独做事务

agent 独立持久化网络事务，watchdog 不能依赖管理页面或管理服务存活。状态至少包括 preparing、pending-confirmation、committed、rolling-back。

准备阶段记录本工具拥有的服务、DNS、nft、路由和规则状态；检查端口、接口、包能力、磁盘空间、内核 `-t` 和 `nft -c`。下载、解压和资源副本均先检查可用空间与内存，不在小内存机器上重复无界读入发布包。

应用阶段先验证内核，再改变自己拥有的规则与 DNS；检查管理地址仍可达，以及真实 LAN 客户端的 DNS/TCP/UDP 出口。进入限时确认窗口，浏览器重新连通并确认后提交。超时、agent/manager 崩溃、核心服务退出或重启发现未提交事务时，独立 watchdog 恢复旧状态；恢复失败需明确显示并保留诊断。

首次接管失败应恢复接管前网络；撤销本工具规则时不得全局 flush nft、清空路由表或改动其他服务。回滚不是只恢复 YAML，也必须恢复 DNS、防火墙、策略路由及服务状态。磁盘写满、fsync/rename 失败、重启和掉电要在路由器 VM 中注入测试，不能把当前进程恢复测试当成掉电证明。

### 3. 透明代理和现有服务的边界

- **Daed 冲突为硬阻止条件。** 明确迁移流程之前不允许双重接管，也不在安装或启动时自动停止 Daed。
- fw4 使用明确归属的表、链、集合及 include 生命周期。为 marks 和路由表分配独立范围并检查冲突，保留已有表 220、WireGuard、IPsec、管理网段和直连路由。
- 接管规则必须绕过 Mihomo 自身出口（cgroup/UID/mark）和管理/下载流量；同时验证 TCP、UDP、QUIC、域名 A/AAAA 变化以及重启后的标识。禁止让内核自动路由与 agent 的规则同时争夺所有权。
- 订阅、规则集和 GEO 的首次下载不能依赖尚未建立的代理链。保留用户选择的 provider 下载代理，默认接管策略要保证引导 DNS 和下载路径可用。
- 保留 dnsmasq 作为 53 端口入口。Mihomo DNS 使用独立内部端口，按范围转发或劫持；保留 DHCP、局域网域名、静态租约与 IPv6 行为，提供不经过自身代理的引导解析。
- LAN 客户端、路由器自身、IPv4、IPv6 分别显式启用并验证。首版先实现 IPv4；IPv6 未通过测试前禁止启用接管，不能静默降级造成泄漏。

配置原文仍是 Mihomo 的唯一配置来源。UCI 仅保存路由器级开关、接口范围和接入策略，不复制一套节点/DNS/规则模型。平台必须控制的字段要在预览中显示最终值及原因，不能在用户确认后偷偷覆盖 YAML。

### 4. 上线前验收门槛

先在隔离 OpenWrt/ImmortalWrt VM 验证 APK 安装、procd、fw4 reload、接口 hotplug、DNS、TCP/UDP/IPv6、网络回滚、服务崩溃和重启。通过后才在真实路由器进行显式代理测试；最后安排 Daed 迁移与透明接管，预留独立管理入口及可执行恢复命令。

现有机器是 QEMU 环境，正式迁移前可利用虚拟机快照作为额外恢复手段，但快照不能代替产品自身的超时回退。

## 借鉴的上游实现

本次只审阅并借鉴边界和生命周期，未复制插件源码。

| 来源 | 本项目采用的设计参考 |
| --- | --- |
| [Nikki 服务脚本](https://github.com/nikkinikki-org/OpenWrt-nikki/blob/78e1a751d55ed0762811f054ee699049473da7b8/nikki/files/nikki.init) | procd 服务、资源限制、cgroup 以及服务和网络生命周期 |
| [Nikki 网络接管](https://github.com/nikkinikki-org/OpenWrt-nikki/blob/78e1a751d55ed0762811f054ee699049473da7b8/nikki/files/ucode/hijack.ut) | IPv4/IPv6、LAN/本机、DNS/代理分别控制，出口旁路及规则归属 |
| [Nikki 软件包定义](https://github.com/nikkinikki-org/OpenWrt-nikki/blob/78e1a751d55ed0762811f054ee699049473da7b8/nikki/Makefile) | OpenWrt 包依赖与安装布局；需按实际固件 SDK 重新验证 APK 产物 |
| [OpenClash watchdog](https://github.com/vernesong/OpenClash/blob/e553e82e01c697aefbe1555261a503f425e00ccd/luci-app-openclash/root/usr/share/openclash/openclash_watchdog.sh) | 节点及 provider 出口地址旁路、运行检查、规则维护；避免照搬全局环境假设 |
| [Vitest 安全修复](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)、[Windows 路径修复](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp) | 将开发测试依赖更新到 4.1.12 |

实际移植源码前按 [来源与许可证](../THIRD_PARTY_NOTICES.md) 核对文件许可证和分发义务；设计参考不等于可以把 GPL 实现无条件复制为其他许可代码。
