# dsh-resume-budget

Resume 会话的**输入预算闸门**：恢复一个长会话后，第一个请求不再无脑把整段历史重发一遍 —— 超过阈值就先压缩，再发。

## 它解决什么

harness 自带的 `compaction-basic` 有压力压缩：一轮里预计输入超过窗口的某个比例就压缩。但它**在回合进行中**才度量，所以一个 300k token 的会话恢复后，第一发仍然要付 300k —— 那是这个会话一生中最贵的一次请求，而且你正等着它。

这个插件把这一次判断**提前到恢复后的第一个 step**，并且把触发条件从「模型窗口的百分比」换成一个**可以自己设的绝对 token 数**。

## 行为

| 情形 | 结果 |
|---|---|
| 会话是**新建**的 | 不检查（`firstLiveSeq` 为 0，说明本进程内没有恢复来的前缀） |
| 恢复的会话，预计输入 < 阈值 | 不压缩，检查作废 |
| 恢复的会话，预计输入 ≥ 阈值 | 调 `ctx.compaction.compactIfNeeded(agent, "context-overflow", signal)` 先压缩，再发请求 |
| 压缩成功 / 没有可压缩历史 | 检查作废（一次性） |
| 压缩失败或抛错 | **只记 warning，绝不打断回合**；检查保持 pending，下一个 step 重试 |
| 压缩被取消 | 保持 pending（取消不等于同意） |
| 阈值设 0 | 整个策略关闭 |

- 默认阈值 **100000** token（`thresholdTokens`）。
- 每个会话、每个进程生命周期只判一次。
- 子代理的新会话天然不触发。

## 为什么「有没有可压缩历史」不参与判断

预计输入里混着系统前缀、工具 schema 和历史，插件分不清哪部分能压。唯一有资格回答的是压缩后端本身 —— 它在没有可压缩区间时返回 `null`。在这里猜，要么错过真正的机会，要么为了凑数字去删掉当前请求。

## 度量与压缩都用官方的口子

- 度量：`ctx.tokenMeter.measure(session).totalTokens`（和压力压缩同一套，不传 request header）。
- 压缩：`ctx.compaction.compactIfNeeded(agent, "context-overflow", signal)`。

**为什么不是 `compactNow()`。** 它是 `/compact` 那个显式入口，把工作包在 `agent.runMaintenance` 里 —— 而 `runMaintenance` **要求 agent 空闲**，回合进行中会直接抛 `manual compaction requires an idle agent with no waking queued work`。`agent/pre-step` 恰好就是回合进行中的状态，所以那个入口在这里**必然失败**（实测踩到的坑，不是推测）。

`"context-overflow"` 是官方压力压缩**在同一个接缝上**用的分支：先跑 tool-result 剪枝，再选出可压缩区间，走同一条 `compactRegion` 路径 —— 不用 `runMaintenance`，也不会拿窗口比例阈值覆盖本插件自己的绝对阈值。

所以它不新增存储、不新增后台任务、**自己不发起任何模型调用**（压缩那一次调用由压缩后端发起，和压力压缩、`/compact` 完全一样）。

## 挂载

```yaml
- insert:
    - id: resume-budget
      name: 'dsh-resume-budget'
      config:
        thresholdTokens: 100000
```

验证：

```bash
scripts/check.sh web 100000
```

## 安装

```bash
dsh plugin --profile web add github:xingzoudefengye/dsh-resume-budget
```

## 证据边界

- 阈值是**触发线**，不是服务商的精确 tokenizer 结果，也不是绝对的请求上限；`measure()` 是启发式估算。
- 本插件不声称能定位恢复开销的根因，也不保证省下具体多少钱 —— 它只保证「超过这条线时先压缩」这件事发生一次。
- 单测覆盖：`node --test`（决策分支 + 接线流程，全部用假 ctx，不调用真实模型）。

## 许可

MIT。
