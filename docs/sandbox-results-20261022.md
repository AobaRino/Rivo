# 2026-10-22 Docker 真机测试结果

22 项检查通过。测试在用户指定的 Debian amd64 / Docker 29.6.2 主机执行，使用 3 个新建容器和一个内部网络。没有连接已有业务容器，没有发布宿主机端口，也没有修改本地工作区的保存状态。

内核为官方 [Mihomo v1.19.32](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32)，文件 `mihomo-linux-amd64-v1-v1.19.32.gz`。实际下载文件大小与 release 元数据一致，SHA256 为 `306f81e723e60ce6b828899a6fe83e1d00e9ecefb2dc8d4d849312a5bc00efdc`，与 GitHub release 摘要核对一致。

## 检查结果

| 项目 | 结果与证据 |
| --- | --- |
| 管理器生成的 YAML | 由现有表单编辑函数生成，前端校验与真实 `mihomo -t` 均通过 |
| 订阅 + 手动节点 | 同一代理组包含 `Manual` 和 `Subscribed`；分别选择后均完成 Shadowsocks TCP 转发 |
| HTTP 规则集 | 内核下载后命中 `RuleSet(HTTP)` |
| 本地 MRS | 使用同版本内核从 YAML 转换为 MRS，加载后命中 `RuleSet(File)` |
| 内联 classical | 加载后命中 `RuleSet(Inline)` |
| GEO DAT | 下载并解析最小有效 GeoSite / GeoIP 样本，命中 `GeoSite(sandbox)` 和 `GeoIP(sb)` |
| 订阅定时更新 | 5 秒间隔生效，新订阅节点 `SubscribedV2` 替换旧订阅节点，自建 `Manual` 保留 |
| 规则集定时更新 | 规则数从 1 增至 2，新域名实际命中 `RuleSet(HTTP)` |
| 损坏资源 | 更新接口返回错误；旧节点和规则仍可转发 |
| 源站 HTTP 503 | 更新接口返回错误；旧节点和规则仍可转发 |
| GEO 手动更新 | 原生接口返回 204；GeoSite / GeoIP 下载计数增加，更新后仍能匹配和转发 |
| 改名引用 | 管理器生成的节点、订阅、规则集改名配置成功重载；组成员、provider 名称、规则引用同步更新 |
| 中文摘要 | 显示节点、订阅、规则集改名与代理组引用变化；规则引用按旧规则删除、新规则新增显示，与 YAML 一致 |
| 错误引用 | 不存在的 rule-provider 被 `mihomo -t` 和重载接口拒绝，正在运行的配置仍可转发 |
| 隔离约束 | 无宿主机端口、非 root、无 capabilities、只读根目录、内部网络、CPU/内存/PID/日志限制均通过 inspect 验证 |

## 现有环境与清理

- 12 个原有容器的 ID、镜像、启动时间、重启次数、运行/健康状态、端口和所属网络与基线一致。
- 原有 7 个 Docker 网络仍存在，13 个卷的列表未变化。
- 本次 3 个容器、专用网络和测试镜像已删除。宿主机路由表与测试前完全一致。
- 本地 `.local/state.json` 的 SHA256 与测试前相同，草稿、应用记录和历史没有改变。
- 保留测试日志、配置及脚本作为证据；没有执行全局 Docker prune，构建缓存未进行全局清理。

## 发现的问题与后续接入要求

前几轮测试在测试工具准备和内核接口对接阶段暴露了以下问题，修正后完整重跑并通过；这些失败记录没有当作产品通过结果。

1. `docker cp` 未取得运行容器 tmpfs 中的 MRS 文件；改成由转换命令通过标准输出返回二进制，并核对输出非空。
2. GEO 初始化下载早于完整配置生效。同一份配置中的 `hosts` 不能作为资源源站启动解析的唯一依赖；改用测试网络内的 Docker DNS。
3. 规则集单项 GET 接口返回 405，状态应从 `GET /providers/rules` 中读取。
4. `-f` 能加载的路径不一定允许 API 重载。真实内核对重载路径执行 HomeDir / `SAFE_PATHS` 检查；测试只允许容器内只读的配置目录。
5. 内核日志显示 provider 下载也会匹配分流规则。后续需要明确资源下载出口，避免订阅下载依赖尚未下载的节点。

页面不新增远程连接或真实应用按钮。持久 YAML、内核缓存和临时运行状态继续分别处理；将来接入应明确显示校验、下载、重载三个阶段的结果，不能把“草稿保存成功”当作“内核运行成功”。

## 未覆盖

未测试公网机场订阅或用户真实节点、UDP 与全部代理协议组合、MMDB/ASN 的完整数据库、小时级 GEO 自动更新、内核在线升级/回退、TUN/TProxy 与路由器防火墙接管。本次 GEO 使用有效的小型样本，验证的是原生下载、解析和匹配行为，不验证地理数据质量。

原始证据在项目的 `.local/docker-sandbox-20261022/`：`results.json`、`cleanup.json`、`baseline.json`、`comparison.json`、`isolation.json`、`client.log`、`release.json`、`local-state-result.json`、生成的 YAML 和中文摘要。该目录被 Git 忽略；可复用脚本和边界说明保留在 `scripts/sandbox/` 与 `docs/docker-sandbox.md`。
