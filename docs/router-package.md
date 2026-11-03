# Rivo 路由器安装包

## 0.1.0-r17：项目更名为 Rivo

Web 页面、LuCI 菜单及软件包说明统一显示为 Rivo，代理内核仍为 Mihomo。此次仅更改产品名称，不迁移运行目录或修改配置格式。

为兼容已经安装的版本，APK 包名继续使用 `mihomo-manager` 和 `luci-app-mihomo-manager`。可执行文件、procd 服务、UCI 配置、ubus 对象、服务用户、Unix socket、nft 表和 `/etc/mihomo-manager*` 数据目录也保留原标识。下文命令中的旧名称是兼容接口，不是另一个项目；已有草稿、运行配置、节点选择和登录设置无需重新导入。

LuCI 入口显示为「服务 → Rivo」。本次代码更名不包含路由器部署；安装时仍需按既有流程备份、验证签名并核对运行状态。

## 0.1.0-r16：清理失效排序记录

代理组卡片显示当前有效成员；已失效、被筛选隐藏和待确认的排序记录折叠展示。卡片与编辑弹窗均支持一键清理失效名称，只更新草稿，继续通过保存摘要、YAML 差异和确认保存。读取失败、来源不完整或与已应用配置不符时，不允许清理。

后台刷新时保持上次确认的列表和展开状态，仅暂时禁用清理按钮；刷新失败时显示待确认状态。修复 r15 实机复测发现的自动收起问题。

清理前重新读取来源，依据原始来源而非筛选后的预览判断失效；保留有效节点（包括被筛选隐藏的节点）的排序和手动成员、订阅来源。清理前后用内核同语义预览核对有效成员顺序，出现变化则拒绝。清理不调用选中节点或应用配置接口；部署核对运行中内核、当前选择与配置保持不变，后端及服务脚本一致时保留管理进程和登录会话。

## 0.1.0-r14：修复 LuCI 打开面板被拦截

LuCI 从 IP 地址或 HTTP 页面链接到 HTTPS 独立面板时，浏览器可能发送 `Sec-Fetch-Site: cross-site`。此前整个服务统一拒绝该标记，导致正常页面跳转返回 403。现在仅允许非 API 路径的顶层 GET/HEAD 文档导航；跨站 API、表单提交、iframe 和资源嵌入仍被阻止。独立登录、严格 Cookie 和 API 同源检查保持不变。响应声明 Fetch Metadata/Origin 的 `Vary`，避免缓存混用。

## 0.1.0-r13：代理组成员混排

代理组可用拖动、上下箭头或键盘混排自建与订阅节点。通过原生 `proxies` / `use` 和分段 `filter` 实现，排序记录放在同一代理组的 `x-manager-order`，接入现有块摘要和 YAML 差异。订阅更新保留已排名称的位置，未排序的新名称追加末尾；不调用节点切换接口。HTTP/file 成员从已应用内核读取名称和类型，不暴露凭据或额外下载订阅。

升级仅重启管理 Web/broker，保留现有草稿、已应用 YAML、Web 设置和当前内核。部署后核对内核 PID、当前选择和配置哈希；不自动把本地演示配置或排序应用到路由器。

## 0.1.0-r12：独立内核启停

首页启停现在通过已认证 Web API 与本机特权 broker 操作 procd 内核。停止时先停网络看护、撤销本项目规则并恢复 dnsmasq，再确认内核进程退出；Web 不停止。启动和重启只读取已应用 YAML，经过 `mihomo -t`、新进程/API、DNS 和代理检查后恢复之前启用的接管。失败恢复直连并保留配置，在首页显示具体错误。

操作异步执行并上报阶段，不因浏览器取消请求而中断；与配置应用、LuCI 总开关互斥。broker 意外重启后会处理未完成操作，撤销接管并停止内核供用户重试。LuCI 开机启动只由总服务管理，首页启停不改变它；重启路由器时仍按 LuCI 设置启动。当前仅实现这台设备的 LAN IPv4 TPROXY 适配。

