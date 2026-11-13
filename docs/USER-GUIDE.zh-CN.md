# LoopForge Adapter 用户说明书

适配器是独立于 LoopForge 的本地项目，目前只实现 Claude Code 宿主。
它把 LoopForge 返回的上下文边界落实为真实的 Claude 会话切换。
LoopForge 提供已提交事实与当前轮信息，Agent 负责判断和行动；适配器
只管理宿主生命周期、传输和执行归属，不另建记忆库或工作 profile。

## 1. 准备环境

- Node.js >=18，以及支持交互的本地终端。
- 已完整安装的 Claude Code >=2.1.323。驱动会检查版本和所需参数；
  升级后仍需重新验收，不能仅凭版本号保证兼容。
- 单独安装的 LoopForge，或已构建的源码入口 `loopforge/dist/cli.js`。
  当前验收基线是 LoopForge 4.0.7。
- 在目标工作区先直接运行 `claude`，完成认证、模型配置及工作区信任。

当前真实宿主验收环境是 Windows、Node.js 24.16.0、Claude Code
2.1.323。Linux/macOS 和其他版本尚未经过同等验收。
交互终端依赖 `node-pty`；Windows 使用 ConPTY。

模型服务沿用 Claude Code 的环境配置。DeepSeek 用户按
[官方接入说明](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code)
设置地址、密钥与模型；在同一个已配置环境的终端启动适配器即可。
适配器不自动读取 `.env`，不把模型密钥写入自己的持久化存储。
不要把真实密钥写进版本库、示例或提交的 MCP 配置。

## 2. 从源码安装

下载源码后进入本项目目录执行：

```powershell
git clone https://github.com/kyrielrving11/LoopForgeAdapter.git
cd LoopForgeAdapter
npm ci
npm test
node dist/src/cli.js help
```

`npm test` 会先清理旧 `dist` 并构建，再运行单元测试。只构建可用
`npm run build`。`node_modules/` 和 `dist/` 不需要上传 GitHub。
如果 npm 策略拦截了依赖安装脚本，需按本机 npm 的规则允许
`node-pty` 安装；不能在原生依赖未安装成功时声称宿主可用。

构建后可选安装全局命令：

```powershell
npm install -g .
loopforge-adapter help
```

尚未全局安装时，把后文命令的 `loopforge-adapter` 换成
`node dist/src/cli.js`，并在本项目目录执行即可。
本文不假设适配器已经发布到 npm。

## 3. 启动任务

LoopForge 已安装时：

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --task "实现所需功能" --claude-runtime reuse
```

使用单独的 LoopForge 源码入口时：

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --loopforge-cli "C:\work\LoopForge\loopforge\dist\cli.js" --task "实现所需功能" --claude-runtime reuse
```

工作区必须存在。适配器与 LoopForge MCP 均使用该工作区；切换会话
不会撤销或清理其中的修改。适配器不会决定完成条件，也不会代替
Agent 编写轮次提交。LoopForge 字段含义以其实时工具 schema、提示词
和 `submission_guidance` 为准。

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| `restart`，默认 | 确认旧进程退出，再开新 Claude 进程与会话 | 优先使用直接的进程隔离 |
| `reuse` | 确认原生 `/clear` 的旧会话结束和新会话开始，复用宿主与 MCP 连接 | 减少重复启动宿主与工具服务 |

`reuse` 未确认清理成功时，会先确认宿主退出，再走重启路径；无法
确认退出则拒绝继续投递下一轮。MCP 服务仍可能自行断线或重置，
进程复用不等于模型上下文、技能正文或供应商 KV 缓存复用。

LoopForge 的 `same_round_retry` 在原会话内投递；`fresh_invocation`
才要求新会话。新会话也可能仍是同一个逻辑轮次，不可用会话数推算轮次。

## 4. 暂停和恢复

启动后会打印 `LoopForge loop: <id>`，请记录此 ID。按 Ctrl+C 请求
停止宿主并暂停 LoopForge，以终端返回的暂停结果为准。
稍后在相同工作区恢复：

```powershell
loopforge-adapter resume --workspace "C:\work\my-project" --loop-id loop-... --claude-runtime reuse
```

如果启动时用了 `--loopforge-cli` 或 `--mcp-config`，恢复时也需传入。
CLI 默认向 LoopForge 声明 `invocationLost: true`，由 LoopForge
重建当前轮的干净调用。它不会从 Claude 的历史对话恢复，也不需要
适配器状态文件。意外退出后的会话占用、租约和恢复资格仍由 LoopForge
判断；不要手改 Vault 或制造新的轮次绕过它。

## 5. 接入其他 MCP 服务

