import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['three'],
  },
  build: {
    // three.js alone minifies to ~720 kB; app code stays well below this.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Vendor code changes rarely; separate chunks stay cached across app releases.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/](three|three-mesh-bvh)[\\/]/.test(id)) return 'three'
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
