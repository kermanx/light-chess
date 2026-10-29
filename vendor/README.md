# Trajectory UI 源码快照

`trajectory-ui/` 来自用户提供的 `trajectory-ui-lib` 仓库。原文件保持不变；`UPSTREAM.json` 记录来源 commit 与每个文件的 SHA-256，方便核对和更新。许可证沿用上游 package.json 声明的 MIT。

复制范围：`src/`、`package.json`、`README.md`，以及 `demo/session-projection.ts`、`demo/session-stream.ts`、`demo/trajectory-content.ts`。后三个模块是上游已有的 DSH session 适配器，避免在光镜棋中另写一套事件解释器。

根 package.json 通过 `file:vendor/trajectory-ui` 引用。Vite/UnoCSS 直接构建其 Vue 源码，`src/components/DshTrajectoryPanel.vue` 负责棋局侧的外壳，`src/ai/trajectory.ts` 负责实际事件接入、流式临时视图和持久化，不修改 UI 库。

更新时从新的上游版本重新复制上述范围，更新 `UPSTREAM.json` 的 commit 和文件哈希，执行 `npm install`，再运行 `npm run build:with-dsh` 和 `npm run test:dsh-trajectory`。保持快照和锁文件一起提交。
