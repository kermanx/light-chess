// store 层（dispatch 全链路）围死校验复现测试
import { applyRemote, dispatch, startLocal, state, topUndoFrame, undoDepth, wouldEnclose } from '../src/store'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  console.log(`ok: ${msg}`)
}

// 场景 A：经典口袋——蓝家 (10,12) 出口向右，出口格三边放蓝镜，第三面必须被拒
startLocal()
dispatch({ kind: 'setup', color: 'blue', home: { x: 10, y: 12, dir: 0 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 16, dir: 2 } })
assert(state.phase === 'play', '双方布置完成进入对局')

dispatch({ kind: 'edge', color: 'blue', id: 'h:11:12' }) // 出口格上边
assert(state.edges.has('h:11:12'), '第一面口袋镜允许')
dispatch({ kind: 'edge', color: 'red', id: 'h:20:20' })
dispatch({ kind: 'edge', color: 'blue', id: 'h:11:13' }) // 出口格下边
assert(state.edges.has('h:11:13'), '第二面口袋镜允许')
dispatch({ kind: 'edge', color: 'red', id: 'h:21:20' })
dispatch({ kind: 'edge', color: 'blue', id: 'v:12:12' }) // 出口格右边 → 围死
assert(!state.edges.has('v:12:12'), '第三面口袋镜（围死）被 dispatch 拒绝')
assert(state.current === 'blue', '非法放置不消耗回合')

// 港口边不可放
dispatch({ kind: 'edge', color: 'blue', id: 'v:11:12' })
assert(!state.edges.has('v:11:12'), '家的出口边不可放镜')

// 场景 B：贴边界口袋——蓝家 (4,1) 出口朝上，出口格左右封边即被边框+镜子隔开
startLocal()
dispatch({ kind: 'setup', color: 'blue', home: { x: 4, y: 1, dir: 3 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 20, dir: 2 } })
dispatch({ kind: 'edge', color: 'blue', id: 'v:5:0' }) // 出口格右边
assert(state.edges.has('v:5:0'), '边界口袋第一面允许')
dispatch({ kind: 'edge', color: 'red', id: 'h:20:20' })
dispatch({ kind: 'edge', color: 'blue', id: 'v:4:0' }) // 出口格左边 → 边框补顶边，隔开
assert(!state.edges.has('v:4:0'), '边界口袋第二面（围死）被 dispatch 拒绝')

// 场景 B2：最外圈格子的出口不能朝向棋盘外（否则激光出界即消失，且家无法被命中）
startLocal()
dispatch({ kind: 'setup', color: 'blue', home: { x: 0, y: 5, dir: 2 } }) // 左边缘，出口朝左出界
assert(!state.homes.blue, '左边缘的家出口朝棋盘外被拒绝')
dispatch({ kind: 'setup', color: 'blue', home: { x: 0, y: 0, dir: 3 } }) // 角落，出口朝上出界
assert(!state.homes.blue, '角落的家出口朝棋盘外被拒绝')
dispatch({ kind: 'setup', color: 'blue', home: { x: 0, y: 5, dir: 0 } }) // 左边缘，出口朝右（向内）
assert(state.homes.blue?.dir === 0, '边缘的家出口朝内允许')
dispatch({ kind: 'setup', color: 'red', home: { x: 35, y: 35, dir: 0 } }) // 右下角，出口朝右出界
assert(!state.homes.red, '右下边缘的家出口朝棋盘外被拒绝')
dispatch({ kind: 'setup', color: 'red', home: { x: 35, y: 35, dir: 2 } }) // 改为朝内
assert(state.phase === 'play', '红方改为朝内出口后布置完成')

// 场景 C：同色大环——蓝镜围一圈 3x3 区域把蓝家包进去，最后一面必须被拒
startLocal()
dispatch({ kind: 'setup', color: 'blue', home: { x: 10, y: 12, dir: 0 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 16, dir: 2 } })
const ring = [
  'v:9:11', 'v:9:12', 'v:9:13', // 左
  'h:9:11', 'h:10:11', 'h:11:11', // 上
  'h:9:14', 'h:10:14', 'h:11:14', // 下
  'v:12:11', 'v:12:13', // 右（留 v:12:12 最后放）
]
const redMoves = [
  'h:20:20', 'h:21:20', 'h:22:20', 'h:23:20', 'h:24:20', 'h:25:20',
  'h:26:20', 'h:27:20', 'h:28:20', 'h:29:20', 'v:29:29',
]
ring.forEach((id, i) => {
  assert(state.current === 'blue', `第 ${i + 1} 手轮到蓝方`)
  dispatch({ kind: 'edge', color: 'blue', id })
  assert(state.edges.has(id), `环上镜子 ${id} 允许（环未闭合）`)
  dispatch({ kind: 'edge', color: 'red', id: redMoves[i] })
})
assert(state.current === 'blue', '最后一手轮到蓝方')
dispatch({ kind: 'edge', color: 'blue', id: 'v:12:12' })
assert(!state.edges.has('v:12:12'), '同色大环最后一面（围死）被 dispatch 拒绝')