通过 `--mcp-config` 显式提供 Claude MCP 配置。例如准备
`mcp.json`，把路径替换为实际的 MCP 服务入口：

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "node",
      "args": ["C:/tools/my-mcp-server/dist/index.js"]
    }
  }
}
```

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --task "实现所需功能" --mcp-config "C:\work\mcp.json" --claude-runtime reuse
```

适配器生成临时副本并加入私有 LoopForge bridge，不改原文件，也无需
在 Claude 中另外注册 LoopForge。`loopforge-adapter` 是保留的 MCP
服务名，不要用它命名其他服务。用户、项目和插件原有的 MCP 注册
不会自动载入；需要的服务放进显式配置。相对脚本路径不自动重定位，
建议使用绝对路径。

## 6. 技能、配置与保留范围

用户和工作区 `.claude/skills` 的直接子技能目录以源目录链接方式
提供，调用名为 `loopforge-static:<技能名>`，同名时工作区优先。
启用插件的常规本地缓存中若包含技能，调用名保留为
`<插件名>:<技能名>`。不会激活原插件的运行时代码、顶层 hooks、
MCP 或自定义 agents。这里只保留技能可用性，不承诺下一会话还记得
上轮调用技能时展开的正文或使用经验。选择和调用技能仍由 Agent 决定。

插件技能只支持约定的缓存布局，缓存版本按目录字符串倒序选取，
不是完整复现 Claude 的插件安装注册表。祖先/嵌套技能发现、任意插件
位置和自定义 agent 不在当前加载范围。技能本身的 frontmatter、
配套脚本和显式调用行为保留，不能理解成对所有技能行为进行了净化。

启动时仅导入环境、模型、权限、沙箱及认证 helper 等运行配置；
源配置中的 hooks、自动记忆和输出风格不导入。后台任务、cron、
workflows 等通道被关闭；提交前需等待前台工具和子 Agent 结束，
子 Agent 不能调用 LoopForge 治理工具。

干净上下文不是空工作区，也不是操作系统沙箱。静态 `CLAUDE.md`、
技能、文件仍可能可用；Agent 主动读取旧文件、外部服务返回自己的
记忆、任意脱离宿主的进程或远程任务不由此边界保证。检测到 managed
配置会拒绝运行；其他企业策略也未认证。详细规则见
[宿主集成范围](./HOST-INTEGRATION.md)。

## 7. CLI 参数速查

使用 `loopforge-adapter help` 或根命令 `--help`；不支持 `start --help`。

| 参数 | 说明 |
| --- | --- |
| `--workspace DIR` | 目标工作区，默认当前目录 |
| `--claude-runtime restart\|reuse` | 宿主模式，默认 restart |
| `--mcp-config FILE` | 显式的普通 MCP 服务配置 |
| `--loopforge-cli FILE` | 使用指定 LoopForge `dist/cli.js` |
| `--loopforge-command COMMAND`、`--loopforge-arg ARG` | 自定义 LoopForge 启动命令及可重复前缀参数；与 CLI 入口方式择一使用 |
| `--input-json JSON`、`--input-file FILE` | 原样传给 start/resume 的对象，二选一 |
| `--task TEXT` | start 简便输入 |
| `--loop-id ID` | start/resume 简便输入 |
| `--max-rounds N`、`--plan-source FILE` | start 简便输入 |
| `--constraint TEXT`、`--criterion TEXT` | start 简便输入，可重复 |
| `--invocation-lost`、`--current-user-instruction TEXT` | resume 简便输入 |

精确 JSON 输入不能与简便输入参数混用，但可与工作区、宿主、MCP
和 LoopForge 启动参数搭配。复杂配置优先写入 JSON 文件，例如
`{"task":"实现所需功能","maxRounds":5}`，然后使用：

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --input-file "C:\work\start.json"
```

## 8. 验证与排查

按[贡献与发布检查](./RELEASE-CHECKLIST.md)执行单元测试、真实
LoopForge MCP 测试及可选的原生 Claude 会话验收。原生验收使用本地
脚本 API 响应，不消耗真实模型密钥；它验证边界，不评估模型任务能力。

`Automatic boundary mode is unavailable` 表示宿主版本、参数、原生
PTY 或编译文件未满足要求；先检查 `claude --version`、安装是否完整
以及是否构建。`LoopForge was not found` 可用 `--loopforge-cli`
指定真实入口。managed 或 bare/safe mode 的错误不能通过忽略诊断解决。

`session confirmation timed out` 或退出未确认时，不要把“看起来已经
清屏”视为成功，先检查宿主和终端诊断，再通过 LoopForge 恢复。
Windows 上 `node-pty` 释放控制台时可能打印 `AttachConsole failed`；
验收中曾出现该提示但退出已确认且测试通过。真正缺少退出确认仍是失败。
