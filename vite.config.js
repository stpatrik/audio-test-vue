import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// имя репозитория с GitHub
export default defineConfig({
  plugins: [vue()],
  base: '/audio-test-vue/'
})