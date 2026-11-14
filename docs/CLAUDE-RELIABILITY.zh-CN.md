# Claude 任务执行故障定位与修复

2026-11-13；Windows、Node.js 24.16.0、Claude Code 2.1.323。
只操作独立适配器和临时目录，未构建、修改或连接主 LoopForge。
以下测试中的轮次与暂停由隔离夹具提供，不是真实 LoopForge Vault 验收。

## 已确认的缺陷

这里有两个不同问题：检查工具执行失败，以及失败后程序仍等待。
缓存命中只描述服务端计算复用，不能解决其中任何一个问题。

| 缺陷 | 证据 | 修复 |
| --- | --- | --- |
| 最初的实验 MCP 参数检查直接抛异常，导致服务进程退出 | 恢复旧处理方式，发送 `round: 9`，记录到 argument-error、fatal、exit；Claude 收到 `Connection closed`，随后提示工具已断连；没有执行任何 check | 独立的 TypeScript 夹具校验参数，返回 `isError` 和明确的“未执行检查”；同一 MCP 进程仍可处理修正调用 |
| 适配器只等待进程退出，Claude 回答结束后宿主仍存活 | 本地端点返回一次 `end_turn`，旧设计没有可供驱动消费的回答结束事件；历史超时记录最后一次也是 end_turn | 当前主会话的 `Stop`、`StopFailure` 投射为无正文的 `turn_ended`；无人值守 CLI 停止宿主并请求暂停，返回 1；交互终端保留人工输入 |
| CLI 主入口忽略 `run()` 的返回码 | 新增完整 CLI 测试首次得到退出码 0，而该路径返回值为 1 | 主入口将返回值赋给 `process.exitCode`；完整 CLI 测试验证真实退出码及恰好一次暂停 |

第一项属于**实验服务**，不是生产适配器替外部 MCP 修复参数或重启服务。
后两项属于**正式适配器**。生产适配器仍不解释工具输出的含义、不重复
外部写操作、不修改提示内容，也不自动创建评价或提交。

## 关于最初的 181 秒失败

保留的旧证据只有工具名称、token 用量和服务启动/fixture 记录，没有
该次 check 的输入、错误回复或服务退出记录；临时配置及 transcript
也已清理。因此**不能唯一证明该次失败由非法参数触发**。

本次复现证明了旧处理器确实存在一条“服务退出 → 工具断连 → 重试无效”
路径，并修复和回归验证了它；没有把故障注入当成那次历史调用的还原。
该次最后已有 `end_turn`，而测试仍等到总超时，这一等待机制缺口可以直接
从旧记录与旧实现确认。补充后的基线运行通过也不等于解释了旧失败。

现在实验记录包含按工具调用 ID 哈希对应的错误、MCP 接收与检查事件、
服务退出状态。成功工具正文不写入新诊断报告；失败只留经脱敏且有长度
上限的片段。来源身份保留哈希，密钥与完整请求/响应不落盘。
这些只是实验结果，不参与正式运行，不形成运行历史或模型记忆库。

## 验证结果

- 有诊断的真实基线：三轮通过，15 请求，38.1 秒。
- 旧服务受控崩溃：约 8.6 秒内明确失败，零 check；保存断连错误与 fatal
  记录，没有等待到 180 秒，也没有把失败写成通过。
- 修复后相同的 `round: 9`：Claude 收到参数错误，脚本响应随后提供正确
  参数；同一个 MCP 进程完成三轮检查，约 10.6 秒。
- 真实 DeepSeek 注入一次 check 工具错误：模型自行发起第二次 check，
  然后完成三轮独立检查；15 请求，约 34.3 秒；宿主和普通 MCP 各一个，
  原生会话三个，第二、三轮首次请求仍有 3,072 和 3,200 token 缓存命中。
- 真实 Claude、脚本端点只返回文本：一次请求，约 3.6 秒内报告
  “回答结束但未提交”，零 check、零轮次推进。

真实模型没有收到篡改过的工具参数或改写后的回答。非法参数实验使用本地
脚本端点；真实模型实验只由 MCP 在第一次有效 check 上返回一次明确的
错误，检查本身尚未执行，后续重试由模型决定。提交还校验验收脚本未被
改写，并核对当前源文件哈希与最近通过检查时一致。

普通测试覆盖生命周期事件的当前会话归属、子 Agent 与陈旧事件隔离、
Stop 不清除在途工具、参数错误不产生检查事实。原生 CLI 验证覆盖未提交
的文本结束、HTTP 400、HTTP 401 后暂停且返回非零，以及原有清空/重启、
技能/工具/前台子 Agent 隔离。
本次 59 项普通测试和 8 项原生验证通过，无跳过；原生验证使用本地
脚本端点，真实模型错误恢复另见上述 DeepSeek 实验。

HTTP 401 最初的短测试超时另有明确原因：Claude 默认会做最多 10 次 API
重试，当时仍在原生退避中，尚未触发 `StopFailure`。按
[官方环境变量文档](https://code.claude.com/docs/en/env-vars#claude-code-max-retries)
在测试子进程设 `CLAUDE_CODE_MAX_RETRIES=0`，使测试只验最终失败通知。
正式启动不覆盖用户的重试策略。不能把尚在重试的请求称为已结束，也不能
把新的 Stop 监听宣称成所有网络停顿或进程卡死的看门狗。

## 复现

```powershell
npm test
$env:CLAUDE_RUNTIME_E2E = '1'
node --test dist/test/e2e/claude-reliability.test.js dist/test/e2e/claude-runtime.test.js

# 以下两个预期返回非零，分别验证服务死亡、未提交即结束。
npm run probe:claude-workload -- --stable-only --fault legacy-crash
npm run probe:claude-workload -- --stable-only --fault end-turn

# 同样的非法参数经修复后可在原进程内纠正。
npm run probe:claude-workload -- --stable-only --fault invalid-round

# 使用已有环境密钥，真实模型只遇到一次明确的工具错误。
npm run probe:claude-workload -- --live --stable-only --fault check-error --output-dir experiments/results/my-reliability-run
```

证据：

- [真实基线](../experiments/results/reliability-baseline-2026-11-13/stable-user.json)
- [旧服务崩溃](../experiments/results/reliability-legacy-crash-2026-11-13/stable-user.json)
- [非法参数纠正](../experiments/results/reliability-invalid-round-2026-11-13/stable-user.json)
- [真实模型错误恢复](../experiments/results/reliability-live-check-error-2026-11-13/stable-user.json)
- [未提交即结束](../experiments/results/reliability-end-turn-2026-11-13/stable-user.json)

原始成功、失败样本继续保留于[编码实验记录](./CLAUDE-WORKLOAD-EXPERIMENT.zh-CN.md)。
