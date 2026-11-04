# 关键词与正则补充规则

现有 MetaCubeX MRS 提供精确域名、域名后缀和 IP 规则。本目录维护对应的关键词与正则补充产物生成方式，不替换 MRS，也不加入广告分类。

`catalog.json` 是前端预设与生成器共用的分类来源，覆盖基础域名集和 23 个服务分类（含各自优先直连分类）。`ips` 供前端使用；生成器只处理 `baseDomains`、`domains` 和 `directDomains`。

## 运行

需要 Node.js 24，无额外依赖。

```sh
node --test scripts/rules/*.test.mjs
node scripts/rules/generate.mjs
# 可指定完整上游提交，重现当时的规则数据
node scripts/rules/generate.mjs --upstream-sha <40位SHA> --output .local/rules-output
```

默认输出到 Git 忽略的 `.local/rules-output`。生成器最多并发 4 个下载，每次最多 30 秒，最多重试 3 次，单文件限制 20 MiB。先固定上游提交，再校验全部文件，最后替换整个输出目录。任一下载或解析失败不替换上一次产物。只允许四种域名类型，任何未知类型、HTML 错误页或空源文件都会使整批失败。只在第一处逗号拆分类型，保留正则中的逗号和转义。重复补充项按完整规则文本去重并保留原先顺序。

没有关键词或正则的分类也输出文件，仅含注释；不添加虚构域名、兜底规则或拒绝规则。每个文件与 `manifest.json` 都包含来源与计数，manifest 另记录 SHA-256、上游提交、生成器提交和时间。计数不能跨分类简单相加作为唯一域名数。

## 发布与订阅

GitHub Actions 的 `Update rule supplements` 工作流每日 04:17 UTC（北京时间 12:17）运行，亦支持手动运行，以及 main 上本目录、生成器或工作流变更触发。它只向独立 `rules` 分支发布，不将每日产物提交到 main。工作流串行执行；先完成测试与整批生成，再用隔离 Git index 构建一棵完整产物树，通过一次非强制 push 更新 rules 分支。并发改动导致 push 被拒绝时，已发布内容保持不变。

```sh
# 首次合并工作流后可从 GitHub Actions 页面手动运行，或：
gh workflow run rule-supplements.yml --ref main
# 维护者本地发布已校验产物（会写入远端 rules 分支）：
node scripts/rules/publish.mjs --output .local/rules-output
```

稳定下载地址为 `https://raw.githubusercontent.com/AobaRino/Rivo/rules/geosite/<tag>.list`。例如：

```yaml
rule-providers:
  steam-extra:
    type: http
    behavior: classical
    format: text
    url: https://raw.githubusercontent.com/AobaRino/Rivo/rules/geosite/steam.list
    interval: 86400
    # proxy: 你的可用代理组
rules:
  # 保留原有 Steam 国内下载、MRS 等规则的优先级；补充项紧邻同分类 MRS。
  - RULE-SET,steam-extra,Steam
```

下载、定时刷新、缓存均由 Mihomo 原生 rule-provider 执行。原 MRS 与补充文件由不同发布流程更新，不能保证两者同一时刻对应相同提交；manifest 可追溯补充文件版本。GitHub Raw 缓存也可能使各文件更新稍有延迟。工作流失败时保留上次成功发布，不能把调度成功与客户端已更新等同。

授权与原作者说明见 [SOURCES.md](SOURCES.md) 与 [LICENSE.MetaCubeX](LICENSE.MetaCubeX)。