// 场景 D：三人局——回合轮转、选家相邻限制、跨玩家围死判定
startLocal(3)
dispatch({ kind: 'setup', color: 'blue', home: { x: 6, y: 6, dir: 0 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 8, dir: 2 } })
dispatch({ kind: 'setup', color: 'yellow', home: { x: 21, y: 7, dir: 3 } })
assert(!state.homes.yellow, '三人局：黄家不能与红家相邻')
dispatch({ kind: 'setup', color: 'yellow', home: { x: 13, y: 20, dir: 3 } })
assert(state.phase === 'play', '三人布置完成进入对局')
assert(state.current === 'blue', '三人局蓝方先手')
dispatch({ kind: 'edge', color: 'blue', id: 'h:10:10' })
assert(state.current === 'red', '回合轮转：蓝→红')
dispatch({ kind: 'edge', color: 'red', id: 'h:11:10' })
assert(state.current === 'yellow', '回合轮转：红→黄')
dispatch({ kind: 'edge', color: 'yellow', id: 'h:12:10' })
assert(state.current === 'blue', '回合轮转：黄→蓝')

// 黄家出口格 (13,19) 口袋：第三面黄镜会把黄家与蓝/红隔开，必须被拒
dispatch({ kind: 'edge', color: 'blue', id: 'h:5:15' })
dispatch({ kind: 'edge', color: 'red', id: 'h:25:25' })
dispatch({ kind: 'edge', color: 'yellow', id: 'h:13:19' })
assert(state.edges.has('h:13:19'), '三人局：口袋第一面允许')
dispatch({ kind: 'edge', color: 'blue', id: 'h:6:15' })
dispatch({ kind: 'edge', color: 'red', id: 'h:26:25' })
dispatch({ kind: 'edge', color: 'yellow', id: 'v:13:19' })
assert(state.edges.has('v:13:19'), '三人局：口袋第二面允许')
assert(wouldEnclose('v:14:19', 'yellow'), 'wouldEnclose：黄墙隔开黄家与其他玩家')
assert(!wouldEnclose('v:14:19', 'blue'), 'wouldEnclose：同一位置蓝墙不构成隔开')
dispatch({ kind: 'edge', color: 'blue', id: 'h:7:15' })
dispatch({ kind: 'edge', color: 'red', id: 'h:27:25' })
dispatch({ kind: 'edge', color: 'yellow', id: 'v:14:19' })
assert(!state.edges.has('v:14:19'), '三人局：口袋第三面（隔开黄家）被 dispatch 拒绝')
assert(state.current === 'yellow', '非法放置不消耗回合')

// 场景 E：双人局延迟结算——命中在放镜当下不生效，对方有一回合自救机会
// （击杀走廊对敌方激光是双向的，需要先在对方出口光束上放一面半反射镜阻断回溯）
startLocal(2)
dispatch({ kind: 'setup', color: 'blue', home: { x: 10, y: 12, dir: 0 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 13, dir: 1 } }) // 红出口朝下
assert(state.phase === 'play', '双人布置完成进入对局')
// 阻断镜：红激光下行 col 20 在 (20,14) 被 '/' 反射向左；蓝激光上行则可穿过（半反射）
dispatch({ kind: 'diag', color: 'blue', x: 20, y: 14, ori: '/' })
dispatch({ kind: 'edge', color: 'red', id: 'h:25:25' })
// 走廊：'\' (24,12) 向下 → '/' (24,16) 向左 → '\' (20,16) 向上，穿过阻断镜命中红家
dispatch({ kind: 'diag', color: 'blue', x: 24, y: 12, ori: '\\' })
dispatch({ kind: 'edge', color: 'red', id: 'h:26:25' })
dispatch({ kind: 'diag', color: 'blue', x: 24, y: 16, ori: '/' })
assert(state.phase === 'play', '走廊未闭合时不命中')
dispatch({ kind: 'edge', color: 'red', id: 'h:27:25' })
dispatch({ kind: 'diag', color: 'blue', x: 20, y: 16, ori: '\\' })
assert(state.phase === 'play' && state.dead.length === 0, '命中当回合不结算（红方尚有自救机会）')
assert(state.current === 'red', '放镜后轮到红方')
dispatch({ kind: 'edge', color: 'red', id: 'h:28:25' }) // 红方放弃自救
assert(state.phase === 'over' && state.winner === 'blue', '红方行动后轮到蓝方，回合开头结算：红死蓝胜')
assert(state.dead.includes('red'), '红方计入出局名单')

