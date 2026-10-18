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
            rollupOptions: {
              // WorkBuddy 适配器用 node:sqlite 只读打开 workbuddy.db。构建期 Node 22 的
              // builtinModules 不含 sqlite（运行期 Electron 的 Node 24 才有），不显式 external 会被
              // vite 当成「浏览器外部依赖」换成空 stub → 运行期静默降级成空会话列表。
              external: ['node:sqlite'],
            },
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
