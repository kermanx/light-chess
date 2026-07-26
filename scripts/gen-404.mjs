// 生成 dist/404.html：GitHub Pages 对 /s/<对局 id> 这类深路径回退到 404.html，
// 但构建产物资源是相对路径（vite base './'），深路径下会解析到错误位置。
// 在 <head> 最前注入运行时 <base>，把相对资源指回站点根（剥掉 /s/<id> 后缀）。
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('dist/index.html', 'utf8')
const inject =
  '<script>document.write(\'<base href="\' + location.pathname.replace(/\\/s\\/[^/]+\\/?$/, \'/\') + \'"/\')</script>'
if (!html.includes('<head>')) throw new Error('dist/index.html 结构异常：找不到 <head>')
writeFileSync('dist/404.html', html.replace('<head>', `<head>\n    ${inject}`))
console.log('dist/404.html 已生成（/s/<id> 深路径 SPA 回退）')
