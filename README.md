# Rivo

基于 React、TypeScript 和 Go 的 Mihomo 配置与运行管理面板。使用独立 Web 服务，LuCI 提供入口、总开关、开机启动和端口设置。

项目仓库：[AobaRino/Rivo](https://github.com/AobaRino/Rivo)。项目原名 Mihomo Manager；当前源码已更名为 Rivo，OpenWrt 包修订为 `0.1.0-r19`。

## 功能

- **配置编辑**：保留原始 YAML、注释和未知字段；支持草稿、修订记录、放弃修改，保存前显示配置块摘要及 YAML 差异。
- **节点与订阅**：自建节点使用 YAML 编辑器，提供协议示例、字段补全、备选值、中文说明和错误定位。订阅使用 Mihomo 原生 `proxy-providers`。
- **代理组**：自建和订阅节点混排，订阅更新后保留已有排序。失效名称单独展示并可一键清理，来源不完整时禁止误删；清理仍走草稿预览流程。
- **分流规则**：可视化管理 `rule-providers` 和有序规则，提供域名/IP 直连例外、MetaCubeX 规则预设及可选服务分组。
- **DNS 与 GEO**：可视化编辑常用字段、来源和更新间隔，高级字段可用结构化编辑或 YAML 修改。
- **运行管理**：路由器首页显示真实流量、连接和内存，支持内核启动、停止、重启、运行模式切换及官方 Zashboard。
- **配置应用**：保存与应用分离，应用前调用内核校验，切换失败恢复上一份配置。
- **版本管理**：Linux 托管模式支持内核更新、回退和 Schema 联动；Zashboard 使用官方构建，支持定时检查、确认更新和回退。

## 运行方式

| 环境 | 行为 |
| --- | --- |
| 本地开发 | 默认使用运行模拟器，只监听回环地址，不启动代理内核或修改电脑网络 |
| Linux 托管模式 | 显式启用独立 Mihomo 进程，支持真实配置校验、应用和内核版本管理 |
| OpenWrt / ImmortalWrt | 独立 HTTPS Web 服务、登录与受限特权接口，procd 管理内核，LuCI 管理整个应用 |

当前路由器适配目标是 **ImmortalWrt 25.12 / x86_64 / APK / fw4**，透明代理范围为 `br-lan` 的 IPv4 TCP/UDP。路由器在线内核更新、IPv6 接管及其他固件/架构尚未完整开放或验证。详细边界见[路由器安装包](docs/router-package.md)和[独立 Web 架构](docs/standalone-web.md)。

路由器首页的停止按钮只停止内核并撤销相应网络接管，Web 保持可访问；LuCI 总开关关闭 Web、内核和本项目的网络接管。开机启动也由 LuCI 设置。

## 本地开发

准备 Node.js 22.12 或更新版本、npm 和 Go 1.27。脚本按 `MIHOMO_GO` 环境变量、`.tools/go/`、系统 PATH 的顺序查找 Go。

```sh
git clone https://github.com/AobaRino/Rivo.git
cd Rivo
npm ci
npm run dev
```

Windows 也可以运行 `./Start-Dev.ps1`，通过 `./Stop-Dev.ps1` 停止本项目的开发服务。

- 页面：<http://127.0.0.1:5173/>
- 本地 API：<http://127.0.0.1:18787/api/health>
- 首次运行会下载并校验固定版本的官方 Zashboard；也可以单独运行 `npm run setup:zashboard`。
- 本地草稿、工具缓存和测试数据保存在被 Git 忽略的 `.local/`、`.tools/` 中。

本地模拟器的流量和连接不是实际网络数据。真实节点连接能力以对应环境中的 Mihomo 内核验证为准。

## 检查与构建

```sh
npm run check          # TypeScript
npm test               # 前端逻辑测试
npm run test:go        # Go 测试
npm run build          # 前端产物 web/dist
npm run setup:zashboard
npm run build:router   # 准备 OpenWrt SDK 输入
```

APK 需使用与目标固件匹配的 SDK 构建并签名，具体步骤见[构建与安装说明](docs/router-package.md)。构建产物、私钥、真实配置和订阅凭据不提交到仓库。

## 改名与升级兼容

页面、LuCI 显示、npm 工作区和 Go 模块已经使用 Rivo。为兼容已安装版本，现阶段保留以下内部标识：

- APK 包名：`mihomo-manager`、`luci-app-mihomo-manager`。
- procd 服务、UCI/ubus 名称、运行用户、socket 和本项目的 nft 表。
- `/etc/mihomo-manager/`、`/etc/mihomo-manager-runtime/` 等配置与运行目录。
- 既有环境变量、鉴权 Cookie 和 YAML 扩展字段。

改名不会迁移或重写已有草稿、节点选择和路由器配置。Mihomo 仍是所管理的内核名称，上游名称和许可证保持原样。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `web/src/` | React 页面、公共组件、YAML 编辑和差异预览 |
| `cmd/manager/` | Go API、持久化、内核事务、鉴权和路由器适配 |
| `internal/dashboardbundle/` | 官方 Zashboard 包校验与解压 |
| `configs/` | 不含真实凭据的示例配置 |
| `packaging/openwrt/` | APK 定义、LuCI 入口、procd 和网络脚本 |
| `scripts/` | 开发、构建和隔离测试工具 |
| `docs/` | 架构、安装、功能边界和标注日期的历史验证记录 |

早期架构和验证记录反映各自日期的状态，当前路由器行为以[安装包文档](docs/router-package.md)及源码为准。

## 上游与许可

复用官方 Zashboard、Monaco、monaco-yaml、meta-json-schema、react-jsonschema-form 等成熟组件。订阅和规则集的下载、解析、更新由 Mihomo 完成，不使用第三方订阅转换服务。

具体来源、许可及参考范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和[上游采用说明](docs/upstream-adoption.md)。本仓库目前未另行声明项目许可证；各第三方组件继续适用原许可证。
