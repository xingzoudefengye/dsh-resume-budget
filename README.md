# dsh-resume-budget

恢复一个长会话时，在第一个请求发出**之前**检查预计输入；超过阈值就先压缩一次，再发请求。

> English: A DeepSeek Harness (DSH) plugin that puts a configurable input ceiling on the first request of a restored session. When the projected prompt is at or above `thresholdTokens` (default `100000`), it compacts the history through the harness's official overflow path before that request is assembled. The check runs once per session per process, is skipped for sessions created in this process, and never fails a turn. It adds no storage, no background work, and no model calls of its own. MIT licensed, Node.js >= 22.

## 兼容性

| 平台 | 支持 | 说明 |
|---|---|---|
| Windows 10/11（PowerShell） | ✅ | 插件本身是纯 JS。仓库脚本全部有 `.mjs` 版本：`node scripts/check.mjs` / `node scripts/dev-link.mjs`。Windows 上 `dsh` 是 `dsh.cmd` 垫片，`check.mjs` 已经处理（用一条带引号的命令行经 shell 启动，绕开 Node 对 `.cmd` 的 EINVAL 和不搜 PATHEXT 导致的 ENOENT）。**不要用 `bash scripts/check.sh`**：Git `core.autocrlf=true` 会把它检出成 CRLF，bash 会报 `set: pipefail: invalid option name`。 |
| macOS（zsh） | ✅ | `node scripts/check.mjs`，或原有的 `bash scripts/check.sh`。`~` 展开、PATH 查找都走 POSIX 一路。 |
| Linux | ✅ | 同 macOS；这是 `scripts/*.sh` 最初针对的环境。没有平台相关的原生依赖。 |

实际验证环境：Windows 11 22H2 + Node 24.19.0（`engines` 下限是 22）。macOS/Linux 走的是同一套 `node:path`/`node:os`/`node:fs` API，但仓库没有 CI 矩阵，这两条是兼容性承诺而非实测记录。

Node 版本：`package.json` 的 `engines` 要求 **`node >= 22`**（脚本只用了 `node:` 内置模块，无第三方依赖）。

