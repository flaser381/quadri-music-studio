import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  // abcjs (sheet music) is its own lazy chunk of ~510 kB
  build: { chunkSizeWarningLimit: 600 },
  server: {
    port: 5175,
    proxy: { '/api': 'http://127.0.0.1:8096', '/files': 'http://127.0.0.1:8096' },
  },
})
