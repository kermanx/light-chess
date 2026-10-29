// Regression for a38a0753: a long reasoning stream looked frozen because only
// the beginning of a row and the previous tool's completion were visible.
import assert from 'node:assert/strict'
import { DshActivityTracker, dshActivityLabel } from '../src/ai/dsh-activity'

const tracker = new DshActivityTracker(0), sessionId = 'fixture'
const stream = (frame: Record<string, unknown>, time = 100) => tracker.consume({ kind: 'stream', sessionId, frame }, time)
const event = (type: string, data = {}) => tracker.consume({ kind: 'event', sessionId, event: { type, data } }, 200)
stream({ type: 'start', step: 6 })
assert.match(dshActivityLabel(tracker.snapshot()), /第 6 次请求 · 等待模型输出/)
for (let i = 0; i < 50_000; i++) stream({ type: 'chunk', chunk: { type: 'reasoning-delta', text: '推演' } }, i + 1000)
const saved = tracker.snapshot()
assert.equal(saved.characters, 100_000)
assert.equal(saved.tail.length, 240)
assert.equal(saved.lastReceivedAt, 50_999)
stream({ type: 'chunk', chunk: { type: 'reasoning-delta', text: '新结论' } }, 51_000)
assert(tracker.snapshot().tail.endsWith('新结论'))
assert(!saved.tail.endsWith('新结论'), 'published snapshots must be stable')
assert.equal(tracker.snapshot().lastReceivedAt, 51_000, 'no synthetic heartbeat counts as provider activity')
stream({ type: 'chunk', chunk: { type: 'text-delta', text: '采取进攻' } })
assert.equal(tracker.snapshot().tail, '采取进攻', 'public text must not be spliced into reasoning')
stream({ type: 'chunk', chunk: { type: 'tool-call-delta', argumentsDelta: '{}' } })
assert.match(dshActivityLabel(tracker.snapshot()), /生成工具调用/)
event('tool/call', { name: 'analyze' })
assert.match(dshActivityLabel(tracker.snapshot()), /执行 analyze/)
event('tool/result')
event('llm/retry')
assert.match(dshActivityLabel(tracker.snapshot()), /等待重试/)
stream({ type: 'start', step: 7 })
assert.equal(tracker.snapshot().tail, '')
assert.equal(tracker.snapshot().characters, 0)
assert.match(dshActivityLabel(tracker.snapshot()), /第 7 次请求 · 等待模型输出/)
console.log('DSH activity passed: long streams, changing tail, immutable publication, accurate stages, retry reset and no invented activity.')