// 撤回复活：撤销红方弃疗那手，局面回到击杀走廊闭合、红方待行动
dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
assert(state.phase === 'play' && state.winner === null && state.dead.length === 0, '对局结束后仍可撤回：红方复活')
assert(state.current === 'red', '撤回后回到红方回合')
assert(state.lastMove?.kind === 'diag' && state.lastMove.key === '20,16', '撤回后上一步回退到蓝方走廊镜')

// 场景 F：三人局淘汰制——B 死后对局继续、轮转跳过、出局者不能操作、围死判定忽略死家
startLocal(3)
dispatch({ kind: 'setup', color: 'blue', home: { x: 6, y: 6, dir: 0 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 8, dir: 1 } }) // 红出口朝下
dispatch({ kind: 'setup', color: 'yellow', home: { x: 13, y: 20, dir: 3 } }) // 黄出口朝上
assert(state.phase === 'play' && state.current === 'blue', '三人布置完成，蓝方先手')

// 围死负面对照：红活着时，蓝环封住红家区域算隔开（先注入 11 条边，测第 12 条）
const ringIds = [
  'v:20:9', 'v:21:9', 'h:20:10', 'v:22:8', 'h:21:8', 'h:21:9',
  'h:19:8', 'h:19:9', 'v:20:7', 'v:21:7', 'h:20:7',
]
for (const id of ringIds) state.edges.set(id, { color: 'blue' })
assert(wouldEnclose('v:19:8', 'blue'), '红存活时：蓝环把红家与其他玩家隔开，非法')
for (const id of ringIds) state.edges.delete(id)

// 击杀红：先放阻断镜 '/' (20,10)，再走廊 '\' (24,6) → '/' (24,12) → '\' (20,12)
dispatch({ kind: 'diag', color: 'blue', x: 20, y: 10, ori: '/' })
dispatch({ kind: 'edge', color: 'red', id: 'h:25:25' })
dispatch({ kind: 'edge', color: 'yellow', id: 'h:26:25' })
dispatch({ kind: 'diag', color: 'blue', x: 24, y: 6, ori: '\\' })
dispatch({ kind: 'edge', color: 'red', id: 'h:27:25' })
dispatch({ kind: 'edge', color: 'yellow', id: 'h:28:25' })
dispatch({ kind: 'diag', color: 'blue', x: 24, y: 12, ori: '/' })
dispatch({ kind: 'edge', color: 'red', id: 'h:29:25' })
dispatch({ kind: 'edge', color: 'yellow', id: 'h:30:25' })
dispatch({ kind: 'diag', color: 'blue', x: 20, y: 12, ori: '\\' })
assert(state.phase === 'play' && state.dead.length === 0, '三人局：命中当回合不结算')
dispatch({ kind: 'edge', color: 'red', id: 'h:31:25' })
dispatch({ kind: 'edge', color: 'yellow', id: 'h:32:25' })
// 黄行动后轮到蓝，回合开头结算：红死，但对局继续
assert(state.phase === 'play', '三人局：红死后对局继续')
assert(state.dead.includes('red') && state.winner === null, '红方出局，无人获胜')
assert(state.current === 'blue', '结算后仍是蓝方回合')

// 出局者不能操作
dispatch({ kind: 'diag', color: 'red', x: 5, y: 5, ori: '/' })
assert(!state.diags.has('5,5'), '出局者的操作被拒绝')

// 围死判定忽略死家：同样的蓝环现在合法
for (const id of ringIds) state.edges.set(id, { color: 'blue' })
assert(!wouldEnclose('v:19:8', 'blue'), '红出局后：围住红家不再视为隔开（合法）')
for (const id of ringIds) state.edges.delete(id)