## 0.1.0-r11：回包保护与界面更新

参考 Nikki `hijack.ut` 的 LAN 接管规则，在 TPROXY 前按连接方向放行回复包，并排除本机、广播、任播和组播目标。仅绑定 `br-lan` 不能区分 LAN 主动出站和端口转发的服务端回包；遗漏回包判断会使公网访问内网服务的 TCP 握手失败。现有 WAN 端口映射保持原样。

本版包含当前 React 页面的文字对比度、通用表单和弹窗布局，以及 LuCI 独立开机启动设置。首页内核启停仍只在本地模拟环境开放；路由器端按钮保持禁用，不用模拟结果代替实际服务操作。

升级时保留草稿、已应用 YAML、独立登录设置和 Web 端口。只需重启管理 Web/broker；正在工作的内核无需随界面升级重启。规则替换在自身 nft 表中原子完成。

## 0.1.0-r6：独立 Web

当前架构见 [独立 Web 说明](standalone-web.md)。管理器通过 LAN HTTPS 端口提供 React 页面和 API，独立登录；LuCI 仅保留打开面板、总开关、端口设置和初始化入口。总开关关闭内核、Web、应用任务及本项目的网络接管；端口修改只重启 Web。

`mihomo-manager` 包包含前端、Go 服务、官方 Zashboard 和系统适配；`luci-app-mihomo-manager` 仅包含入口及固定 rpcd 接口。不再安装 CGI 或嵌入式管理页面。下面 r5 及第一阶段说明属于历史记录，已被 r6 取代的鉴权和页面承载方式不再适用。内核应用校验和回退机制保留。

## 0.1.0-r5：首台路由器正式接管

在 ImmortalWrt 25.12 x86_64 上增加可选的 procd 内核、特权应用任务和独立回退监控。
编辑服务仍以非 root 用户运行；LuCI 网关在检查 rpcd 写权限后，只允许应用已保存且修订号一致的草稿。
没有向编辑服务开放任意命令或文件路径接口。此路由器版本暂未开放在线内核版本切换，固定使用已校验的 v1.19.33；内置 Schema 1.19.32 只作编辑提示，应用以真实内核校验为准。

- `configs/router-lan.yaml` 是不含凭据的配置模板。订阅仍使用原生 proxy-provider；规则使用 MetaCubeX 的原生 MRS rule-provider，每日更新。
- `/etc/mihomo-manager-runtime/active.yaml` 是已经应用的 YAML；`state.json` 保存编辑草稿。两者没有隐藏节点合并或 UCI 覆盖。
- 内核按配置哈希使用独立资源目录；候选配置不能覆盖旧配置的 provider 缓存。应用执行 `mihomo -t`，再由 procd 重启并验证 DNS、代理请求；失败恢复上一份 YAML。独立 watchdog 处理应用任务被中断的情况。
- 目前网络适配明确限定为 `br-lan` 的 IPv4 TCP/UDP。仅修改自身 nft 表 `inet mihomo_manager`、策略表/优先级 `17890`、标记位 `0x01000000`。私网、管理地址和 VPN 网段绕过；不接管路由器 OUTPUT，不启用 TUN。
- dnsmasq 继续负责 DHCP、本地域名和 53 端口，转发上游到 Mihomo `127.0.0.1:1053`。LAN 普通 DNS 请求统一重定向到 dnsmasq；应用自身 DoH 属于普通代理流量。
- 首台设备原来没有 dnsmasq 自定义 server/noresolv，软件/硬件流量卸载均为 1。`prepare` 会检查这些前提，不符合则拒绝执行。接管后禁用流量卸载，`off` 只恢复这几个已核对的选项，保留其他 UCI 配置。不要未经检查将此网络脚本用于其他拓扑。
- `prepare` 启动 240 秒独立回退；`on` 临时接管；从 LAN 验证管理、DNS、直连、代理和 UDP 后才 `commit`。`/usr/libexec/mihomo-manager-network off` 可退出接管并恢复原 DNS/卸载设置。
- 网络 watchdog 在防火墙重载后重建自己的表；内核持续不可用则退出接管，恢复原 DNS。procd 服务均有独立生命周期，不删除或改写 Daed 数据。

