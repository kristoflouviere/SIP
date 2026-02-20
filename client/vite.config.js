import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const devPort = Number(env.VITE_DEV_PORT || 5391)

  return {
    plugins: [react()],
    server: {
      port: devPort,
      strictPort: true
    },
    preview: {
      port: devPort + 1,
      strictPort: true
    }
  }
})