DSH 版本：本包**没有** `engines.dsh`，四个 peer 依赖都写成 `"*"` 且全部 optional：

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "*",
  "@deepseek-ai/dsh-compaction": "*",
  "@deepseek-ai/dsh-token-meter": "*",
  "@deepseek-ai/schemastery": "*"
}
```

所以 `dsh plugin add` 不会因为版本号拒绝安装；真正的门槛是 API 是否存在：插件需要宿主提供 `agent/pre-step` 事件、`ctx.tokenMeter.measure()`、`ctx.compaction.compactIfNeeded()`。本仓库在 **dsh 0.2.1-rc.2** 上实测（`dsh --version`）。harness 若缺少 `compaction` 或 `tokenMeter` 服务，插件会挂载不上而不是报错——见[排错](#排错)。

## 安装

1. 确认工具链（两个平台一样）：

   ```bash
   node --version    # 需要 v22 或更高
   dsh --version
   ```

2. 装进你要用的 profile（`web` 是最常见的；profile 不存在时 `dsh plugin` 会初始化它）：

   ```bash
   dsh plugin --profile web add github:xingzoudefengye/dsh-resume-budget
   ```

   这条命令把包装进 `$DSH_HOME/profiles/web`，并把它加进该 profile 的 `dsh.profile.bundles`。首次安装需要能访问 GitHub（pnpm 拉取 `github:` 依赖）。

3. **重启宿主进程**（完全退出再启动）。插件是在宿主启动时被 import 的，装完不会热加载：

   ```bash
   dsh web
   ```

4. 按下一节验证，或直接恢复一个历史很长的会话看效果。

**安装命令唯一的系统差异是 `DSH_HOME` 的写法**，`dsh plugin add` 本身完全一样：

| 平台 | 默认 `DSH_HOME` | profile 目录 |
|---|---|---|
| Windows（PowerShell） | `%USERPROFILE%\.dsh`（`$env:USERPROFILE\.dsh`） | `$env:USERPROFILE\.dsh\profiles\web` |
| macOS（zsh） | `~/.dsh` | `~/.dsh/profiles/web` |
| Linux | `~/.dsh`（或 `$XDG` 习惯下的自定义值） | `~/.dsh/profiles/web` |

设置了 `DSH_HOME` 的话以它为准，`check.mjs` 也读同一个变量。

## 验证

在**仓库 checkout 里**运行（用仓库里的这一份；脚本本身不依赖 `lib/`）：

```bash
node scripts/check.mjs
```

装好插件后不想 clone 的话，profile 里安装的副本也有同一份脚本：

```powershell
# PowerShell
node "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-resume-budget\scripts\check.mjs"
```

```zsh
# zsh
node ~/.dsh/profiles/web/node_modules/dsh-resume-budget/scripts/check.mjs
```

它做两件事，和 `scripts/check.sh` 完全一致：

1. 在 `dsh --profile <profile> --dump-config` 的组合树里找 `id: resume-budget`；
2. 找 `thresholdTokens: <期望值>`。

默认 profile 是 `web`，默认期望阈值是 `100000`（即 bundle 自带的默认值）。安装正常时应看到：

```text
$ node scripts/check.mjs
ok:   resume-budget is in the composed tree
ok:   thresholdTokens is 100000
```

如果你在 profile 的 `cordis.patch.yml` 里改过阈值，把期望值作为第二个参数传进去，否则第二条会变成 `WARN`：

```bash
node scripts/check.mjs web 150000
# ok:   resume-budget is in the composed tree
# ok:   thresholdTokens is 150000
```

两个参数的含义：

| 参数 | 默认 | 含义 |
|---|---|---|
| 第 1 个：profile | `web` | 要检查哪个 profile 的组合树，必须与 `dsh plugin --profile` 用的名字一致。 |
| 第 2 个：expected-threshold | `100000` | **只用于比对，不会修改任何配置**。它回答“组合树里的阈值是不是我以为的那个数”。 |

输出约定：`ok:` 表示通过；`FAIL:` 写到 stderr 且**退出码 1**（行缺失、profile 不存在、`dsh` 起不来）；`WARN:` 写到 stderr 但**退出码仍是 0**（只是阈值对不上，组合树里可能仍然是可用配置）。常见错误：

```text
FAIL: no such profile: C:\Users\you\.dsh\profiles\nope
WARN: thresholdTokens 100000 not found in the composed tree
```

`DSH_HOME` 不在默认位置时：

```powershell
# PowerShell
$env:DSH_HOME = 'D:\dsh-home'; node scripts/check.mjs web 150000
```

```zsh
# zsh
DSH_HOME=~/dsh-home node scripts/check.mjs web 150000
```

macOS / Linux 也可以用原来的 `bash scripts/check.sh web 150000`，两者输出一致。

## 配置

只有一个配置键，定义在 `lib/index.js` 的 `Config`（schemastery）：

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `thresholdTokens` | number，整数，最小 0 | `100000`（`DEFAULT_RESUME_INPUT_TOKENS`） | 恢复会话第一个请求的**预计输入**达到这个数就先压缩。`0` 表示整个策略关闭。 |

几处边界行为：`0` 关闭检查；预计输入小于阈值不压缩，**等于阈值会触发**（`>=`）。`lib/decision.js` 的 `normaliseThreshold()` 对 `undefined`、`null`、负数、`NaN`、`Infinity` 一律回退到默认 100000 而不是 0；但走 YAML 配置时，`Config` 的 `min(0)` 和 `step(1)` 会让负数、小数在校验阶段就被拒绝。

改阈值要改 profile 的用户层 patch，不是改这个仓库里的 `cordis.patch.yml`（那是 bundle 的默认值，重装会被覆盖）。在你的 profile patch 里加一段按 `id` 覆盖的配置：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: resume-budget
  config:
    thresholdTokens: 150000
```

- `id` 必须正好是 `resume-budget`（`lib/index.js` 里 `export const name = "resume-budget"`）。写错了宿主启动时只会打印 `patch: entry "..." not found` 然后继续，组合树里仍是 100000——这是最容易“以为改了其实没改”的地方。
- 改完保存：profile 的 `patchReload` 为 `live` 时宿主会热加载 patch；否则重启宿主。
- 想临时关掉整条策略，把值设成 `0`。

## 卸载

```bash
dsh plugin --profile web remove dsh-resume-budget
```

它会移除依赖、`dsh.profile.bundles` 里的对应项和该 profile `node_modules` 里的副本。然后**重启宿主**，插件不再被 import。

不会自动消失的东西：

