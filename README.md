# 光镜棋（light-chess）

纸上的激光反射对决：Vue 3 + TypeScript + Vite，棋盘用 SVG 手绘风格渲染。
联机基于 [trystero](https://github.com/dmotz/trystero)（WebRTC P2P，公共 Nostr 中继做信令），
**无需任何服务器**，构建产物是纯静态站点，部署到 GitHub Pages 即可全球游玩。

## 玩法

- 每位玩家选一个格子作为家并指定激光出口，家中其余 3 条边自动放镜（普通镜子，己方激光仍可穿过）。
- 之后按座位顺序轮流放镜子（每回合一个，不可移除）：点击网格边放边镜，左键格子放「/」斜镜，右键放「\」斜镜。
- 己方镜子对己方激光是半反射（既穿过又反射），其他颜色的镜子必须反射。
- 命中不立即生效：在每位玩家回合开头结算其激光，被击中的玩家出局（家变为 ✕）；双人局被击中即判负，多人局只剩一人时获胜。
- 任一种颜色的镜子连同边框不能把任意两名存活玩家的家隔开（非法放置会被拒绝）。
- 支持 2~4 人，单机同屏或联机（创建/加入 4 位房间号）。
- 创建房间默认勾选「公开」：公开房间会广播到信令通道上的公共大厅，其他玩家在加入页可直接看到并点击进入（无需任何服务器，发现机制同样走 P2P 信令）。
- 房主可选「允许撤回一步」（默认不允许；单机始终可撤），开启后所有玩家都能撤回；重新开始仅限房主。
- 开局后地址栏变为 `/s/<会话 id>`：刷新、浏览器后退（回大厅）+ 前进都能恢复对局。

## 本地开发

```bash
npm install
npm run dev      # vite 开发服务器 :5173
```

联机功能默认使用 trystero 内置的公共 Nostr 中继。如果本机网络无法直连这些中继
（例如需要代理的环境），可以启动内置的最简本地中继，并让页面走它：

```bash
npm run relay    # 最简 Nostr 中继 :8787（仅供开发/测试）
```

然后在浏览器控制台执行一次（或在页面加载前写入 localStorage）：

```js
localStorage.setItem('light-chess:relays', 'ws://localhost:8787')
```

清除该 key 即恢复默认公共中继。自建任何标准 Nostr 中继同理可用。

## 校验脚本

```bash
npx tsx scripts/sim-check.ts      # 光路模拟单元场景
npx tsx scripts/store-check.ts    # 规则/回合/围死判定（纯逻辑）
node scripts/visual-check.mjs     # 单机 UI 冒烟（需 dev 服务器）
node scripts/mp-check.mjs         # 三人联机端到端（需 dev 服务器 + 本地中继）
node scripts/persist-check.mjs    # 刷新恢复（需 dev 服务器 + 本地中继）
```

## 部署

`npm run build` 产出 `dist/`（`base: './'`，可挂任意子路径）。
仓库自带 `.github/workflows/deploy.yml`：push 到 `main` 即自动构建并发布到 GitHub Pages。
