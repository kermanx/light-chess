import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  // 相对路径产物：可部署到 GitHub Pages 项目页（/<repo>/）等任意子路径
  base: './',
  plugins: [vue()],
  server: {
    // 监听所有网卡（局域网可访问）；隧道场景下放行任意 Host 头
    host: true,
    allowedHosts: true,
  },
})