- **你自己在 profile `cordis.patch.yml` 里加的 `- id: resume-budget` 覆盖块**（如果你加过）。pnpm 不管这个文件；留着它每次启动都会打印 `patch: entry "resume-budget" not found` 的警告，手动删掉即可。
- 已经写进会话的压缩检查点。压缩是把历史遮罩/摘要后落盘的，卸载插件不会把旧历史恢复回来。
- profile 目录里的 `*.bak-*` 备份和 pnpm 缓存，按需自行清理。

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `dsh plugin add` 成功，恢复会话却没有任何变化 | 插件只在宿主**启动**时被 import；`add` 只改了 profile 的依赖和组合树，对已经跑着的进程无效 | 完全退出宿主再启动（Web 界面刷新页面不算）。启动后用 `node scripts/check.mjs` 确认行确实在组合树里。 |
| 改了 `lib/*.js`，行为没变 | 已加载的 ESM 模块不会重新求值（模块缓存），`patchReload` 只重载配置 patch，不改代码 | 重启宿主。注意安装方式：`dsh plugin add /abs/path` 是 `link:`，重启就能吃到本地改动；`github:` 安装的是 pnpm 复制到 profile 里的副本，改本仓库不会影响它，需要重新 `add`/更新依赖。 |
| `dsh plugin add` 卡住或失败（`ETIMEDOUT`、`ECONNRESET`、`ERR_PNPM_FETCH_*`、证书错误） | `github:` 规格是交给 pnpm 的，pnpm 需要直连 github.com / codeload 拉 tarball | 给 pnpm/环境配代理（`HTTPS_PROXY`、`HTTP_PROXY` 或 `.npmrc` 的 `proxy`/`https-proxy`）后重试。内网机器可先 `git clone`，再 `dsh plugin --profile web add <本地绝对路径>` 做本地 link 安装；随后跑 `node scripts/dev-link.mjs` 让它能解析 harness 的 `@deepseek-ai/*` 包。 |
| 阈值像是不触发（恢复大会话也没压缩） | 检查只针对**本进程内恢复或 fork 来的会话**，且每个会话只判一次；新建会话、子代理、历史很短的会话永远不会触发。`measure()` 是启发式估算，可能比你估的低。插件不弹 UI 提示，所以“没看到反应”不等于“没生效” | 先 `dsh --profile web --dump-config` 或 `node scripts/check.mjs web <你的阈值>` 确认组合树里的值（patch 的 id 写错会静默保留 100000）。再临时把 `thresholdTokens` 设成 `1` 并重启，恢复一个旧会话：成功压缩后会话里会多出压缩后端写回的检查点（`dsh-compaction-basic` 的 `<compacted-summary>` 块）；若历史太短、后端返回 `null`，则什么也不会发生，这是设计。看到检查点就说明“闸门开了”，看完把阈值改回去。也可以只验证决策分支：`node -e "import('./lib/decision.js').then(({shouldCompactOnResume}) => console.log(shouldCompactOnResume({pending:true,estimatedInputTokens:150000},{thresholdTokens:100000})))"`。 |
| 与 harness 版本不匹配：`dsh` 启动报错，或 `dsh plugin add` 打印 `Plugin … is incompatible with dsh …` | 本包 peers 是 `*`，但宿主 API 可能缺失/改签名（`agent/pre-step`、`ctx.tokenMeter.measure`、`ctx.compaction.compactIfNeeded`）。插件 `inject: ["compaction", "tokenMeter"]`，服务缺一个就挂载不上，通常是静默不生效 | `dsh --version` 对照；升级到 0.2.x（实测 0.2.1-rc.2，含上述两个服务和 `context-overflow` 触发分支）。harness 的兼容性检查不通过时，按提示升级插件；确要试跑可用 `dsh plugin allow-version` 授予精确版本豁免。 |
| `node scripts/check.mjs` 报 `FAIL: no such profile: …` | `DSH_HOME` 或 profile 名不对 | Windows 默认 `%USERPROFILE%\.dsh`，macOS/Linux 是 `~/.dsh`；profile 名必须与安装时用的一致。必要时显式设 `DSH_HOME`。 |
| `WARN: thresholdTokens … not found` 但退出码是 0 | 你在 patch 里改了阈值，却没把新值作为第二个参数传给 `check.mjs`；或 patch 的 `id` 拼错导致覆盖没生效 | `node scripts/check.mjs web <你的值>`；同时看宿主启动日志里有没有 `patch: entry "…" not found`。 |
| Windows 下 `bash scripts/check.sh` 报 `set: pipefail: invalid option name` | Git（`core.autocrlf=true`）把 `.sh` 检出成 CRLF，bash 不认这种行尾 | 用 `node scripts/check.mjs`；或 `git config core.autocrlf false` 后重新检出仓库。 |
| 在自定义 profile（没挂压缩后端或 token meter）里完全不生效 | 插件的 `inject: ["compaction", "tokenMeter"]` 永远等不到服务，宿主不会报错 | 换到带 `dsh-compaction-basic` 的 profile（例如 `web`），或先在该 profile 里启用压缩后端。 |

## 行为

