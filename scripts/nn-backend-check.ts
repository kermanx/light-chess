/**
 * NN 后端数值抽查：onnxruntime-node（CPU）vs onnxruntime-web（WASM，浏览器同款）。
 * 对每个尺寸的 recommended 模型，用 parity fixture 的固定特征输入分别跑两个后端，
 * 断言 policy/value 输出 max diff < 1e-3（WASM 数值精度略松于 node 的 1e-4）。
 * 由 scripts/nn-backend-check.mjs 启动（与 nn-engine-check 同一入口形态）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ortNode from 'onnxruntime-node'
import * as ortWeb from 'onnxruntime-web'
import type { NnModelInfo } from '../src/nn/models'

const ROOT = join(import.meta.dirname, '..')
const FIXTURE_DIR = join(ROOT, 'test/fixtures')
const MODELS_DIR = join(ROOT, 'public/models')
const MAX_DIFF = 1e-3
const NUM_CASES = 8

// onnxruntime-web 的 WASM 二进制在 node_modules 里，node 下需显式指路
ortWeb.env.wasm.wasmPaths = join(ROOT, 'node_modules/onnxruntime-web/dist/') + '/'

const models = JSON.parse(readFileSync(join(MODELS_DIR, 'models.json'), 'utf8')) as NnModelInfo[]
const FIXTURE_BY_SIZE: Record<number, string> = {
  6: 'parity_6x6_reh25_prune2_gen16.json',
  8: 'parity_8x8_king_gen16.json',
}

for (const size of [6, 8] as const) {
  const model = models.find((m) => m.boardSize === size && m.recommended)
  assert.ok(model, `models.json 缺少 ${size}×${size} recommended 模型`)
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, FIXTURE_BY_SIZE[size]), 'utf8'))
  const modelPath = join(MODELS_DIR, model.file)
  const nodeSess = await ortNode.InferenceSession.create(modelPath)
  // ort-web 的 node 构建不支持从路径挂载外部数据（MountedFiles），
  // 与浏览器一样改为内存 buffer + externalData 显式注入
  const webSess = await ortWeb.InferenceSession.create(readFileSync(modelPath), {
    externalData: [{ path: `${model.file}.data`, data: readFileSync(`${modelPath}.data`) }],
  })
  let worstP = 0, worstV = 0
  for (const c of fixture.cases.slice(0, NUM_CASES)) {
    const features = new Float32Array(Buffer.from(c.features, 'base64').buffer.slice(0))
    const shape: [number, number, number, number] = [1, fixture.channels, size, size]
    const nIn = { x: new ortNode.Tensor('float32', features, shape) }
    const wIn = { x: new ortWeb.Tensor('float32', features, shape) }
    const [nOut, wOut] = await Promise.all([nodeSess.run(nIn), webSess.run(wIn)])
    const np_ = nOut.policy.data as Float32Array, wp = wOut.policy.data as Float32Array
    assert.equal(np_.length, wp.length)
    for (let i = 0; i < np_.length; i++) worstP = Math.max(worstP, Math.abs(np_[i] - wp[i]))
    worstV = Math.max(worstV, Math.abs((nOut.value.data as Float32Array)[0] - (wOut.value.data as Float32Array)[0]))
  }
  assert.ok(worstP < MAX_DIFF && worstV < MAX_DIFF,
    `${model.id} WASM vs node 对拍失败：policy=${worstP} value=${worstV}`)
  console.log(`${model.id}: WASM vs node（${NUM_CASES} 例）policy max diff = ${worstP.toExponential(3)}, value max diff = ${worstV.toExponential(3)} OK`)
}

console.log('NN 后端（WASM vs node）数值抽查全部通过')
process.exit(0)
