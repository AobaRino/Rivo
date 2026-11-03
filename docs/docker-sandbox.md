# Docker 真机测试

这套测试启动真实 Mihomo，使用独立的测试配置。网页和 Go API 仍然是本地原型，保存、模拟应用不会因此启动或连接远程内核。

## 隔离范围

测试在用户指定的 Linux Docker 主机运行。只创建带 `io.mihomomanager.sandbox=<运行目录名>` 标签的资源：一个内部 bridge 网络、三个容器和一个专用镜像。容器分别提供 HTTP 测试资源与目标站、Shadowsocks 服务端、Mihomo 客户端。

- 不发布宿主机端口，不使用 host 网络，不接入现有 Docker 网络。
- 网络使用 `--internal`。测试期间资源下载和业务流量都发生在这个网络里。内核发布包在准备阶段通过 HTTPS 下载，并与 GitHub release 的 SHA256 和大小核对。
- 容器使用 UID/GID 65532，移除全部 capabilities，启用 `no-new-privileges`，根文件系统只读。不挂 Docker socket、宿主机设备或现有业务数据。
- 每个容器限制 CPU、内存、进程数和日志。三者合计上限为 1 个 CPU、640 MiB 内存；禁止额外 swap。资源缓存使用每容器 32 MiB tmpfs，临时目录为 8 MiB tmpfs，均计入内存限制。
- 启动前记录现有容器 ID、镜像、启动时间、重启次数、状态、健康状态、端口和网络。结束后逐项对比，同时检查已有网络、卷和路由。
- 清理按 manifest 中记录的完整 ID 操作，并复核标签；不执行全局 prune，也不重启 Docker。

内部 bridge 不是虚拟机安全边界：它仍共享宿主机内核和资源，宿主机可以访问容器，Docker 也会为新网络建立网络对象。此处运行的是可信官方内核与本项目测试程序；不适合运行不可信二进制。测试不修改 Windows 系统代理、DNS、网卡或路由。

## 文件

- `scripts/sandbox/generate.ts`：调用网页表单使用的 YAML 编辑函数，生成原始/改名配置及中文摘要，不读写已保存工作区。
- `scripts/sandbox/fixture.go` / `extras.go`：无第三方依赖的 HTTP/UDP 目标站、容器内请求工具、临时测试证书和启动入口。
- `scripts/sandbox/run.py`：Docker 生命周期、真实请求、失败场景、结果记录和精确清理。
- `scripts/sandbox/protocols.ts` / `review.py`：可选的协议及 API 回归，参见 [2026-10-23 审查报告](review-20261023.md)。上传协议样本及 Linux `manager` 后自动执行；先停止两个测试内核，再启动第四个 API 容器，同时运行的内存上限仍不超过 640 MiB。

脚本不保存 SSH 凭据。远程目录必须是当前账号主目录下新建的 `mm-sandbox-*` 目录。重名镜像或已有 manifest 会使运行终止，防止覆盖现有资源。失败后保留当次结果与容器供诊断，必须显式运行 `cleanup`；不应让失败环境长期运行。

## 准备与运行

在项目目录生成 Linux amd64 的测试程序与 YAML：

```powershell
$env:GOOS='linux'
$env:GOARCH='amd64'
$env:CGO_ENABLED='0'
& .\.tools\go\bin\go.exe build -trimpath -ldflags '-s -w' -o .local\sandbox\fixture ./scripts/sandbox
node --input-type=module -e "import { build } from 'rolldown'; await build({input:'scripts/sandbox/generate.ts',platform:'node',output:{file:'.local/sandbox/generate.cjs',format:'cjs'}});"
node .local/sandbox/generate.cjs .local/sandbox/generated
```

把 `fixture`、生成的 `client.yaml` / `renamed.yaml`、`run.py`、经校验的 `mihomo` Linux 二进制和 release 元数据放入远程新目录。创建资源前先记录基线，不可用测试中途的状态代替。

```sh
python3 run.py baseline
python3 run.py
# 下载结果、日志、manifest、comparison 和 isolation 证据后清理。
python3 run.py cleanup
```

生成的 `FIXTURE_IP` / `NODE_IP` 占位符由运行器替换成新容器的地址；绑定端口只存在于容器网络。固定的 `sandbox-test-only` 和 `sandbox-only-token` 是隔离测试数据，不是真实账号或生产配置。

GEO DAT 是根据固定版本 Mihomo 的 protobuf schema 构造的最小有效样本，验证下载、解析和路由行为；它不是地理数据库准确性测试。MRS 由同一个真实 Mihomo 转换生成。所有订阅都由真实 Mihomo 下载、解析、更新；管理器没有增加订阅转换逻辑。

## 已发现的接入注意事项

1. **GEO 下载有启动依赖。** 缺少 GEO 文件时，规则解析阶段就可能触发下载。不能假定同一份配置中的 `hosts` 或尚未就绪的 DNS、代理已经可用。测试使用 Docker 内部 DNS 解析资源源站。
2. **下载流量也可能命中代理规则。** 未指定 provider 的 `proxy` 时，本次日志显示 provider 请求命中了 GEOIP 和代理组。未来接入时需要明确下载使用 DIRECT 还是指定代理，并避免“下载订阅依赖订阅里尚未获取的节点”。
3. **静态检查不等于真实校验。** 必须区分 YAML 检查、`mihomo -t`、资源是否成功加载、实际流量是否匹配预期规则；首次 GEO 下载失败可能直接阻止启动。
4. **API 以实际内核版本为准。** 此版本规则集状态从 `GET /providers/rules` 列表读取，`GET /providers/rules/<name>` 返回 405；手动更新使用对应 provider 的 PUT 接口。
5. **启动路径和重载路径的检查不同。** `-f /config/client.yaml` 可以启动，但 API 重载 `/config/renamed.yaml` 会检查该路径是否位于内核 HomeDir 或 `SAFE_PATHS` 内。测试只将容器内部、只读的 `/config` 加入安全路径；正式接入应统一配置与缓存的目录设计。

这套测试覆盖受控 TCP 转发和原生资源行为。公网机场订阅、真实远端节点、TLS/UDP 协议组合、路由器 TUN/TProxy、完整 MMDB/ASN 资源和内核升级回退需要另行测试；不因本次通过而标为已验证。
