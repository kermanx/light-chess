/**
 * TS encoder ↔ Python lightchess/features.py 对拍测试。
 * 读取 rl/scripts/gen_parity_fixture.py 生成的 fixture（test/fixtures/parity_*.json），
 * 按 fixture 自带的 feature_version 构造编码器，逐通道断言输出一致（容差 1e-5）。
 * 覆盖 dirlight30-v1（真实 SOTA 权重，6×6/8×8）与 dirlight31-v1（随机权重，全开）。
 * 运行：npx tsx --test src/nn/encoder.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeState,
  flagsForVersion,
  numChannels,
  type EncoderState,
} from './encoder'
import type { BoardState, Color, Diag, Home, Mirror, Ori } from '../game'

interface FixtureCase {
  board: {
    size: number
    boundaryReflects: boolean
    homes: Record<string, Home>
    edges: [string, Mirror][]
    diags: [string, { color: Color; ori: Ori }][]
  }
  current: Color
  players: Color[]
  ply: number
  maxPlies: number
  phase: 'setup' | 'play' | 'over'
  features_shape: [number, number, number]
  features: string // base64 little-endian float32
  policy: number[]
  value: number
  legal: number[]
}

export interface Fixture {
  feature_version: string
  channels: number
  size: number
  model: { arch: string; weights: string; note?: string }
  cases: FixtureCase[]
}

const FIXTURE_DIR = join(import.meta.dirname, '../../test/fixtures')

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
}

function decodeFeatures(c: FixtureCase): Float32Array {
  const buf = Buffer.from(c.features, 'base64')
  const [ch, s] = c.features_shape
  const out = new Float32Array(ch * s * s)
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

function toState(c: FixtureCase): EncoderState {
  const board: BoardState = {
    size: c.board.size,
    boundaryReflects: c.board.boundaryReflects,
    homes: c.board.homes,
    edges: new Map<string, Mirror>(c.board.edges),
    diags: new Map<string, Diag>(c.board.diags),
  }
  return {
    board,
    current: c.current,
    players: c.players,
    ply: c.ply,
    maxPlies: c.maxPlies,
    phase: c.phase,
  }
}

const FIXTURE_FILES = [
  'parity_6x6.json', // dirlight30-v1，真实权重 abl6x6_vitm_pt_dd/gen32
  'parity_8x8.json', // dirlight30-v1，真实权重 main8x8_transfer/gen16
  'parity_31ch_6x6.json', // dirlight31-v1，随机权重（全开布局回归）
  'parity_31ch_8x8.json',
]

for (const name of FIXTURE_FILES) {
  const fixture = loadFixture(name)
  const size = fixture.size

  test(`${name}: feature_version 可解析且通道数自洽`, () => {
    const flags = flagsForVersion(fixture.feature_version)
    assert.equal(flags.channels, fixture.channels)
    assert.equal(numChannels(flags.light, flags.ply), fixture.channels)
  })

  test(`${name}: ${fixture.cases.length} 例逐通道特征一致`, () => {
    assert.ok(fixture.cases.length >= 25, 'fixture 例数不足')
    let worst = 0
    for (const [i, c] of fixture.cases.entries()) {
      const expected = decodeFeatures(c)
      const actual = encodeState(toState(c), fixture.feature_version as never)
      assert.equal(actual.length, expected.length, `case ${i} 长度不一致`)
      for (let j = 0; j < expected.length; j++) {
        const diff = Math.abs(actual[j] - expected[j])
        worst = Math.max(worst, diff)
        assert.ok(
          diff <= 1e-5,
          `case ${i} 通道 ${Math.floor(j / (size * size))} ` +
            `格 (${(j % (size * size)) % size},${Math.floor((j % (size * size)) / size)}) ` +
            `diff=${diff} expected=${expected[j]} actual=${actual[j]}`,
        )
      }
      // policy 向量的形状/归一性顺带 sanity check（数值对拍见 scripts/onnx-e2e-check.ts）
      assert.equal(c.policy.length, 4 * size * size + 2 * size)
      assert.ok(Math.abs(c.policy.reduce((a, b) => a + b, 0) - 1) < 1e-3)
    }
    console.log(`  ${name}: ${fixture.feature_version} max abs diff = ${worst}`)
  })
}
