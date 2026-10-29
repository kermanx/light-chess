// Differential oracle: the independent original TypeScript rules validate Rust/WASM.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { simulate, createsEnclosure, edgeOf, PALETTE } from '../src/game.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const colors = PALETTE.map(p => p.id)
const native = spawnSync('cargo', ['build', '--manifest-path', 'ai/Cargo.toml', '--locked', '--release', '--bin', 'inspect'], { cwd: root, stdio: 'inherit' })
assert.equal(native.status, 0)
let seed = 20261028
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
const ri = n => Math.floor(random() * n)
function fresh(n, count = 2) {
  const homes = [{x:0,y:0,dir:0},{x:n-1,y:n-1,dir:2},{x:n-1,y:0,dir:1},{x:0,y:n-1,dir:0}]
  const b = { size:n, boundaryReflects:true, homes:{}, edges:new Map(), diags:new Map(), players:colors.slice(0,count), dead:[] }
  for (let i=0;i<count;i++) {
    b.homes[colors[i]] = homes[i]
    for(let d=0;d<4;d++) if(d!==homes[i].dir) b.edges.set(edgeOf(homes[i].x,homes[i].y,d),{color:colors[i]})
  }
  return b
}
function request(b, current='blue', extras={}) {
  const n=b.size, horizontal=Array(n*(n+1)).fill(0),vertical=Array(n*(n+1)).fill(0),diagonals=Array(n*n).fill(0)
  for(const [id,m] of b.edges) {const [axis,x,y]=id.split(':');(axis==='h'?horizontal:vertical)[+y*(axis==='h'?n:n+1)+ +x]=colors.indexOf(m.color)+1}
  for(const [id,m] of b.diags) {const [x,y]=id.split(',').map(Number);diagonals[y*n+x]=1+2*colors.indexOf(m.color)+(m.ori==='\\'?1:0)}
  return {version:1,phase:'play',size:n,players:b.players.map(c=>colors.indexOf(c)),current:colors.indexOf(current),aliveMask:b.players.reduce((m,c)=>b.dead.includes(c)?m:m|1<<colors.indexOf(c),0),homes:colors.map(c=>b.homes[c]??null),horizontal,vertical,diagonals,budgetMs:250,maxDepth:3,maxNodes:3000,...extras}
}
const liveHomes = b => Object.fromEntries(Object.entries(b.homes).filter(([c])=>!b.dead.includes(c)))
function options(b) {
  const out=[],n=b.size
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    if(!b.diags.has(`${x},${y}`)&&!Object.values(b.homes).some(h=>h.x===x&&h.y===y))for(const ori of ['/','\\'])out.push({kind:'diag',x,y,ori})
    if(x+1<n&&!b.edges.has(`v:${x+1}:${y}`))out.push({kind:'edge',id:`v:${x+1}:${y}`})
    if(y+1<n&&!b.edges.has(`h:${x}:${y+1}`))out.push({kind:'edge',id:`h:${x}:${y+1}`})
  }
  return out
}
function apply(b,a,color) {
  if(a.kind==='setup'){
    b.homes[color]=a.home
    for(let d=0;d<4;d++)if(d!==a.home.dir)b.edges.set(edgeOf(a.home.x,a.home.y,d),{color})
  } else if(a.kind==='diag')b.diags.set(`${a.x},${a.y}`,{color,ori:a.ori})
  else b.edges.set(a.id,{color})
}
function undo(b,a){if(a.kind==='diag')b.diags.delete(`${a.x},${a.y}`);else b.edges.delete(a.id)}
function legal(b,a,color) {
  if(!options(b).some(m=>JSON.stringify(m)===JSON.stringify(a)))return false
  apply(b,a,color)
  const ok=!createsEnclosure(b.edges,color,liveHomes(b),b.size,b.diags)
  undo(b,a);return ok
}
function safe(b,a,color,enemy) {apply(b,a,color);const ok=!simulate(b,enemy).hits.includes(color);undo(b,a);return ok}
const boards=[]
for(let i=0;i<160;i++){
  const b=fresh([4,6,8,12][i%4],2+i%3)
  for(let j=0;j<b.size*3;j++){
    const all=options(b);if(!all.length)break
    const a=all[ri(all.length)],color=b.players[ri(b.players.length)]
    if(legal(b,a,color))apply(b,a,color)
  }
  if(b.players.length>2&&i%5===0)b.dead=[b.players.at(-1)]
  boards.push(b)
}
const inspect = spawnSync(join(root,'ai/target/release/inspect'),[],{input:boards.map(b=>JSON.stringify(request(b))).join('\n')+'\n',encoding:'utf8',maxBuffer:10_000_000})
assert.equal(inspect.status,0,inspect.stderr)
const inspections=inspect.stdout.trim().split('\n').map(line=>JSON.parse(line))
assert.equal(inspections.length,boards.length)
for(let i=0;i<boards.length;i++){
  const b=boards[i],result=inspections[i]
  for(let c=0;c<4;c++){
    const expected=simulate(b,colors[c]).hits.reduce((mask,t)=>mask|1<<colors.indexOf(t),0)
    assert.equal(result.hits[c],expected,`optics board ${i} color ${c}`)
    assert.equal(result.encloses[c],createsEnclosure(b.edges,colors[c],liveHomes(b),b.size,b.diags),`enclosure board ${i} color ${c}`)
    for(let t=0;t<4;t++)if(t!==c)assert.equal(result.costs[c][t]===0,Boolean(expected&(1<<t)),`reverse graph board ${i} ${c}->${t}`)
  }
}
console.log(`Rust/TypeScript differential: ${boards.length} boards, all colors, hits/enclosure/reverse reachability agree`)

