import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initGame, loadState, boardOf, validate, traceSummary, variation, advance, position, aiRequest, persist } from './arena/game.mjs'
import { analyze } from './dsh-browser/tools.ts'

import { createArenaTools } from './arena/tools.mjs'

const directory=mkdtempSync(join(tmpdir(),'light-chess-dsh-check-'))
try {
  const initial=initGame(directory,new URL('../src/ai/engine.wasm',import.meta.url))
  const before=JSON.stringify(initial),board=boardOf(initial)
  assert(validate(board,{kind:'edge',id:'d:2:13:/'},'blue'),'edge IDs cannot impersonate diagonal IDs')
  assert(validate(board,{kind:'diag',x:2,y:2,ori:'/'},'blue'),'homes cannot be occupied')
  assert(validate(board,{kind:'edge',id:'h:2:0'},'blue'),'boundary cannot be occupied')
  assert.deepEqual(traceSummary(board,'blue',{x:2,y:13}).pathToTarget,[{x:2.5,y:2.5},{x:2.5,y:13.5}])
  assert.equal(traceSummary(board,'blue',{x:5,y:5}).pathToTarget,null)
  const opening={kind:'diag',x:2,y:13,ori:'/'}
  const hypothetical=variation(initial,[opening])
  assert(hypothetical.valid);assert(hypothetical.position.mustDefend)
  assert.equal(hypothetical.position.winner,null,'giving check does not immediately win')
  const lose=advance(advance(initial,opening,'test','test'),{kind:'diag',x:0,y:0,ori:'/'},'ignore check','test')
  assert.equal(lose.winner,'blue','the attacker wins at the start of its next turn if not blocked')
  assert.equal(JSON.stringify(loadState(directory)),before,'queries and variations never mutate the live board')

  const tools = await createArenaTools(directory)
  const value = (name, args = {}) => tools[name](args)
  assert.deepEqual(Object.keys(tools),['analyze','play'])
  assert.deepEqual(await value('analyze'), analyze(aiRequest(initial)), 'browser and arena share identical analysis results')
  const attacks=(await value('analyze',{limit:1})).moves.attack
  assert.equal(attacks.total,2);assert.equal(attacks.candidates.length,1);assert.equal(attacks.nextOffset,1)
  const page2=(await value('analyze',{limit:1,offset:1})).moves.attack
  assert.notDeepEqual(page2.candidates[0].action,attacks.candidates[0].action)
  await assert.rejects(value('play',{action:{kind:'diag',x:2,y:2,ori:'/'},rationale:'invalid'}))
  assert.equal(loadState(directory).revision,0)
  const result=await value('play',{action:opening,rationale:'Attack along row 13; expect a blocking response.'})
  assert.deepEqual(result,{ok:true},'play only acknowledges; next board is a host message')
  const after=position(loadState(directory))
  assert.equal(after.revision,2);assert.equal(after.current,'blue')
  assert.equal(after.recentMoves.length,2)
  await assert.rejects(value('play',{action:opening,rationale:'duplicate'}), /already been selected/)
  assert.equal(loadState(directory).revision,2)
  const events=readFileSync(join(directory,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(e=>e.type==='move').length,2)
  assert(events.some(e=>e.type==='ai-search-result'&&e.detail.result.stats))
  assert.deepEqual(position(loadState(directory)),after)
  const stale = await createArenaTools(directory)
  persist(directory, { ...loadState(directory), revision: 3 })
  await assert.rejects(stale.play({ action: {kind:'diag',x:0,y:0,ori:'/'}, rationale:'stale', revision:3 }), /Stale position/, 'model arguments cannot override the host revision')
  console.log('Arena checks passed: rule timing, exact light queries, hypothetical isolation, native game tools, pagination, illegal/stale rejection, real WASM reply, durable logs and hidden opponent search.')
} finally {
  rmSync(directory,{recursive:true,force:true})
}
