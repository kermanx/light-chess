// 生成 dist/404.html：GitHub Pages 对 /s/<对局 id> 这类深路径回退到 404.html，
// 但构建产物资源是相对路径（vite base './'），深路径下会解析到错误位置。
// 普通 SPA 主机（包括 vite preview）回退到 index.html，因此两份入口都要
// 在 <head> 最前注入运行时 <base>，把相对资源指回站点根（剥掉 /s/<id> 后缀）。
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('dist/index.html', 'utf8')
const inject =
  '<script>document.write(\'<base href="\' + location.pathname.replace(/\\/(?:s\\/[^/]+|ai-test(?:\\/[a-f0-9-]{36})?)\\/?$/, \'/\') + \'"/\')</script>'
if (!html.includes('<head>')) throw new Error('dist/index.html 结构异常：找不到 <head>')
const entry = html.includes(inject) ? html : html.replace('<head>', `<head>\n    ${inject}`)
writeFileSync('dist/index.html', entry)
writeFileSync('dist/404.html', entry)
console.log('dist/index.html、404.html 已生成（对局与 AI 测试深路径 SPA 回退）')
