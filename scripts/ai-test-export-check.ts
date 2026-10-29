import assert from 'node:assert/strict'
import { testEventLineage, type TestEvent } from '../src/ai/test-records'

const event = (id: string, parentId: string | null, sequence: number): TestEvent => ({
  v: 1, id, parentId, sequence, gameId: 'game', tabId: 'tab', at: '', type: 'action', detail: {},
})
const events = new Map([
  ['start', event('start', null, 1)],
  ['human', event('human', 'start', 2)],
  ['thinking', event('thinking', 'human', 3)],
  // Arrived while export was reading IndexedDB; must not leak past the captured head.
  ['ai-result', event('ai-result', 'thinking', 4)],
  ['ai-move', event('ai-move', 'ai-result', 5)],
  // A second tab branching from an earlier state must not pollute this export.
  ['undo', event('undo', 'human', 3)],
  ['alternative', event('alternative', 'undo', 4)],
])
const frozen = testEventLineage('thinking', events)
assert.deepEqual(frozen.events.map(e => e.id), ['start', 'human', 'thinking'])
assert(frozen.complete)
assert.deepEqual(testEventLineage('alternative', events).events.map(e => e.id), ['start', 'human', 'undo', 'alternative'])
const missing = new Map(events)
missing.delete('human')
assert.equal(testEventLineage('thinking', missing).complete, false)
assert.equal(testEventLineage('thinking', missing).missingParentId, 'human')
console.log('ok: exports follow the captured head, exclude later AI results/other branches, and disclose missing history')