| 情形 | 结果 |
|---|---|
| 会话是**新建**的 | 不检查（`firstLiveSeq` / `firstLifecycleSeq` 为 0，说明本进程内没有恢复来的前缀） |
| 恢复的会话，预计输入 < 阈值 | 不压缩，检查作废 |
| 恢复的会话，预计输入 ≥ 阈值 | 调 `ctx.compaction.compactIfNeeded(agent, "context-overflow", signal)` 先压缩，再发请求 |
| 压缩成功 / 没有可压缩历史 | 检查作废（一次性） |
| 压缩失败或抛错 | **只记 warning，绝不打断回合**；检查保持 pending，下一个 step 重试 |
| 压缩被取消 | 保持 pending（取消不等于同意） |
| 阈值设 0 | 整个策略关闭 |

- 默认阈值 **100000** token（`thresholdTokens`）。
- 每个会话、每个进程生命周期只判一次。
- 子代理的新会话天然不触发。
- 不新增存储、不新增后台任务、**自己不发起任何模型调用**（压缩那一次调用由压缩后端发起，和压力压缩、`/compact` 完全一样）。

## 设计

### 要解决的问题

harness 自带的 `compaction-basic` 有压力压缩：一轮里预计输入超过窗口的某个比例就压缩。但它**在回合进行中**才度量，所以一个 300k token 的会话恢复后，第一发仍然要付 300k —— 那是这个会话一生中最贵的一次请求，而且你正等着它。

这个插件把这一次判断**提前到恢复后的第一个 step**，并且把触发条件从「模型窗口的百分比」换成一个**可以自己设的绝对 token 数**。

### 为什么「有没有可压缩历史」不参与判断

预计输入里混着系统前缀、工具 schema 和历史，插件分不清哪部分能压。唯一有资格回答的是压缩后端本身 —— 它在没有可压缩区间时返回 `null`。在这里猜，要么错过真正的机会，要么为了凑数字去删掉当前请求。

### 度量与压缩都用官方的口子

- 度量：`ctx.tokenMeter.measure(session).totalTokens`（和压力压缩同一套，不传 request header）。
- 压缩：`ctx.compaction.compactIfNeeded(agent, "context-overflow", signal)`。

**为什么不是 `compactNow()`。** 它是 `/compact` 那个显式入口，把工作包在 `agent.runMaintenance` 里 —— 而 `runMaintenance` **要求 agent 空闲**，回合进行中会直接抛 `manual compaction requires an idle agent with no waking queued work`。`agent/pre-step` 恰好就是回合进行中的状态，所以那个入口在这里**必然失败**（实测踩到的坑，不是推测）。

`"context-overflow"` 是官方压力压缩**在同一个接缝上**用的分支：先跑 tool-result 剪枝，再选出可压缩区间，走同一条 `compactRegion` 路径 —— 不用 `runMaintenance`，也不会拿窗口比例阈值覆盖本插件自己的绝对阈值。

### 证据边界

- 阈值是**触发线**，不是服务商的精确 tokenizer 结果，也不是绝对的请求上限；`measure()` 是启发式估算。
- 本插件不声称能定位恢复开销的根因，也不保证省下具体多少钱 —— 它只保证「超过这条线时先压缩」这件事发生一次。
- 单测覆盖：`node --test`（决策分支 + 接线流程，全部用假 ctx，不调用真实模型）。

## 开发

从仓库里跑测试前，先把它 import 的 harness 包链进本地 `node_modules`（否则 `import "@deepseek-ai/schemastery"` 解析失败，`npm test` 会挂）：

```bash
node scripts/dev-link.mjs        # macOS/Linux 也可以 bash scripts/dev-link.sh
npm test                         # node --test，22 个用例
npm run check -- web 100000      # 等价于 node scripts/check.mjs web 100000
```

`dev-link.mjs` 会从小到大依次尝试 `dsh` 包旁边的 `@deepseek-ai` 目录、其父目录、npm 前缀的 `node_modules`，也可以显式传目录或设 `DSH_PACKAGE_DIR`。它只在**本地 link 安装**时才有必要，正常的 `github:` 安装不需要。

## 相关插件

同一作者维护的 DSH 插件：

- [dsh-browser](https://github.com/xingzoudefengye/dsh-browser)
- [dsh-web-search-failover](https://github.com/xingzoudefengye/dsh-web-search-failover)
- [dsh-compaction-local-handoff](https://github.com/xingzoudefengye/dsh-compaction-local-handoff)
- [dsh-project-memory](https://github.com/xingzoudefengye/dsh-project-memory)
- [dsh-session-recall](https://github.com/xingzoudefengye/dsh-session-recall)

## 许可

[MIT](./LICENSE)。