let forcedClock = null
const {instance}=await WebAssembly.instantiate(readFileSync(join(root,'src/ai/engine.wasm')),{env:{now_ms:()=>forcedClock ? forcedClock() : performance.now()}})
const wasm=instance.exports
function choose(req){
  const bytes=new TextEncoder().encode(JSON.stringify(req)),ptr=wasm.alloc(bytes.length)
  let output=0,len=0
  try{new Uint8Array(wasm.memory.buffer,ptr,bytes.length).set(bytes);output=wasm.choose_action(ptr,bytes.length);len=wasm.result_len();return JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer,output,len)))}
  finally{wasm.dealloc(ptr,bytes.length);if(output)wasm.dealloc(output,len)}
}
// All safe diagonal moves are exhausted here; three edge mirrors are the only saves.
const edgeFixture={version:1,phase:'play',size:4,players:[0,1],current:0,aliveMask:3,homes:[{x:0,y:0,dir:0},{x:3,y:3,dir:2},null,null],horizontal:[1,0,0,0,1,0,2,2,2,0,0,1,0,1,0,2,0,0,0,2],vertical:[1,0,1,0,0,0,2,2,2,0,0,2,0,0,0,0,2,0,0,2],diagonals:[0,2,4,3,4,1,0,1,2,1,0,3,4,3,4,0],budgetMs:1000,maxDepth:3,maxNodes:3000}
const edgeResult=choose(edgeFixture)
assert.equal(edgeResult.action.kind,'edge')
assert(['v:3:0','h:2:3','v:3:3'].includes(edgeResult.action.id),'must find one of the only saving edges')
assert(edgeResult.stats.safe&&edgeResult.stats.defenseComplete)
let ticks=0
forcedClock=()=>ticks++*10
const incomplete=choose({...edgeFixture,budgetMs:1})
forcedClock=null
assert(incomplete.error&&!incomplete.action,'interrupted defense must not knowingly play an unverified losing fallback')
console.log('WASM edge-only defense and interrupted safety validation passed')
let defenses=0,edgeOnly=0,quiet=0
for(const b of boards){
  if(b.players.length!==2||simulate(b,'blue').hit)continue
  const all=options(b).filter(a=>legal(b,a,'blue'))
  if(!all.length)continue
  const saves=all.filter(a=>safe(b,a,'blue','red'))
  const underAttack=simulate(b,'red').hit
  const result=choose(request(b,'blue',{budgetMs:1000,maxDepth:2,maxNodes:300}))
  assert(!result.error,JSON.stringify(result))
  assert(legal(b,result.action,'blue'),'WASM action is legal')
  if(saves.length)assert(safe(b,result.action,'blue','red'),'WASM must choose a saving move when one exists')
  if(underAttack){defenses++;if(saves.length&&saves.every(a=>a.kind==='edge'))edgeOnly++}else quiet++
}
assert(defenses>0&&quiet>0,'test both defense and attack modes')
console.log(`WASM decisions: ${defenses} threatened positions, ${quiet} quiet positions; ${edgeOnly} require an edge mirror`)
for(const size of [3,16,49,64,96]){
  const b=fresh(size),result=choose(request(b,'blue',{budgetMs:100,maxDepth:2,maxNodes:50}))
  assert(!result.error,JSON.stringify(result));assert(legal(b,result.action,'blue'),`arbitrary size ${size}`)
}
for(const count of [2,3,4]){
  const b=fresh(8,count);b.homes={};b.edges.clear()
  for(const color of b.players){
    const result=choose(request(b,color,{phase:'setup',budgetMs:200}))
    assert(!result.error,JSON.stringify(result));assert.equal(result.action.kind,'setup')
    const h=result.action.home
    assert(!Object.values(b.homes).some(o=>Math.max(Math.abs(h.x-o.x),Math.abs(h.y-o.y))<2))
    apply(b,result.action,color);assert(!simulate(b,b.players[0]).hit,'setup must not cause first-turn elimination')
  }
  let current=b.players[0]
  for(let turn=0;turn<24&&b.dead.length<count-1;turn++){
    const result=choose(request(b,current,{budgetMs:100,maxDepth:3,maxNodes:200}))
    assert(!result.error,JSON.stringify(result));assert(legal(b,result.action,current));apply(b,result.action,current)
    let index=b.players.indexOf(current)
    do{index=(index+1)%count}while(b.dead.includes(b.players[index]))
    current=b.players[index]
    for(const hit of simulate(b,current).hits)if(!b.dead.includes(hit))b.dead.push(hit)
  }
}
assert(choose({...request(fresh(4)),horizontal:[]}).error,'malformed dimensions are rejected')
console.log('WASM arbitrary dimensions, 2–4 player setup/self-play, ABI allocation and invalid requests passed')
