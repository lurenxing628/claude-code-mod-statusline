# Claude Code Mod 状态栏

给 Claude Code 换一个两行的状态栏，显示在输入框和权限模式行之间，每秒刷新：

```
Opus 5.5 xhigh   丨   上下文 161k ███░░░░░░░░┃567k░░░░░ 1M   丨   改动 3 文件      +82  −40 行   丨   项目 dev   丨   5h  7%    ↻   45m
费用    $73.24   丨   输入 2.1M    输出 26.4k    TPS 117.1   丨   活跃  4m09s      缓存 93.60%   丨   分支 main  丨   周 61%    ↻ 3d11h
```

第一行是“工作”：模型、上下文、改动、项目、5 小时限额；第二行是“消耗”：费用、token、速度、活跃时间和缓存、分支、周限额。数值都按含义上色，同一列上下两格左右两端对齐。

## 各项的统计口径

| 项 | 内容 |
| --- | --- |
| 模型 | 模型名、思考强度（low → max 由绿到红）、开了 fast 模式时显示 `⚡fast` |
| 上下文 | 当前上下文 token、进度条、窗口大小；橙色 `┃567k` 是自动压缩阈值及其数值。填充色按“已用 ÷ 压缩阈值”分绿/黄/红。首次响应前显示本地估算值（带 `~`） |
| 改动 | Edit（界面上显示为 Update）和 Write 改过的文件数、增删行数，subagent 的也算；用 Bash 命令改的文件不计 |
| 项目 / 分支 | 项目目录名；分支读 `.git/HEAD`，支持 worktree，游离 HEAD 显示短哈希 |
| 5h / 周 | 订阅限额的用量（整数，向下取整，100% 才表示用完）和重置倒计时；用 API key 时不显示 |
| 费用 | 本会话累计费用（Claude Code 自己的统计） |
| 输入 / 输出 | 本会话所有请求累计，含 subagent；输入 = 未缓存 + 缓存写入 + 缓存读取 |
| TPS | 主 agent 最近 10 次请求：输出 token 总和 ÷ 流式时间总和（从第一个流式片段到结束），长回答权重大，单次工具调用影响小；不含 subagent |
| 活跃 | 只要有 agent（主 agent 或 subagent）在工作就计时，几个同时工作只算一次；运行中青色，空闲淡蓝 |
| 缓存 | 会话累计的缓存读取 ÷ 全部输入，两位小数 |

## 安装

需要支持 mod（函数钩子插件）的 Claude Code（作者在 2.1.289 上使用）和 Node.js，Linux / macOS。

1. 克隆到固定位置（mod 把数据写到 `~/.claude/session-hud/<会话 id>.json`，状态栏脚本从那里读）：

   ```sh
   git clone https://github.com/lurenxing628/claude-code-mod-statusline.git ~/.claude/session-hud
   ```

2. 在 `~/.claude/settings.json` 里加上（已有的设置保留；`CLAUDE_CODE_PLUGIN_DIRS` 已有值时用 `:` 隔开追加）：

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/session-hud/mod"
     },
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/session-hud/statusline.js",
       "padding": 0,
       "refreshInterval": 1
     }
   }
   ```

3. 新开一个会话就能看到。正在运行的会话只在启动时读取设置，要重启才生效：退出后重新打开；由后台守护进程托管的会话（`claude agents` 能列出来的），退出终端再进只是接回旧进程，要用 `claude respawn <id>` 换新进程。

检查 mod 是否正常：

```sh
claude plugin validate ~/.claude/session-hud/mod
claude plugin test ~/.claude/session-hud/mod
```

## 工作原理

- **mod**（`mod/hooks/register.ts`）：用 Claude Code 的函数钩子统计 token、TPS、改动、活跃时间，每秒把渲染好的格子写到 `~/.claude/session-hud/<会话 id>.json`（内容有变化才写）。上下文和费用每次从 `$.session.usage()` 读；自动压缩阈值每 10 秒从 `breakdown` 重读一次，压缩之后也能恢复。纯函数（格式、上色、进度条）在 `mod/hooks/format.ts`。
- **状态栏脚本**（`statusline.js`）：原生 `statusLine` 命令。从 stdin 读模型、思考强度、目录和限额，读格子文件，按列排版。没有 mod 数据时（比如 mod 没加载）退化成一行简版。7 天没更新的数据文件会被顺手清理。
- **对齐**：列之间用 `丨` 分隔；同一列上下两格左右两端都对齐：进度条按下方输入/输出/TPS 格的宽度自动伸长，费用金额靠右与思考强度对齐，逐部分对齐的列在部分内的伸缩点（`\t`）吸收空余。宽度按终端列计算，中文占两列。
- **颜色**：Claude Code 会把整个状态栏压暗，所以每段颜色都以 `\x1b[22;…m` 开头，先恢复正常亮度再上色，暗色主题下也看得清。

## 自定义

- 格子内容、颜色、进度条：`mod/hooks/format.ts`；统计逻辑：`mod/hooks/register.ts`。交互式会话会监视 mod 目录，保存后自动热重载（会话自己在一轮对话里改的，等这一轮结束才重载）。
- 排版、模型、项目分支、限额：`statusline.js`，下次刷新就生效。

## 已知限制

- 改了 mod 的状态结构（`mod/types/index.d.ts` 里的 `PluginState`）后热重载，正在运行的会话里的计数可能会清零。
- 用 Bash 命令改的文件不计入“改动”（Claude Code 自带的行数统计也不算）。
- Windows 没有测试过。

## 许可证

[MIT](LICENSE)
