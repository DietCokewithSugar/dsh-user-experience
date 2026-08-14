# dsh-user-experience v0.2 技术栈扩展说明

> 文档性质：v0.2 技术栈维度扩展的执行说明，是 [v0.1 spec](dsh-user-experience-v0.1-spec.md) 的增量补充。
> 版本：v0.2（技术栈扩展：React + JavaScript / Vue 3）
> 状态：已完成

---

## 1. 背景

v0.1 能力边界为「仅 React + TypeScript」，spec §3 明确「单一技术栈才能把这批规则做准，扩展留待规则质量验证之后」。v0.2 在规则目录不变（仍是 9 条）的前提下扩展技术栈维度：

- **React + JavaScript**：复用既有引擎，成本最低；
- **Vue 3（.vue SFC）**：引入官方解析器（`@vue/compiler-sfc` + `@vue/compiler-dom`），9 条规则全栈对齐。

扩展决策（用户确认）：9 条规则全栈对齐；引入官方解析器依赖；分阶段交付（React+JS 先行、Vue 3 随后，各自独立验证）；文档与版本号同步更新（0.1.0 → 0.2.0）。

---

## 2. 技术栈矩阵

| 技术栈 | 支持 | 解析引擎 | 说明 |
|---|---|---|---|
| React + TypeScript（.ts / .tsx） | ✅ | TypeScript 编译器 API（TSX） | v0.1 既有能力 |
| React + JavaScript（.js / .jsx） | ✅ | 同一引擎，统一 TSX 解析 | .js 也可能含 JSX，TSX 是其超集 |
| Vue 3（.vue SFC + 独立 .ts/.js 模块） | ✅ | `@vue/compiler-sfc` 拆分 + `@vue/compiler-dom` 模板 AST；script 块复用 TS 引擎 | Vue 3 的 SFC 语法与 @vue/compiler-sfc 对齐 |
| Vue 2 | ❌ 明确告知 | — | SFC 语法与 @vue/compiler-sfc 不兼容；检出版本号 `2.x` 即拒绝 |
| Svelte | ❌ 明确告知 | — | 后续扩展规划中（官方 compiler 提供完整 AST） |
| 小程序（.wxml / .wxs） | ❌ 明确告知 | — | 无标准官方解析器，工作量最大，未纳入 |

拒绝时返回 `supported=false` 与明确原因（spec 边界场景 9），不给低质量猜测。

---

## 3. 技术栈探测（detectStack）

- `StackKind = 'react-ts' | 'react-js' | 'vue'`，驱动源文件收集与引擎分派；
- **React + TS**：`react` 依赖 且（tsconfig.json 或 .ts/.tsx 源文件）；
- **React + JS**：`react` 依赖 且 无 TS 证据（.js/.jsx 收集时也接受 .ts/.tsx，兼容混合仓库）；
- **Vue 3**：`vue` 或 `@vue/runtime-core` 依赖，或 .vue 源文件；依赖声明的 vue 版本为 `2.x` 时判为 Vue 2 并拒绝；
- 同时检出 react + vue 依赖：按 Vue 处理并在 stack 描述中提示「可能为 monorepo，请按目标应用收敛走查范围」（R6 范围流程由模型处理）；
- `.d.ts` 声明文件不参与任何技术栈证据与收集。

文件收集按栈分派扩展名：react-ts=[.ts,.tsx]、react-js=[.js,.jsx,.ts,.tsx]、vue=[.vue,.ts,.js]。

---

## 4. Vue 引擎架构（src/vue.ts）

一个 .vue 文件拆成两部分分别求证，合并输出：

### 4.1 script 块：复用 TypeScript 引擎

`<script setup>` / `<script>` 块内容交给既有 `extractCandidates`（ast.ts）解析：

- 默认按 TS 解析（无 JSX）；`lang="jsx"/"tsx"` 的 render 函数写法按 TSX 解析；
- 覆盖规则：R-01（catch 错误文案）、R-03（`Modal.confirm('确定')` 类泛化确认）、R-04（脚本内破坏性调用路径）、R-06（await 无 catch / catch 无反馈）；
- **行号平移**：块内行号 + 块内容首行在文件中的偏移 = 整个 .vue 文件的行号（locator 硬约束不降级）。

