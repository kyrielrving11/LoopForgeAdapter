# 实验记录索引

本目录下的真实模型记录用于保留具体运行证据，不是生产保证，也不代表
实验结果可以跨模型、版本、提示词或任务直接推广。

## 运行报告

- [Claude / DeepSeek 缓存身份实验](./CLAUDE-CACHE-EXPERIMENT.zh-CN.md)：
  比较新 Claude 会话下的 DeepSeek 前缀缓存隔离行为。
- [Claude 编码工作负载实验](./CLAUDE-WORKLOAD-EXPERIMENT.zh-CN.md)：
  记录真实模型跨干净会话完成三轮 TypeScript 工作及失败样本。
- [Claude 任务可靠性诊断](./CLAUDE-RELIABILITY.zh-CN.md)：
  记录未提交即结束、MCP 参数错误和真实模型错误恢复的证据。
- [长任务对照实验方案](./LONG-RUN-EVALUATION.zh-CN.md)：
  记录 LoopForge 4.1.0 兼容性回归、夹具重冻结和三对真实运行结果；
  结果仍不足以支持宿主复用或连续性结论。

原始结构化记录保存在 [`experiments/results/`](../experiments/results/)。
实验转发器、任务夹具和结果采集代码位于 [`experiments/`](../experiments/)。

## 版本边界

缓存、工作负载和可靠性报告中的真实运行日期为 **2026-11-13**。这些
运行早于固定 SessionStart host-context 投影，因此不能用来证明当前版本
模型看到的 metadata 边界或当前版本的缓存行为。它们仍是各自运行的历史
证据；相关报告保留了设置、观察项、失败和复现命令。

报告中的稳定缓存身份是实验代理层的干预，不是正式适配器功能。当前生产
启动不会覆写 provider identity，也不采集 provider cache telemetry。不要
把缓存命中解释为旧技能、工具输出或对话状态已跨轮保留。
