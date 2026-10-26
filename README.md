# 光镜棋（light-chess）

纸上的激光反射对决：Vue 3 + TypeScript + Vite，棋盘用 SVG 手绘风格渲染。
联机默认通过公共 MQTT broker 的 WebSocket 中继传输棋局消息，不依赖 WebRTC/UDP 穿透，
适用于使用代理或无法 P2P 直连的网络。**无需自建服务器**，构建产物是纯静态站点，可部署到 GitHub Pages。
保留 [trystero](https://github.com/dmotz/trystero) 的 Nostr/MQTT P2P 模式用于旧房间。

## 玩法

- 每位玩家选一个格子作为家并指定开口，家中其余 3 条边自动放镜。家向四个方向发光，家镜同样对己方光线半反射（穿过 + 反射）。
- 基地布置按「位置 + 开口方向」检查完整初始光路，不允许任何一方在开局时被命中。同一格的安全方向仍可选择；不安全的方向显示红色并拒绝确认。
- 之后按座位顺序轮流放镜子（每回合一个，不可移除）：点击网格边放边镜，左键格子放「/」斜镜，右键放「\」斜镜。对方基地的开口也可放镜，仍须遵守禁围规则。
- 己方镜子对己方激光是半反射（既穿过又反射），其他颜色的镜子必须反射。
- 「边界反射」默认开启：边界对所有颜色的光全反射；关闭时出界光线终止。开局前可设置，联机由房主控制并同步，进入对局后固定。该开关不影响禁围规则，边框始终算墙。
- 命中不立即生效：在每位玩家回合开头结算其激光，被击中的玩家出局（家变为 ✕）；双人局被击中即判负，多人局只剩一人时获胜。
- 每种颜色的边镜、斜镜分别连同边框，不能把任意两名存活玩家的家隔开（非法放置会被拒绝）；所有基地仍在同一区域时允许。
- 棋钟默认每人 2 分钟，每次合法落子加 10 秒，只在自己的回合倒计时；所有基地布置完成后开始。开局前可调整或关闭，联机由房主设置及判定超时；超时出局，双人局对方获胜，多人局继续轮转。断线等待期间暂停，重连后恢复。
- 支持 2~4 人，单机同屏或联机（创建/加入 4 位房间号）。
- 创建房间默认勾选「公开」：公开房间会广播到 WebSocket 公共大厅，其他玩家在加入页可直接看到并点击进入。
- 新房号以 `3` 开头，棋局消息经 AES-GCM 加密后在多个 broker 上转发，并按对端编号、确认、重传、去重和排序。房号以 `1`/`2` 开头的旧房间仍走 Nostr/MQTT P2P；切换连接方式后需要重新分享链接。四位房号方便加入，不是私密口令。
- 房主可选「允许撤回一步」（默认不允许；单机始终可撤）。开启后每个人都能撤回自己刚下的那手，但开启该设置之前下的步骤不可撤；重新开始仅限房主。
- 开局后地址栏变为 `/s/<会话 id>`：刷新、浏览器后退（回大厅）+ 前进都能恢复对局。

## 本地开发

```bash
npm install
npm run dev      # vite 开发服务器 :5173
```

默认使用公共 MQTT WebSocket 中继（EMQX 与 HiveMQ）。「中继已连接」只统计近期成功完成
消息往返的 broker。公共服务仍可能限流或不可用；可启动本地中继来进行独立回归：

```bash
npm run relay    # MQTT WebSocket 中继 :8788（仅供开发/测试）
```

然后在浏览器控制台执行一次（或在页面加载前写入 localStorage）：

```js
localStorage.setItem('light-chess:mqtt-relays', 'ws://localhost:8788')
```

清除该 key 即恢复默认公共中继；支持逗号分隔多个 MQTT WebSocket 地址。
旧 Nostr P2P 模式的测试中继仍可用 `npm run relay:nostr`（`:8787`）启动，覆盖 key 为 `light-chess:relays`。

## 校验脚本

```bash
npx tsx scripts/sim-check.ts      # 光路模拟单元场景
npx tsx scripts/boundary-check.ts # 边界反射、规则锁定与存档兼容
npx tsx scripts/setup-check.ts    # 基地位置与开口方向、开局命中及多人布置
npx tsx scripts/clock-check.ts    # 棋钟加秒、超时、撤回、恢复、多人及客户端时差
npx tsx scripts/store-check.ts    # 规则/回合/围死判定（纯逻辑）
node scripts/visual-check.mjs     # 单机 UI 冒烟（需 dev 服务器）
node scripts/enclosure-check.mjs  # 规则开关、边镜/斜镜禁围预览与落子（自带服务）
node scripts/mp-check.mjs         # 三人联机端到端（需 dev 服务器 + 本地中继）
node scripts/persist-check.mjs    # 刷新恢复（需 dev 服务器 + 本地中继）
node scripts/relay-check.mjs      # 禁用 WebRTC；丢包/乱序/重复/中继故障回归（自带服务）
```

## 部署

`npm run build` 产出 `dist/`（`base: './'`，可挂任意子路径）。
仓库自带 `.github/workflows/deploy.yml`：push 到 `main` 即自动构建并发布到 GitHub Pages。
