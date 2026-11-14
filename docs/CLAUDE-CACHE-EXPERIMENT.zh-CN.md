# Claude Code 干净会话与前缀计算复用实验

2026-11-13，北京时间；Windows、Node.js 24.16.0、Claude Code 2.1.323、
DeepSeek 官方 Anthropic 接口，模型配置 `deepseek-flash[1m]`。

## 结论

**本次实测可以同时保留干净的任务会话和公共前缀的计算缓存，但当前生产
驱动尚未包含实验里的服务侧用户标识适配。** 只预加载能力文件不够：
Claude 的会话元数据与 DeepSeek 的缓存隔离规则之间存在具体的集成问题。

实验以现有 Claude 驱动运行三个原生会话，使用 `/clear` 切换，复用一个
宿主进程。新请求包含固定合成能力资料，不含之前轮次的合成标记。模型
只能调用一个无工作区副作用的合成提交工具；没有真实 LoopForge Vault、
任务历史或实际业务数据参与。真实服务请求使用本地已有环境密钥。

## 实测结果

最后一组比较保持系统提示与工具定义一致，并在轮次间等待 6 秒，让异步
缓存有落盘机会。两组均通过官方环境变量关闭 attribution；实验干预仅为
同一运行固定服务侧的 `metadata.user_id`。

| 方式 | 原生会话 | 未命中输入 token | 命中输入 token | 输入命中比例 |
| --- | --- | ---: | ---: | ---: |
| 原样转发 Claude 用户标识 | 1 | 8,828 | 0 | 0% |
| 原样转发 Claude 用户标识 | 2 | 8,997 | 0 | 0% |
| 原样转发 Claude 用户标识 | 3 | 8,997 | 0 | 0% |
| 固定本次运行的服务侧用户标识 | 1 | 8,828 | 0 | 0% |
| 固定本次运行的服务侧用户标识 | 2 | 677 | 8,320 | 92.5% |
| 固定本次运行的服务侧用户标识 | 3 | 549 | 8,448 | 93.9% |

数字来自服务端最终 `message_delta.usage`，没有把 `message_start` 的初始
用量累加进去。DeepSeek 的 `input_tokens` 不包含命中量；本次总输入为
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，
其中 creation 恒为 0。命中率以总输入为分母，不能把它解释成总费用下降率。

另有直接 API 对照：4,546 个输入 token 的同一请求，首次 0 命中；间隔
6 秒后完全重复请求，命中 4,352、未命中 194。随后改变短问题、保留前缀，
仍得到同样命中量。这排除了“当时服务完全没有缓存”的解释。

## 已定位的问题

1. Claude 在 `metadata.user_id` 中提供包含 `device_id`、`account_uuid`、
   `session_id` 的 JSON 字符串。实测每次清空后该值变化。DeepSeek 官方
   [限速与隔离文档](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit)
   明确以 `user_id` 隔离 KVCache；其 Anthropic 接口从 `metadata.user_id`
   读取此值。因此，新原生会话也切到了不同的服务端缓存隔离域。
