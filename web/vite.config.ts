import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:18787', ws: true },
      '/zashboard': 'http://127.0.0.1:18787',
      '/dashboard-ui': 'http://127.0.0.1:18787',
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'editor', test: /node_modules[\\/](@codemirror|@lezer|codemirror)[\\/]/ },
            { name: 'yaml', test: /node_modules[\\/](yaml|ajv)[\\/]/ },
          ],
        },
      },
    },
  },
})
