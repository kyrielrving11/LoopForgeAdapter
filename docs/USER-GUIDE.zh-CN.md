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
  已记录的原生验收基线是 LoopForge 4.0.7；其他 LoopForge 版本需要单独验收。
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

模型判断轮次事实只依据 LoopForge 当前提示词和实时 MCP schema。结构化
metadata 留在适配器的易失路由路径中；模型只接收固定的宿主边界说明，
不包含轮次 ID、提交句柄、guidance 或动态边界原因。

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| `restart`，默认 | 确认旧进程退出，再开新 Claude 进程与会话 | 优先使用直接的进程隔离 |
| `reuse` | 确认原生 `/clear` 的旧会话结束和新会话开始，复用宿主与 MCP 连接 | 减少重复启动宿主与工具服务 |

`reuse` 未确认清理成功时，会先确认宿主退出，再走重启路径；无法
确认退出则拒绝继续投递下一轮。MCP 服务仍可能自行断线或重置，
进程复用不等于模型上下文、技能正文或供应商 KV 缓存复用。

两种模式都还需要当前会话的 `UserPromptSubmit` hook 确认提示词
哈希完全一致，才会宣告调用就绪并开放工具。比较不去除空格，也不
转换换行；缺失、不一致或超时都会阻止继续。reuse 可在确认宿主退出
后走重启路径。哈希只保存在内存，不写入 LoopForge 历史；它证明
hook 观察到了完整输入，不代表供应商已接收或模型已理解。

LoopForge 的 `same_round_retry` 在原会话内投递；`fresh_invocation`
才要求新会话。新会话也可能仍是同一个逻辑轮次，不可用会话数推算轮次。

## 4. 暂停和恢复

启动后会打印 `LoopForge loop: <id>`，请记录此 ID。按 Ctrl+C 请求
停止宿主并暂停 LoopForge，以终端返回的暂停结果为准。
Claude 一次回答结束不代表 LoopForge 轮次完成。当前调用收到原生
`Stop` 或 `StopFailure`，而轮次仍未提交时，交互终端会显示提示并允许
你继续输入；没有交互终端的运行会停止宿主、请求暂停，并以退出码 1
返回。适配器不自动续写、提交或推进轮次。API 的重试仍由 Claude
控制，`StopFailure` 在宿主结束重试后才会触发。
稍后在相同工作区恢复：

```powershell
loopforge-adapter resume --workspace "C:\work\my-project" --loop-id loop-... --claude-runtime reuse
```

如果启动时用了 `--loopforge-cli`、`--mcp-config` 或 `--capability-file`，恢复时也需传入。
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

### 固定能力背景（可选）

对任务中反复需要的少量技能说明或工具文档，可显式指定原始文件：

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --task "实现所需功能" --claude-runtime reuse --capability-file "C:\skills\review\SKILL.md" --capability-file "C:\tools\usage.md"
```

`--capability-file` 可重复，支持 start、resume 和精确 JSON 输入；相对路径
以启动适配器时的目录为准，不以 `--workspace` 为准。按配置顺序提供原文，
指向同一源路径的条目只提供一次。默认不预加载任何文件，未选技能仍走
普通的原生加载。应选择静态能力说明，不要传入上轮报告、工具结果或另一份任务计划。

适配器通过 Claude 原生的
[`--append-system-prompt-file`](https://code.claude.com/docs/en/cli-reference)
提供完整原文、源路径和内容哈希。合计上限为 **64 KiB UTF-8 字节**，包含
来源标记；文件缺失、空白、非法编码、含 NUL 或超限都会报错，不会静默
丢弃或截断。临时文件只是派生的启动快照，确认宿主退出后清理，不修改
原始文件，也不建立记忆库或工作 profile。

每次 `fresh_invocation` 前重读源文件指纹。未变化可继续 `/clear` 复用；
内容变化或不可读时，即使配置 reuse，也先确认旧宿主退出，再从当前原文
启动新宿主。文件仍无效则不启动下一调用。当前调用中的编辑不会立即改变
已加载背景，适配器也不会因此自行制造轮次或刷新边界。

原生验收已覆盖 restart 和 reuse：新会话的首次模型请求包含完整选定原文，
不含上轮提示、动态 LoopForge metadata 和动态工具结果。在受控测试里，无需额外调用 Skill/Read
来恢复这些资料；真实模型仍可能主动重读。预加载 `SKILL.md` 仅提供资料，
不等于原生技能激活；权限、hooks、配套文件和显式技能调用仍服从 Claude
的实时接口。文档内相对引用不重写，工具参数仍以实时 schema 为准。

这项功能让每轮开始时资料已经可见，仍然占用每轮上下文。它不证明模型
保留了理解、隐含习惯或供应商 KV 缓存，也不承诺 token、耗时和任务质量收益；
这些需要另行实测。

### 普通技能与宿主设置

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
| `--capability-file FILE` | 显式预加载 UTF-8 能力原文，可重复；渲染后合计不超过 64 KiB |
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

`Claude submitted prompt does not match` 或提示词交付确认超时，表示
待交付输入没有得到确认。不要留在该会话里继续，也不要通过手工
删改提示词绕过比较，应使用重启或 LoopForge 恢复路径。
`same_round_retry` 仍按普通 MCP 工具结果投递，不属于启动提示词回执的范围。