2. 系统提示开头的 attribution 含对话相关指纹，本机首次 `/clear` 后发生
   变化。官方开关 `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 可移除该块；实测关闭
   后三个新会话的系统提示完全一致。只关闭它仍然 0 命中，因此它不是唯一原因。
3. 固定系统原文和工具定义后，动态轮次提示、提交元数据仍在当前调用中。
   它们不需要相同；缓存复用的是实际匹配的公共前缀。DeepSeek 忽略
   Anthropic `cache_control`，使用自身自动缓存机制，不能靠添加该字段强制命中。

实验中的固定 ID 是每组随机生成、仅属于该组合成运行的标识，没有把
不同真实用户合并。原生会话 ID 仍由 Claude 正常改变；输入内容没有被
摘要、重排或删除。实验转发层也没有实现本地响应缓存。

## 能证明与不能证明的范围

这证明了**在本次宿主和供应商组合上，干净任务会话与公共前缀计算复用
可以共存**。重复传输全文不必等于重复执行全部 prefill，但文本仍占用
上下文容量，网络传输仍存在，缓存命中输入也仍可能计费。

这没有证明任意技能调用或工具输出都能单独保留。Claude 官方说明，技能
展开在调用位置加入对话消息；普通缓存按完整前缀匹配，没有按文件或
任意片段独立复用的保证。夹在旧任务历史中的技能资料，其计算状态不能
直接从前缀中抽出。固定能力原文预加载和已经展开的技能历史是不同路径。

实验样本很小，参考资料是合成文本，未评估复杂任务效果、上下文容量收益
或稳定的耗时下降。记录的首字节时间可能包含 SSE 保活，不能当作首 token
时延。6 秒等待是为了观察异步缓存的实验条件，不是生产轮次需要的延迟，
也不应把人为等待从整体耗时中忽略后声称提速。

一次试验因真实模型产生额外请求而未通过“恰好三个请求”的过严断言，
修正实验为按当前轮次标记核对、最多允许四个请求后完成最终对照。失败
试验不作为收益证据；最终表格来自完整通过的独立一组，每轮一次请求。

## 对适配器的实施含义

当前生产路径保持不变，`providerCacheTelemetry` 仍为 false。测量转发层
只存在于独立 `experiments/`，普通 start/resume 不会修改模型请求的用户标识。

若产品化，应单独提供显式启用的 DeepSeek 传输集成：同一实际用户、同一
运行使用稳定且不含隐私信息的服务侧标识，原生会话仍正常刷新。不得使用
所有用户共享的固定常量，不得把不同账号或租户合并；上下文正确性不能
依赖缓存命中。缓存域标识只是传输配置，无需成为 LoopForge 字段、历史、
profile 或任务进度。进程重启后冷缓存可以接受，不应因此引入另一份持久
事实源。供应商特有的 identity 与用量规则也不能伪装成通用宿主能力。

目前检查的公开 CLI 和环境变量文档没有提供直接固定请求
`metadata.user_id` 的配置。因此本次采用实验转发层；不能冒称一个原生
开关已经解决了问题。正式集成还需覆盖端点认证、请求限制、流式转发、
异常取消、退出清理，以及原生干净边界与工具归属的回归测试。

后续已执行[真实编码与工具调用实验](./CLAUDE-WORKLOAD-EXPERIMENT.zh-CN.md)，
包含没有人工等待的跨轮命中、真实代码检查，以及一次完整保留的超时样本。
实际短背景的命中比例低于上面的长合成背景，仍不能宣称普遍的任务收益。

## 复现与证据

从源码目录运行。默认命令仅使用本地脚本响应，不调用真实模型：

```powershell
npm run probe:claude-cache
npm run probe:claude-cache -- --compare-identity
```

显式 `--live` 使用当前环境中的官方 DeepSeek 地址和密钥，产生真实 API
用量；每次 native 对照最多两组、每组四个请求，每个请求输出上限 256。
只允许 `deepseek-flash` 与官方 HTTPS Anthropic 端点。

```powershell
npm run probe:claude-cache -- --live --compare-identity --output cache-probe.json
npm run probe:claude-cache -- --live --direct-control --output cache-control.json
```

独立源码：[claude-cache-probe.ts](../experiments/claude-cache-probe.ts)。
本次观测：[结构化结果](../experiments/results/claude-deepseek-cache-2026-11-13.json)。
结果只保留计数、时间、内容和标识哈希；没有密钥、请求正文、响应正文或
Claude 对话记录。实验不进入 npm 包的运行产物，需从源码执行。

官方依据：

- [Claude Code 前缀缓存、技能加载与缓存位置](https://code.claude.com/docs/en/prompt-caching)
- [Claude attribution 的行为和关闭方式](https://code.claude.com/docs/en/llm-gateway-protocol#system-prompt-attribution-block)
- [DeepSeek 用户与 KVCache 隔离](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit)
- [DeepSeek Anthropic 兼容规则和流式用量](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)
- [DeepSeek 自动缓存与落盘规则](https://api-docs.deepseek.com/zh-cn/guides/kv_cache)