// 击杀黄：先阻断镜 '/' (13,8)（黄激光上行被反射向右），再 '\' (13,6) 向下穿黄家出口
dispatch({ kind: 'diag', color: 'blue', x: 13, y: 8, ori: '/' })
assert(state.current === 'yellow', '轮转跳过已出局的红方')
dispatch({ kind: 'edge', color: 'yellow', id: 'h:33:25' })
dispatch({ kind: 'diag', color: 'blue', x: 13, y: 6, ori: '\\' })
assert(state.phase === 'play' && !state.dead.includes('yellow'), '击杀黄同样延迟结算')
dispatch({ kind: 'edge', color: 'yellow', id: 'h:34:25' })
assert(state.phase === 'over' && state.winner === 'blue', '黄死后只剩蓝方，蓝方获胜')
assert(state.dead.includes('yellow'), '黄方计入出局名单')

// 场景 G：撤回一步与上一步记录（单机始终允许撤回）
startLocal(2)
dispatch({ kind: 'setup', color: 'blue', home: { x: 10, y: 12, dir: 0 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 16, dir: 2 } })
assert(undoDepth.value === 0, '开局无可撤回')
dispatch({ kind: 'edge', color: 'blue', id: 'h:11:12' })
assert(state.lastMove?.kind === 'edge' && state.lastMove.id === 'h:11:12', '上一步记录：边镜')
assert(undoDepth.value === 1, '一手后撤回深度为 1')
dispatch({ kind: 'diag', color: 'red', x: 15, y: 15, ori: '/' })
assert(state.lastMove?.kind === 'diag' && state.lastMove.key === '15,15', '上一步记录：斜镜')

// 撤回红方这手（单机任意玩家可撤）
dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
assert(!state.diags.has('15,15'), '撤回一步：红方斜镜消失')
assert(state.current === 'red', '撤回后回到红方回合')
assert(state.lastMove?.kind === 'edge' && state.lastMove.id === 'h:11:12', '撤回后上一步回退到蓝边镜')
assert(undoDepth.value === 1, '撤回后深度回退为 1')

// 再撤回蓝方这手
dispatch({ kind: 'undo', color: 'red', frame: topUndoFrame()! })
assert(!state.edges.has('h:11:12'), '再撤回：蓝方边镜消失')
assert(state.current === 'blue' && state.lastMove === null, '两手全撤完：回到蓝方且无上一步')
assert(undoDepth.value === 0, '撤完后深度为 0')

// 重新开始（带颜色参数）：清局面、清撤回历史
dispatch({ kind: 'edge', color: 'blue', id: 'h:12:12' })
dispatch({ kind: 'restart', color: 'blue' })
assert(state.phase === 'setup' && state.edges.size === 0, '重新开始：清空局面')
assert(undoDepth.value === 0 && state.lastMove === null, '重新开始：清空撤回历史与上一步')

// 场景 H：联机撤回——需房主开启，且只能撤回自己刚下的那手
startLocal(2)
state.mode = 'online'
state.myColor = 'blue'
applyRemote({ kind: 'setup', color: 'blue', home: { x: 10, y: 12, dir: 0 } })
applyRemote({ kind: 'setup', color: 'red', home: { x: 20, y: 16, dir: 2 } })
assert(state.phase === 'play', '联机场景布置完成')
dispatch({ kind: 'edge', color: 'blue', id: 'h:11:12' })
assert(state.lastMove?.kind === 'edge' && state.lastMove.color === 'blue', '上一步记录带颜色')
dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
assert(state.edges.has('h:11:12'), '联机未开允许撤回：自己的那手也不能撤')
state.allowUndo = true
dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
assert(!state.edges.has('h:11:12') && state.current === 'blue', '联机允许撤回：撤回自己刚下的那手')
dispatch({ kind: 'edge', color: 'blue', id: 'h:12:12' })
applyRemote({ kind: 'edge', color: 'red', id: 'h:20:20' })
assert(state.lastMove?.color === 'red', '对手落子后上一步归对手')
const depthBefore = undoDepth.value
dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
assert(state.edges.has('h:20:20') && undoDepth.value === depthBefore, '联机：不能撤回对手刚下的那手')
applyRemote({ kind: 'undo', color: 'red', frame: topUndoFrame()! })
assert(!state.edges.has('h:20:20') && state.current === 'red', '远端玩家撤回自己的那手')

console.log('全部通过')
