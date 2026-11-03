# 内核更新、回退与 Schema

此阶段管理 Linux 上的独立 Mihomo 子进程。默认关闭，Windows 仍用于编辑页面。没有系统代理、TUN、iptables、透明代理或路由器服务接管。托管模式现已接入[真实配置应用](config-apply.md)；保存草稿与应用仍然分开。

## 启用

在 Linux amd64/arm64 上运行管理服务，设置：

```sh
MIHOMO_CORE_ENABLED=1
MIHOMO_CORE_DIR=/absolute/private/core-directory
MIHOMO_CORE_CONFIG=/absolute/private/coreconfig.yaml
```

三个值需作为环境变量传入服务。服务仍在 127.0.0.1:18787 提供 API。使用专属数据目录和普通用户运行；同一目录只交给一个管理服务实例。配置需要回环控制端口、至少 16 字符 secret，关闭 TUN、透明代理、allow-lan 和自定义 listeners。示例参见 `scripts/core-sandbox/coreconfig.yaml`，示例 secret 只用于一次性测试。

不提供远程多人鉴权，不开放公网。实际配置中的代理、provider 和资源仍由 Mihomo 处理；管理器不转换订阅。`MIHOMO_CORE_CONFIG` 提供首次启动配置及固定管理接口。第一次成功应用后，后续启动和升级读取已提交的配置版本；工作台保存草稿不会自动应用。

## 更新事务

1. 用户检查官方稳定版列表，选择版本并准备。amd64 使用兼容性优先的 v1 构建，arm64 使用原生构建。
2. 后端只允许 GitHub 官方发布路径和 npm 的固定包路径，使用 HTTPS，限制重定向、下载体积和解压体积。必须与 GitHub 资产 SHA256、大小一致；Schema 必须与 npm SHA512 integrity 一致。该校验是发布源提供的完整性校验，不是额外签名体系。
3. 每次准备创建独立版本目录，保存二进制、Schema、哈希和配置哈希。执行二进制 `-v` 和 `-t`。`-t` 使用资源目录副本，不改动正在运行的缓存。内核目录持有 Linux 文件锁，第二个管理实例明确拒绝启动。
4. 页面预览内核与 Schema 前后版本，用户确认后重新校验候选文件及当前配置。陈旧页面的版本标识或并发操作返回 409。
5. 升级或回退先复制当前配置和资源到候选目录。将切换意图落盘，停止自己启动的子进程，重新复制已经关闭的 cache.db，再在候选目录启动目标版本。控制端口被其他进程占用时拒绝接管。通过带 secret 的 `/version` 连续健康检查后，原子提交内核、配置和资源指针；此时前端才加载该版本的 Schema。失败继续使用旧资源目录。
6. 候选启动失败或健康检查失败时恢复原版本；恢复失败会明确显示错误。中途崩溃后只恢复最后落盘确认的版本。第一次安装失败时保持未安装状态。
7. 保留当前、上一个以及尚未确认的候选目录；清理仅限该专属目录下由管理器生成的版本目录。回退同样检查文件完整性、配置和健康状态。

每次切换会中断该进程中的连接。健康检查包括进程存活、控制 API 版本、实际模式和代理端口，以及代理端口监听，不保证任意公网节点可用。真实测试另外通过显式 HTTP 代理访问受控源站验证转发。内核版本回退保持当前已应用配置；配置应用失败则恢复原配置及原资源目录。

## Schema 生命周期

来源为 [meta-json-schema](https://github.com/dongchengjie/meta-json-schema)，精确请求与内核对应的版本，禁止外部 `$ref`。不跟踪 `latest`，不创建独立定时更新任务。Monaco 字段、枚举、中文说明、诊断与“更多字段”使用同一份版本数据；语言服务的 Schema URI 包含版本目录标识，切换时不沿用旧解析缓存，也不重建用户的 YAML 文本。

Schema 缺失、不可用或损坏时，保留上一份已知有效 Schema；首次安装使用内置 1.19.32。界面显示实际 Schema 版本和提示可能不完整的警告。回退恢复原来版本包中的 Schema 和警告状态。若新 Schema 随后发布，可重新准备同一内核版本并确认。

浏览器断开后端时保留已加载 Schema，并显示同步失败提示。Schema 不代替 `mihomo -t`，不阻止保存未知字段。1.19.32 的局部修正只应用于 1.19.32。

## API

| 路径 | 用途 |
| --- | --- |
| `GET /api/core` | 托管启用状态、运行状态、当前/上一/候选版本、任务结果 |
| `GET /api/core/releases` | 官方稳定版列表 |
| `GET /api/core/schema` | 当前确认版本的 Schema、真实版本、警告与哈希 |
| `GET /api/core/providers` | 已应用订阅节点数量和更新时间，不返回 URL 或凭据 |
| `POST /api/core/prepare` | `version`、`expectedCurrent`；异步准备 |
| `POST /api/core/activate` | `id`、`expectedCurrent`；确认切换候选 |
| `POST /api/core/rollback` | `id`、`expectedCurrent`；确认回退上一版本 |

写入返回 202 后轮询状态；正在执行或版本冲突返回 409。未启用时内核管理写入返回 409，浏览器无法远程开启托管模式。`GET /api/health` 和 `/api/state` 的 `simulation` 在托管模式为 false，默认模拟模式为 true。

## 可重复 Docker 测试

`scripts/core-sandbox/prepare.ps1` 从官方来源取得 v1.19.31/32/33 和精确 Schema 包，记录并验证哈希。`fixture.go` 仅用于独立测试：容器内 HTTPS 镜像提供未修改的官方文件，以及故障注入和受控转发源站；测试 CA 只通过容器的 `SSL_CERT_FILE` 使用，不导入主机信任库。

将 `manager`、Linux `fixture`、`manager-tests`、测试材料、`run.py`、`apply_test.py`、`review_test.py` 和 `scripts/sandbox/run.py`（命名为 `safety.py`）放到新的 `~/mm-sandbox-*` 目录。先执行 `python3 safety.py baseline`，再依次执行 `python3 run.py setup`、`python3 apply_test.py`、`python3 run.py tests`、`python3 review_test.py`。具体构建命令使用 `GOOS=linux GOARCH=amd64 CGO_ENABLED=0`，分别构建 `./cmd/manager`、`./scripts/core-sandbox`，并对 `./cmd/manager` 执行 `go test -c`。

所有容器有专属标签，非 root、只读根文件系统、移除全部 capabilities、no-new-privileges、内存/CPU/PID 上限；使用新建 internal bridge，不映射主机端口、不挂载 Docker socket或现有业务目录。测试数据仅在新目录内持久化以验证服务重启恢复。`python3 run.py cleanup` 验证标签与记录的精确 ID 后清理专属容器、网络和镜像，再核对原有容器的 ID、启动时间、重启次数、镜像、端口及网络，以及原有卷和路由。

测试覆盖正常更新/回退、Schema 缺失/损坏、二进制下载和暂存损坏、配置变化、真实 `-t` 拒绝、并发与陈旧请求、启动失败恢复、服务重启和切换中断恢复。全程不使用真实订阅凭据，不连接路由器。