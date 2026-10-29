# 浏览器 DSH 对弈

DSH 和 Rust/WASM 实现同一套 `AiWorkerRequest → progress / AiResponse` 接口，由 `src/ai/controller.ts` 统一管理。每个 AI 席位可以独立选择实现，旧存档默认 WASM。房主计算联机 AI，其他玩家只接收合法动作与解释。

## 构建与运行

需要一个已经完成 `pnpm run build:artifacts` 的 DeepSeek Harness 源码目录。默认使用本项目旁边的 `../deepseek-harness`，可用 `DSH_SOURCE` 指定。构建只读取该目录，不修改它，也不读取 DSH 的个人配置或凭证。

```sh
DSH_SOURCE=/path/to/deepseek-harness npm run build:with-dsh
npm run preview -- --host 127.0.0.1 --port 4173
```

大厅或对局页选择「DSH」后，点击「管理 LLM 配置」打开弹窗，可添加、复制、编辑和删除多份配置。每份有独立的名称、API 地址、模型和 Key；蓝方、红方及其他 DSH 席位分别选择配置，因此可以直接进行两个不同 LLM 的自动对弈。默认地址 `https://api.deepseek.com/anthropic`，模型 `deepseek-flash`；地址使用 DSH 自带的 DeepSeek Messages 协议，服务须允许浏览器跨域请求。

配置默认保存在当前网站的 localStorage，刷新或重新打开后恢复；旧版单配置（包括标签页配置）自动迁移为第一份配置。取消「记住 API 配置」后该份仅在当前页面保留。「清除 Key」保留配置名称、地址和模型。对局快照只保存每个席位选中的配置 ID，凭证不写入棋局、导出记录、联机消息或本地调试日志；联机时仍只由房主运行 AI。切换当前席位的配置会取消旧请求，修改其他席位的配置不会打断当前 AI；删除绑定配置后会明确要求重新选择，不自动换模型。

Rust/WASM 继续完全离线工作。DSH 的核心、工具执行和棋局模拟完全在浏览器 Worker 中运行，模型推理通过浏览器直接请求配置的 API；不需要后台 DSH 进程或本地代理。DSH 不使用 WASM 的 3/10/30 秒搜索上限，用户可取消、恢复或切换实现。初始化资源有独立的 60 秒失败检测。

模型请求使用 DSH 原生 `llm-retry`：网络中断、限流、服务错误或不完整响应（含无效的工具参数 JSON）最多重试两次，采用可取消的退避等待。只重发当前失败的请求，不重复执行已完成的工具，也不猜测残缺参数；认证失败不自动重试。进度和轨迹保留失败与重试记录，重试耗尽后保留棋盘并显示「重试 AI」。

`npm run build:dsh` 复用 DSH 的 `webworker-packer.packVfsImage`、现有 Web profile 和原版 `webworker-runtime/worker`，没有另写模块加载器或模型工具循环。棋局插件在独立 Cordis Context 中装配原版核心，通过 `agent-preset-registry` / `agent-preset` 选择 `light-chess` preset。preset 负责棋手 persona、原生 tool executor 和两个棋局工具的作用域与生命周期；它与本地对局共用 `scripts/dsh/preset.mjs`、`tools.mjs` 和 `runtime.mjs`，不使用 MCP。浏览器通过原有 Worker HTTP 隧道提交局面，插件返回进度与最终动作。

产物放在忽略提交的 `public/dsh/`。主镜像约 11 MiB，包含哈希文件名；生成的 manifest 记录源码 HEAD、是否有本地修改及构建时间。调试日志记录该 manifest 和模型、接口地址。保留上一代资源供构建期间已开始加载的页面使用。普通 `npm run build` 会复制已生成资源，但不会隐式构建外部 DSH 源码；当前 GitHub Pages 工作流仍只构建 WASM，发布 DSH 时须先提供这些构建产物。

## 工具与记录

完整规则只放在 system prompt，当前权威棋盘随每轮消息提供。

系统提示词先使用 DSH 原生身份声明 `You are an AI agent powered by DeepSeek Harness.`，再接 standard preset 的 `You are a coding agent powered by the {{model}} model.`（模型名由 DSH 插值），随后才是棋局任务和规则。棋手 persona 不再以 `complete` 模式覆盖这些标准开头。

模型只看到两个工具：

