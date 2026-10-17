/**
 * vite + vite-plugin-electron（TECH-ARCH §4.1 已定）。
 * main/preload 由 plugin 编译到 <app>/dist-electron/（CJS，包无 "type":"module"）；
 * renderer 走常规 React，dev server 起在 5173。
 * 注意：config root 在 src/renderer，main/preload 的 outDir 必须用绝对路径指回项目根。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'

const appRoot = __dirname

export default defineConfig({
  root: 'src/renderer',
  plugins: [
    react(),
    electron({
      main: {
        entry: path.resolve(appRoot, 'src/main/main.ts'),
        vite: {
          build: {
            outDir: path.resolve(appRoot, 'dist-electron'),
            // dev 下 main 重建不能删掉 preload 产物（两者共用 outDir）；清理由 build script 先做
            emptyOutDir: false,
          },
        },
      },
      preload: {
        input: path.resolve(appRoot, 'src/preload/index.ts'),
        vite: {
          build: {
            outDir: path.resolve(appRoot, 'dist-electron'),
            emptyOutDir: false,
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@tick/shared': path.resolve(appRoot, '../../packages/shared/src/index.ts'),
    },
  },
  build: {
    outDir: path.resolve(appRoot, 'dist/renderer'),
    emptyOutDir: true,
  },
})
