/**
 * 独立仓库的自包含 tsdown 配置（对齐官方插件发布约定，不依赖 monorepo 共享
 * 预设）。产出两部分：
 *
 * 1. Node half：`src/index.ts` → `lib/index.js`（ESM，所有依赖保持外部引用，
 *    由 profile 的 pnpm 依赖树在运行时解析）。类型声明由 `tsc -p tsconfig.json`
 *    单独产出到 `lib/types`。
 * 2. Client half：`src/client/index.ts` → `lib/client.js`（CJS + loader 契约）。
 */
import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-user-experience'

/** Web 客户端平台模块表（与 dsh-client-web 的 PLATFORM_MODULES 保持一致）。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** client-runtime 为 immediately-tier 行，其 /client 面由模块表原生应答。 */
const CLIENT_EXTERNALS = [
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    name: PLUGIN_ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