初次安装 APK 不会自动导入节点或接管网络：还需单独校验部署内核、配置和资源，然后显式 prepare/on/commit。卸载前先执行 `off` 并停止相应服务。下列第一阶段说明保留作旧版行为记录，r5 的范围以上述说明为准。

实现参考：[Nikki 的 LAN TPROXY 与 DNS 分工](https://github.com/nikkinikki-org/OpenWrt-nikki/blob/main/nikki/files/ucode/hijack.ut)、[Mihomo DNS 原生策略](https://wiki.metacubex.one/config/dns/)、[MetaCubeX 原生 MRS 规则集](https://github.com/MetaCubeX/meta-rules-dat)。这里采用相同的系统组件与职责划分，未复制 Nikki 的 UCI 混入配置模型。

目标为 ImmortalWrt 25.12.0、x86/64、APK。其他架构和旧版 opkg 暂未提供产物。

## 第一阶段范围（历史记录）

- `mihomo-manager`：静态 Go 二进制、初始 YAML、procd 服务与 sysupgrade 保留目录。
- `luci-app-mihomo-manager`：原 LuCI 页面、CGI 网关及 rpcd ACL。当前入口显示为「服务 → Rivo」，已改用上文 r6 的独立 Web 架构。
- 支持配置编辑、字段提示、静态校验、保存预览和修订记录。不会下载订阅、GEO 或规则集。
- 路由器入口固定为配置管理模式，不实例化托管内核；环境变量不能开启内核。应用、运行操作及更新接口在后端也被拒绝。本地开发和原有 Docker 托管内核模式继续可用。
- 此包没有 Daed、DNS、防火墙、路由、透明代理、TUN 或网络内核模块的依赖和操作。

## 第一阶段服务与权限（历史记录）

procd 运行 `/usr/bin/mihomo-manager router`，使用独立 `mihomomgr` 用户和组，异常退出最多连续重试三次。服务只监听 `/var/run/mihomo-manager/api.sock`，目录 0700、socket 0600，没有 TCP 管理端口。

从 0.1.0-r4 起，管理服务在接受请求前通过 Go 的 `AllThreadsSyscall6`，对所有线程实际设置 `PR_SET_NO_NEW_PRIVS`；设置失败则拒绝启动。路由器二进制必须使用 `CGO_ENABLED=0` 构建，不能只对某个 goroutine 所在的线程设置标记。目标固件已确认所有服务线程均为 `NoNewPrivs: 1`，permitted/effective capabilities 为空。它不是完整的进程沙箱。旧版 r3 只向 procd 声明标记，实际未生效，不应继续使用。

uhttpd 的 CGI 网关验证 LuCI 会话，再用固定白名单转发到 Unix socket。rpcd ACL 分开授予读取与保存权限；只有读取权限的账户可以查看和静态校验，不能保存。会话失效后后续 API 请求被拒绝。会话通过同源父页面握手传入内存，不进入链接、配置文件或浏览器存储。CGI HTTP 流式传输完整 YAML 和历史，避免把大配置塞进 ubus 消息。

uhttpd 的 CGI 头部白名单不会传递 `If-Match`，路由器传输层因此把修订号放在请求正文中，网关恢复后端的并发检查头；不能覆盖其他页面刚保存的草稿。入口 HTML 经 CGI 设置 `no-store`，静态资源带内容哈希，避免 SDK 固定文件时间戳导致升级后继续打开旧页面。

路由器通常通过局域网 HTTP 地址访问，不属于浏览器的安全上下文。r4 的 YAML 编辑器使用 Monaco 实例内递增的模型名称，不再依赖仅在安全上下文提供的 `crypto.randomUUID`，避免完整配置和单节点编辑器白屏。验收必须覆盖实际局域网 HTTP 地址，localhost 测试不能代替此项。

`/etc/mihomo-manager/state.json` 保存草稿和最多 30 条修订，权限 0600。YAML 仍是配置来源，不生成第二份 UCI 节点模型。升级和 sysupgrade 保留该目录，卸载也不主动删除用户配置。服务日志仅进入系统 logd，不另建日志目录。

## 构建

1. 在仓库运行 `npm ci`、`npm run build:router`。输出在 `dist/router-sdk-package/mihomo-manager/`，无需在路由器安装 Node.js。
2. 下载官方 [ImmortalWrt 25.12.0 x86/64 SDK](https://downloads.immortalwrt.org/releases/25.12.0/targets/x86/64/)，核对官方 SHA-256 后解压到 Linux 构建环境。
3. 将上一步生成目录复制到 SDK 的 `package/mihomo-manager/`。
4. 在 SDK 根目录运行本仓库 `scripts/router/sdk-build.sh`。产物在 `bin/mihomo-manager/`，包含两个签名 APK、公钥和 SHA256SUMS。脚本使用本地 RSA 签名密钥，签名后验证产物；不会将私钥放入产物目录。

长期分发时，通过 `MIHOMO_SIGNING_KEY` 指向自行管理的固定私钥，避免每次升级更换信任公钥。本次预览包使用临时签名，测试结束后销毁私钥，只保留 APK 和公钥；下次更换签名密钥后需重新确认并导入新公钥。

不要把 Alpine APK 重命名后安装到 OpenWrt。这里使用目标固件的 SDK 生成包、用户定义和安装脚本。

## 安装与卸载

安装前先导出已有配置。首次安装会启用并启动本包的管理服务，LuCI 包刷新 rpcd ACL，可能需要重新登录 LuCI；不会启动 Mihomo。

将两个 APK 和该次构建的公钥复制到路由器。确认公钥来源后放入 `/etc/apk/keys/`，再执行 `apk --no-network add /tmp/mihomo-manager-*.apk /tmp/luci-app-mihomo-manager-*.apk`。目录里只放此次版本。标准固件已包含所需依赖，缺失时安装会报错；不应为了安装此包关闭系统的签名校验。

服务管理：`/etc/init.d/mihomo-manager status|start|stop|restart|enable|disable`。

卸载：`apk del luci-app-mihomo-manager mihomo-manager`。如需彻底清除配置，再明确删除 `/etc/mihomo-manager/`，并移除本包独有的签名公钥；这是不可恢复的用户配置删除，不作为卸载默认行为。

## 第一阶段后续计划（历史记录）

下一阶段增加受限特权代理和 procd 内核 Runtime 适配器，接入内核安装、更新、回退与真实应用。网络接管另行实现事务和失联回退，当前 APK 没有预留自动开启开关。

## 参考接口

- [OpenWrt 包构建](https://github.com/openwrt/openwrt/blob/openwrt-25.12/include/package-pack.mk)
- [procd shell API](https://github.com/openwrt/openwrt/blob/openwrt-25.12/package/system/procd/files/procd.sh)
- [LuCI rpc 会话 API](https://github.com/openwrt/luci/blob/master/modules/luci-base/htdocs/luci-static/resources/rpc.js)
- [LuCI ACL 格式](https://github.com/openwrt/luci/blob/master/modules/luci-base/root/usr/share/rpcd/acl.d/luci-base.json)
- [Linux no_new_privs](https://docs.kernel.org/userspace-api/no_new_privs.html)

采用这些接口和标准包布局，未复制 Nikki/OpenClash 的网络接管实现。
