# Rivo 独立 Web 架构

## 边界

Rivo 是独立 React + TypeScript 应用。生产构建由 Go 的 HTTPS 服务提供，页面和 API 同源，不需要 Node.js、LuCI iframe、CGI 或 LuCI 登录会话。LuCI 只是 OpenWrt 平台的服务入口，负责总开关、端口和首次密码初始化入口。

前端使用 React 19、TypeScript、Vite、React Router 和 TanStack Query。路由使用真实路径，支持直接打开、刷新和浏览器前进后退。登录、请求传输、通用界面组件与配置工作空间分离。编辑中的 YAML 独立于服务器查询缓存，轮询不覆盖未保存的修改。Monaco、monaco-yaml、原生 YAML 文档修改和 Zashboard 保留。

## 进程与权限

项目已更名为 Rivo。以下 `mihomo-manager` 服务、命令、路径、UCI/ubus 标识和 `mihomomgr` 用户保留为升级兼容接口；产品更名不迁移既有配置，也不改变运行权限。Mihomo 继续作为代理内核。

- `mihomo-manager router`：专用 `mihomomgr` 用户，HTTPS Web、独立登录、编辑服务、面板更新；所有线程设置 `no_new_privs`。
- `mihomo-manager router-broker`：root，只监听 root 管理目录中的 Unix socket。接口为固定白名单，处理真实运行状态和校验后应用，不接受命令、下载地址或任意文件路径。
- `mihomo-manager-core`：现有 procd 内核，运行和草稿相互独立。
- `mihomo-manager-network`：现有透明代理适配与回退监控。
- LuCI 通过独立 rpcd 对象管理固定服务，无通用 shell、文件或任意服务启停权限。

Web 端口默认 18888，只绑定 LAN 管理地址。优先复制路由器已配置的 TLS 证书到 root 管理、服务组可读的位置，运行时不依赖 uhttpd；没有证书时生成自己的证书。

已有有效管理域名的设备可设置 UCI `mihomo-manager.web.hostname`，让 LuCI 入口使用与证书匹配的域名；监听地址仍为 LAN IP。

## 登录

首次启动产生随机一次性初始化令牌，保存在权限受限的文件中。LuCI 的写权限用户可打开初始化链接，令牌放在 URL fragment，前端读取后移除。用户设置至少 12 字符的独立管理密码。服务只保存随机盐与 PBKDF2-SHA256 摘要；不复用或读取路由器密码。

会话使用 Secure、HttpOnly、SameSite=Strict Cookie，最长 12 小时。退出撤销会话和进行中的流式请求，Web 重启使会话失效。接口检查同源来源并限制登录尝试次数。未登录不能读取 YAML、状态、面板更新或 Mihomo API。

## LuCI 总开关

关闭时保存关闭标记，停止应用任务，撤销本项目的网络接管，再停止内核和 Web；关闭开机启动。配置、节点和面板文件保留。启动脚本检查关闭标记，软件包升级不能重新开启已关闭的服务。

开启时撤销关闭标记，启动 Web 和已配置的内核，通过内核接口检查后恢复此前启用的网络接管。没有运行配置的新安装只启动 Web。网络适配仍限定现有的 LAN IPv4 方案，不操作 Daed 或其他项目。

端口范围 1024–65535。修改前检查端口占用，仅重启 Web；启动失败恢复原端口。Web 原本关闭时仅保存端口，不启动服务。

## 配置与运行 API

YAML 仍是持久化配置来源。保留保存预览、块级摘要和 YAML 差异，以及真实内核校验、应用和自动回退。原配置目录原样使用，不导入本地示例覆盖路由器。

Zashboard 由独立服务提供，使用经过鉴权的同源 HTTP/WebSocket 代理连接实际内核。临时模式、日志等级、代理组选择与连接操作不写回 YAML。运行 API 禁止修改 TUN、DNS、监听和更新内核；这些必须通过管理器受控流程。

## 参考

- [React 官方：Vite、路由与数据获取方案](https://github.com/reactjs/react.dev/blob/main/src/content/learn/build-a-react-app-from-scratch.md)
- [TanStack Query](https://github.com/TanStack/query/blob/main/docs/framework/react/overview.md)
- [OpenWrt 软件包脚本](https://github.com/openwrt/openwrt/blob/openwrt-25.12/include/package-pack.mk)

这里使用成熟库和平台接口；没有把 React 前端改写成 LuCI 页面，也没有引入服务器渲染所需的常驻 Node.js 进程。
