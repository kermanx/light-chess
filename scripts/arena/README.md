# DSH 对弈接口

这套接口让 DSH 通过原生 `light-chess` agent preset 执蓝，与当前构建的 Rust/WASM AI 执红完整对弈。规则计算复用 `src/game.ts`；不向 DSH 提供对手的搜索树、候选评分或一个代替它选择蓝方落子的引擎。固定 16×16、边界反射、无棋钟，沿用测试页的基地位置。

## 本地运行

使用支持原生 TypeScript 的 Node.js 24，先 `npm run build`，然后创建一个独立记录目录：

```sh
node scripts/dsh-arena.mjs --init --game debug/dsh-games/my-match
node scripts/dsh-arena.mjs --watch --game debug/dsh-games/my-match --port 4174
```

`--init` 拒绝覆盖已有记录，并将这局使用的 WASM 复制进目录、记录 SHA-256，后续构建不会改变正在对弈的对手。`--watch` 启动现有 app 的 Vite preview，并输出 `/replay/<UUID>` 地址。也可直接从 `npm run dev` / `npm run preview` 的大厅「对局回放」进入，无需单独开观察服务器。

回放默认停在初始局面，支持上一步、下一步、开局、终局、进度条、点击落子列表，以及方向键 / Home / End。两色光路均由 `src/game.ts` 根据对应历史局面重新模拟；每手展示落子位置、公开解释和已有的搜索耗时。回放不会启动 AI，不修改对局或普通存档。进行中的本地对局会自动读取新增落子，但不会跳动当前回放步数。

开发及预览的只读 `/__arena/replays` 接口默认发现 `debug/dsh-games/` 中的对局，可用 `LIGHT_CHESS_ARENA_DIR` 指定父目录。导出器从不可变的开局事件逐手重建，验证合法性、回合结算、最终棋盘和胜负均与权威记录一致。

## 将完赛回放加入 app

```sh
npm run arena -- --publish --game debug/dsh-games/my-match
npm run build
```

只有完赛记录可以发布。命令生成可提交的 `public/replays/<UUID>.json` 并维护 `public/replays/index.json`；再次导出同一局不会产生重复条目。静态部署和 GitHub Pages 会一并携带这些记录，访问 `/replays` 或 `/replay/<UUID>` 即可观看，无需 DSH、API Key、本地日志目录或额外服务器。JSON 仅含初始棋盘、落子与公开说明、少量搜索统计及引擎摘要；模型内部输出、凭据和完整调试日志不打包进回放。页面也支持下载该可移植记录。

## 原生 DSH preset

使用已执行 `pnpm run build:artifacts` 的 Harness 源码目录（默认 `../deepseek-harness`，可设 `DSH_SOURCE`），将 `DEEPSEEK_API_KEY` 放入当前 shell 环境，然后启动：

```sh
npm run arena -- --run --game debug/dsh-games/my-match
```

可用 `DSH_MODEL` 和 `DEEPSEEK_BASE_URL` 覆盖模型与 Messages API 地址；默认分别为 `deepseek-flash` 和 `https://api.deepseek.com/anthropic`。不要将密钥放进命令参数或提交到仓库。

`--run` 自动构建本地插件，并由源码提供的正式 DSH CLI 启动独立 `light-chess` profile。该 profile 位于对局目录的 `.dsh/`，只有对弈入口，不加载个人配置。它使用与网页相同的 `scripts/dsh/preset.mjs`：原生 `agent-preset-registry` / `agent-preset` 挂载棋手 persona、native tool executor 和两个工具。三个 `cordis:` builtin 分别绑定 DSH 原版 persona、原版 executor 和本项目的工具插件；作用域与卸载均由原生 registry 管理。工具在同一进程内调用，无 MCP 服务、stdio RPC 或客户端依赖。

共用的工具定义及注册在 `scripts/dsh/tools.mjs`，共用核心装配在 `scripts/dsh/runtime.mjs`。网页 `play` 只选择当前一手交给 app；对局 `play` 提交实盘并自动等待 WASM 应手。两者均只返回 `{"ok":true}`，模型只看到 `analyze` 和 `play`，分析实现共用 `scripts/dsh-browser/tools.ts`。

只有 `play` 推进棋局，宿主将工具绑定到本轮棋盘的 `revision`，模型无需填写且不能覆盖。每轮只能成功落子一次，重复或过期动作会被拒绝。`player.lock` 拒绝两个进程同时写入同一局，正常退出会释放。若进程被强制杀死，先确认旧进程已退出，再移除残留锁。再次运行同一命令会以新 DSH 上下文读取完整棋盘与最近落子，继续现有棋局；不会清空、撤回或自动重开。

一次运行内部持续使用同一会话。每次成功 `play` 的结果记录完成后结束本轮；宿主在下一条消息提供应手后的权威棋盘，再继续决策。若一轮没有推进棋局，则明确报错并保留记录，不把文字认输当成胜负。终局后不再发送额外推理请求。

已有的 315 手示例来自迁移前的 headless/MCP 对局，其回放来源标记保留。新建对局记录来源为 `DSH native preset / light-chess`。

## 两个工具

完整规则仅放在 system prompt，棋盘随每轮宿主消息提供。

- `analyze({sequence?,offset?,limit?,light?})`：验证 0～8 手交替变化，按真实时序结算，再精确枚举最终行动方的进攻、防守；两类都没有时返回合法落点。默认每类 8 个、最多 20 个，通过 `nextOffset` 翻页。默认只输出摘要；`light:{color,target?}` 按需提供该假设棋盘的可达格及真实光路。不修改实盘，不替 DSH 作战略选择。
- `play({action})`：提交一手蓝方动作，等待红方 WASM 应手，成功仅返回 `{"ok":true}`。理由取自同一模型回复的正文，保存但不回显；正文缺失就留空。无撤回。

`safe` 只说明落子后不会立即被对方的现有光束击败。新产生的命中是威胁，不会在落子瞬间判胜：对方先获得一手挡住它的机会。工具会明确提供这一差别。

## 记录与验证

记录在 Git 忽略的 `debug/dsh-games/` 内：`state.json` 原子保存最新局面，`events.jsonl` 追加工具输入/结果、双方落子前后局面、AI 请求/完整响应和胜负。`dsh-session.jsonl` 保存完整 DSH 会话事件（含 preset 选择，可能含模型内部输出，仅本地调试）；`dsh-run-start` 记录模型、接口地址与接续步数，凭据不写入记录。观察页和工具状态只展示必要的对手信息，完整搜索统计用于赛后调试。

```sh
npm run test:dsh-arena
npm run test:replay
```

前者检查规则与实际 WASM 回应，并通过真实 DSH CLI、preset 和模型工具循环验证两个原生工具、system 规则、假设分析、简短落子结果、非法/过期落子拒绝、终局、持久化与凭据隔离；模型端使用本地确定性 fixture，不需要 API Key。后者检查历史棋盘/光路、非法/损坏记录拒绝、完赛导出和静态部署浏览器回放，包括子路径、刷新、前后步进、移动端及存档隔离。测试目录与正式对局隔离。