- `analyze({sequence?, offset?, limit?, light?})`：`sequence` 默认 `[]`，可试下最多八手交替变化，包括多人淘汰；返回合法性、每手结算和最终局面的简短摘要，并精确枚举最终行动方的攻击、防守。两类都没有时提供合法落点供继续布局或终局结算。每类默认返回 8 个候选，最多 20 个；总数完整，`nextOffset` 指示后续页，顺序不代表战略评分。仅提供 `light:{color,target?}` 时附带该假设局面的可达格和光路。布阵阶段支持空变化查询，通过 `play` 选择基地。
- `play({action})`：验证一手合法动作，成功只返回 `{"ok":true}`，失败返回简短错误。落子理由取自模型同一回复的正文，保存到棋谱的 `rationale` 字段；工具参数只传动作。正文缺失就留空，不用思考内容或旧回复填补。动作交给 controller 再次校验后落子，选择后停止模型循环，避免多发一次推理请求。

例如 `analyze({sequence:[蓝方进攻]})` 会枚举红方的防守；再调用 `analyze({sequence:[蓝方进攻,红方防守]})` 可以查询蓝方续攻。所有变化独立从本轮棋盘开始，不修改实盘，默认不重复返回全部镜子或光路。

工具直接复用 `src/game.ts` 的模拟与禁围规则；棋盘数组沿用 WASM 协议，尺寸不写死。多人查询同时报告当前所有威胁和下一玩家的即时安全，避免把一手安全误称为完整回合安全。

## 实时轨迹面板

对弈页有 DSH 席位时自动展开右侧面板。直接使用 `@deepseek-ai/trajectory-ui` 的时间线、记录列表和详情视图，以及该库的 DSH session projector。显示 DSH 实际收到的模型输出（包括提供方返回的思考内容）、系统提示、工具定义、调用参数与结果、错误、耗时和 token 用量。模型未提供的数据保持缺失，不生成代替内容。落子在真实 `play` 结果和本轮结束事件记录完之后返回，避免 Worker 提前终止导致末尾丢失。

收起面板仍持续接收。每次 AI 决策单独保留，可选择旧轨迹或跟随最新；取消保留已有输出并标明中断。轨迹用 IndexedDB 保存在当前浏览器，测试页还将 `search-trajectory` 和原有进度/结果一起写入调试记录。导出包含 UI 文档和原始 DSH session/stream 载荷；显示、存储和导出前统一移除 API Key 等凭证。刷新可恢复历史，无法补回接入面板前未记录的流式事件。

面板顶部另显示当前请求阶段、本手用时、实际收到的思考／正文字符数和最新 240 字符片段，点击「查看当前输出」可打开完整详情。字符数不是 token 数；无新事件时显示等待秒数，不虚构进度，也不因此强制截断模型。顶部棋局状态随模型流更新，不再停在上一工具的完成消息。展示每 200 ms 合并更新，原始载荷全部保留；收起时卸载轨迹视图但继续记录。预设增加明确的双人结算例子，要求优先查询确定性工具、避免重复手算，验证安全后及时选择落子；没有新增硬性思考时限。

UI 库源码快照位于 `vendor/trajectory-ui`，通过本地 package 依赖接入，可随项目提交，不依赖开发者电脑上的绝对路径。来源与更新说明见 [vendor/README.md](../../vendor/README.md)。

```sh
npm run test:ai-providers  # UI、权限、取消、旧结果丢弃、记录与凭证隔离
npm run test:llm-profiles  # 构建 + 多配置管理、持久化、双方独立配置与真实 DSH Worker 对弈
npm run test:dsh           # 规则工具 + 真实打包 Worker/原版循环，模型端使用本地确定性 fixture
node scripts/dsh-browser-check.mjs --preview # 另验证已构建的测试页面与真实 DSH 资源
npm run test:dsh-trajectory # 构建后验证实时轨迹、完整结果、收起/恢复、导出、取消和移动端布局
npm run test:dsh-retry      # 真实 DSH 核心：截断参数恢复、重试上限、认证失败、取消和工具错误
npm run test:dsh-activity   # 长流输出末尾、真实活动阶段、重试重置，不伪造心跳或 token 数
```

`test:dsh` 和 `test:llm-profiles` 须先执行 `build:dsh`；其他页面测试须先执行 `build:with-dsh`。测试使用真实 DSH 浏览器核心和本地模拟模型接口，覆盖非法落子后的继续决策、基地布置、API 认证失败和推理期间取消；不会读取个人 API Key。多配置测试还验证添加、复制、删除、未保存编辑提示、移动端布局、刷新恢复，以及两个席位分别使用各自的地址、模型和 Key 完成决策。