### 4.2 template 块：@vue/compiler-dom 真实模板 AST

`baseParse` 产出 ElementNode / DirectiveNode / InterpolationNode 等结构化节点，规则求证全部挂在结构节点上（对齐 spec A.1「为什么不用正则」）：

| 规则 | Vue 模板信号 |
|---|---|
| R-01 错误提示无行动指引 | `v-if` 条件含 error/fail/失败 的分支，子节点可见文案无行动指引词 |
| R-02 术语不一致 | 文本节点 / placeholder、aria-label、title、alt 静态属性 / 字符串字面量插值 |
| R-03 不可逆文案泛化 | Popconfirm 类组件的 title / ok-text 为泛化确认文案 |
| R-04 不可逆缺二次确认 | 事件处理器表达式直接调用破坏性操作（delete/remove/clear…），且该元素子树 + 两级祖先内无 Modal/Dialog/Popconfirm 确认元素 |
| R-05 有 loading 无 empty | 模板存在 v-if 加载分支与 v-for 渲染，且全文无空态信号 |
| R-06 有 success 无 error | 仅脚本块（模板无异步） |
| R-07 提交中按钮未禁用 | button/Button 类元素，事件处理器异步（await 或 submit/save/confirm/delete/remove 处理器名），无 disabled / :disabled / :loading 绑定 |
| R-08 无超长内容兜底 | `{{ item.xxx }}` / `{{ row.xxx }}` 等外部字段插值，且模板与 style 块无截断信号（truncate/ellipsis/line-clamp） |
| R-09 深色模式适配缺失 | 静态 class 写死颜色类无 dark: 变体；:class 绑定表达式内颜色类无 dark:；静态 style / :style 绑定硬编码颜色字面量（verified_by: ast 快车道） |

**模板级判定是文件粒度**（React 引擎的函数粒度），比 React 更粗：候选 note 中明确要求模型复核「信号与结论是否同属一个列表 / 一条操作路径」。R-04 的确认上下文判断做了两个层级的祖先 + 子树检查，覆盖组件库 Modal/Dialog/Popconfirm 包裹按钮的常见形态。

### 4.3 候选预算

- script 与 template 各自享有 `maxCandidatesPerFile` 预算（一个 SFC 合并 ≤ 2× 上限）；
- `maxCandidatesPerRule` 在 script + template 之间**共享**（先 script 后 template，公平性略有偏向 script，可接受）；
- R-02 术语候选每文件 ≤ 12 条去重，与 React 引擎同口径。

---

## 5. 引擎分派（ux_scan）

`ux_scan` 执行路径按 `StackKind` 分派：

```
detectStack(cwd) → 不支持则 supported=false + 明确原因
                 → gatherFiles(按栈扩展名收集)
                 → 逐文件：.vue → extractVueCandidates
                           vue 栈 .ts/.js → TS 引擎（无 JSX）
                           react 栈 → TSX 引擎
                 → 文件清单 + 候选 + 术语表 + guidance
```

---

## 6. 测试覆盖

- `scripts/smoke.ts`：
  - React+JS 探测、.jsx 收集、.d.ts 跳过、.jsx R-09 快车道；
  - Vue 3 / Vue 2 探测分支；
  - Vue SFC fixture 一次性覆盖全部 9 条规则，含：R-04 确认上下文不误报（a-popconfirm 包裹）与无确认命中、模板/脚本行号平移断言、行号不越界、symbol=组件名、locator 完整性；
- `scripts/e2e.ts`：新增 Vue 3 项目全链路（探测 → 收集 → 分派 → R-09/R-06/R-04/R-08 候选带 locator）。

---

## 7. 未做（后续路线）

- Svelte（spec 预留方向）：`svelte/compiler` 提供完整 AST，模板语法差异最大，独立排期；
- 小程序：无标准官方解析器，暂不纳入；
- Vue 模板级 R-04/R-05 的上下文精细化：当前是文件粒度 + 两级祖先/子树检查，如实测误报偏高可引入「同一 v-if 分支 / 同一 handler」的路径级判定（对齐 React 的两层函数判定）；
- 视觉类问题、网站输入、设计图输入仍按 v0.1 路线图预留。
