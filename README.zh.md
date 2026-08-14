[English](README.md) · [简体中文](README.zh.md)

# dsh-user-experience

> DeepSeek Harness（DSH）UX 走查插件：**让 AI 模拟目标用户，在开发阶段提前发现用户体验问题，并给出具体优化建议。**
>
> 能力边界：支持 React + TypeScript / React + JavaScript / Vue 3、CSS/布局分析；当前 Harness 会话能够打开项目时，可进一步获取浏览器证据。

🎉 已收录至 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

现有自动化检查（axe、Lighthouse）只能校验绝对规则——对比度够不够、有没有 alt。但体验问题的本质是**相对的**：删除前的二次确认，对偶尔操作的用户是保护，对每天处理上百条记录的操作员是损耗。脱离了"给谁用"，"体验问题"无法定义。

本插件把**目标用户画像（Persona）**作为走查的前置输入：所有问题判定都挂靠到明确画像上，无 persona 不出结论。AI 会以这些目标用户的视角模拟使用过程，在**开发阶段**提前发现体验问题，并给出具体、可定位、可复核的优化建议，而不是等上线后再收集用户反馈。

**它是流水线，不是命令行工具。**改完前端代码，走查自己就跑了——不用记命令，不用逐步点确认。报告卡片优先展示用户关心的信息（哪个页面、出了什么事、严不严重），技术细节折叠在后面、一键复制给 AI。判定也不用敲 ID：点按钮，或者直接说「第 2 条不成立」「三级以下全部忽略」。

## 在 Harness 中安装

在 DeepSeek Harness 中输入：

> 在 DeepSeek Harness 上安装用户体验插件：`dsh plugin --profile web add github:DietCokewithSugar/dsh-user-experience`

也可以直接执行：

```sh
dsh plugin --profile web add github:DietCokewithSugar/dsh-user-experience
```

安装完成后，重启 DSH 或重新加载 `web` profile。GitHub 插件会在安装阶段执行构建脚本；安装前请阅读下方[安全提示](#安装)，生产环境建议锁定可信 commit。

## 界面预览

走查报告先用简单清晰的语言说明观察到的现象及其对用户的影响：

![安装后在 Harness 中显示的 UX 走查报告卡片](docs/images/ux-report-card.png)

确认问题属实后，卡片会提供一份可复制给其他 AI 的任务 Prompt。它只描述观察到的现象，不预设代码改法；同时提醒 AI 先阅读完整项目上下文，并明确允许修改界面文案：

![确认 UX 问题后出现复制给 AI 的任务 Prompt 按钮](docs/images/ux-confirmed-prompt.png)

多级证据会显示在技术细节中，视觉与交互结论都能追溯到对应截图、DOM 测量或任务步骤：

![包含 rendered 与 static 证据等级的 UX 报告](docs/images/ux-multi-evidence.png)

报告卡片和确认流程可以跟随开发者使用的语言（下图为示例数据）：

![包含 interactive 证据的英文 UX 报告卡片](docs/images/ux-english-report.png)

---

## 支持的输入与证据

| 支持 | 解析引擎 |
|---|---|
| React + TypeScript（.ts / .tsx） | TypeScript 编译器 API（TSX） |
| React + JavaScript（.js / .jsx） | 同一引擎，.js 也可能含 JSX，统一按 TSX 解析 |
| Vue 3（.vue SFC） | `@vue/compiler-sfc` 拆分 + `@vue/compiler-dom` 模板 AST；`<script>` / `<script setup>` 块复用 TypeScript 引擎，行号平移到整个 .vue 文件 |
| CSS / SCSS / Sass / Less / PostCSS | 保守提取间距、紧凑布局与装饰内容候选；视觉结论仍需真实页面证据 |
| 真实页面（可选） | 当前会话有浏览器/截图工具且项目可运行时，检查相关路由和视口 |
| Persona 任务模拟（可选） | 可以在浏览器中执行关键任务时，记录操作步骤并评估流程冗余 |

**明确不支持（检出时如实告知，不给低质量猜测）**：Svelte、Vue 2（SFC 语法与 @vue/compiler-sfc 不兼容）、小程序（.wxml）等。证据等级、产品类型与语言策略见[当前实现规格](dsh-user-experience-v0.3-spec.md)。

- 每条结论标记为 **`static`、`rendered` 或 `interactive`**。浏览器能力是可选项：不可用时继续静态走查，不会假装看过页面
- 布局密度、视觉语言和主要操作层级问题至少需要 rendered 证据；流程冗余问题至少需要 interactive 任务记录
- 不自动改代码：插件先给优化建议；用户确认问题后，再生成一份现象导向的任务 Prompt 交给编码 AI
- CSS 只能提供检查线索；没有真实路由截图时，不会断言页面留白、层级或视觉质量存在问题

## 功能

| 能力 | 入口 | 说明 |
|---|---|---|
| Persona 初始化 | `/ux init` | 模型从 README / package.json / 路由结构生成 1-3 个画像草稿，**经用户确认后**写入 `.ux/personas.yml`；文件已存在时直接加载，不重复询问 |
| Persona 上下文注入 | 自动 | 每次请求按当前项目注入生效画像与走查协议（对齐 AGENTS.md section provider 模式） |
| 源码与 CSS 走查 | `/ux scan` | 先确定范围，再逐 persona 独立走查、合并成一份报告；以 Nielsen 原则为基础的 27 条规则，模型判断为主、AST/CSS 求证为辅 |
| 按产品类型调整重点 | 自动 | 从项目文档和本次业务流程判断 `consumer`、`enterprise`、`ecommerce`、`content`、`finance`、`healthcare`、`developer-tool`、`internal-tool` 或 `other`，使用对应的体验要求 |
| 三级证据 | 自动 | 源码/CSS 为 `static`，真实截图/DOM/尺寸为 `rendered`，记录 Persona 任务步骤后为 `interactive`；缺少浏览器能力时自动降级 |
| 输出语言 | 自动 / 配置 | 显式配置 `outputLanguage` 时优先使用；`auto` 模式下先跟随当前用户语言，再回退到项目主 README。报告卡片和 AI 任务 Prompt 支持中英文 |
| **改动触发的自动走查** | 自动 | 改完前端文件，回合收尾时自动对**所属的完整组件 / 页面**跑一次走查（不是 diff 那几行——缺失型问题在 diff 里根本不存在）；安静出报告，只在一级 / 二级问题时提示一句 |
| 报告卡片 | 自动 | 首屏只展示关键信息：`[一级问题] 管理员页面` + 一句话说清出了什么事 + 用户会遇到什么；文件路径、规则 ID、内部编号折叠在「技术细节」里，展开后一键复制成结构化 YAML 直接粘给 AI |
| 问题确认闭环 | 卡片按钮 / 直接说话 | 点「确认存在 / 不是问题」，或直接说「第 2 条不成立」「这几条都对」「三级以下全部忽略」——**全程不需要记任何编号**；判定写入会话日志，重放完整恢复 |
| 确认后生成 AI 任务 Prompt | 卡片按钮 | 用户确认问题属实后，一键复制包含观察现象、发生场景、用户影响与验收目标的任务 Prompt；**不预设具体代码改法**，明确说明插件只读到部分代码、要求 AI 补齐完整上下文，文案问题允许直接修改文案 |
| 隐式确认 | 自动 | 下次走查时某条问题消失、且那个位置确实被重新扫描 = 用户把它改掉了 = 这条成立。用户什么都不用点，而这个信号比人工点确认更硬 |
| 报告输出 | 自动 | Markdown 按严重度排序（**上界面用一级~四级问题，P0~P3 退为内部标识**），共性问题（≥2 画像命中）在前 |
| 术语表 | 自动 | R-02 判定增量持久化到 `.ux/glossary.yml`，后续只做增量比对 |

### 三档运行模式（按场景自动选择）

| 模式 | 行为 | 什么时候用上 |
|---|---|---|
| `auto` | 跑完直接出报告，不打断、不索要确认 | CI / headless；**改动自动触发的走查**（agent 自己发起的，就该由 agent 自己消化） |
| `review` | 出报告后一次性批量确认（勾选多条一并提交） | 用户主动发起 `/ux scan` |
| `interactive` | 逐条确认 | 需要精细调优规则时手动指定 |

判定顺序：`--mode=` 显式指定 → `.ux/rules.local.yml` 的 `mode` → 插件配置 → 自动探测。

### 问题的五态状态机

| 状态 | 含义 |
|---|---|
| `pending` | 尚未判定 |
| `confirmed_explicit` | 用户点了「确认存在」 |
| `confirmed_implicit` | 下次走查中消失，且该位置确实被重新扫描 |
| `rejected` | 用户点了「不是问题」 |
| `stale` | 该位置本次未被扫描（或代码已整块删除），无法判定 |

指标计算时两种 confirmed 合并计入有效问题，`stale` **不计入分母**——必须区分「扫了没发现」与「根本没扫」，否则"删代码"会被误判成"改进"。

### 高频问题优先顺序

走查按常见程度优先检查：① 反馈与系统状态；② 表单与流程恢复；③ 信息架构、导航和主要操作；④ 认知负荷、一致性、边缘状态、基础可用性与性能。检查顺序用于提高发现效率，最终报告仍按实际严重度排序。

### 27 条规则

| ID | 规则 | 验证路径 |
|---|---|---|
| R-01 | 错误提示无行动指引 | 模型（AST 仅提取错误分支文案） |
| R-02 | 术语不一致（条件触发：仅当本轮无一级 / 二级问题） | 模型（AST 仅提取候选位置） |
| R-03 | 不可逆操作文案泛化 | 模型 |
| R-04 | 不可逆操作缺二次确认 | model+ast |
| R-05 | 有 loading 无 empty | model+ast |
| R-06 | 有 success 无 error | model+ast |
| R-07 | 提交中按钮未禁用 | model+ast |
| R-08 | 无超长内容兜底 | model+ast |
| R-09 | 深色/浅色模式适配缺失 | **ast**（快车道，零 token） |
| R-10 | 布局拥挤或分组层级不清 | 源码/CSS 候选 + **必须有 rendered 证据** |
| R-11 | 长列表缺少分页、虚拟滚动、折叠或数量限制 | model+ast；可以 static 风险结论输出 |
| R-12 | Emoji/装饰元素与视觉语言不一致 | 源码/CSS 候选 + **必须有 rendered 证据** |
| R-13 | 页面用途或主要操作不清 | 源码候选 + **必须有 rendered 证据** |
| R-14 | 关键任务存在冗余交互 | **必须有 interactive Persona 任务记录** |
| R-15 | 功能分类不符合用户任务 | **必须有 interactive 功能寻找记录** |
| R-16 | 导航层级过深或缺少位置感 | **必须有 interactive 导航记录** |
| R-17 | 长时间操作缺少进度反馈 | model+ast；static 证据 |
| R-18 | 表单字段或必填项过多 | 源码候选 + **必须有 rendered 证据** |
| R-19 | 表单校验反馈过晚 | **必须有 interactive 表单任务记录** |
| R-20 | 中途退出会丢失表单进度 | **必须有 interactive 离开/恢复记录** |
| R-21 | 缺少退出、取消或撤销路径 | **必须有 interactive 任务记录** |
| R-22 | 选项过多且缺少默认值或推荐 | 源码候选 + **必须有 rendered 证据** |
| R-23 | 同一操作跨页面不一致 | **必须有 rendered 跨页面证据** |
| R-24 | 相似组件的行为不一致 | **必须有 interactive 对比记录** |
| R-25 | 首次使用、离线或无权限状态缺失 | model+ast；static 范围证据 |
| R-26 | 对比度、字号或触控热区影响使用 | **必须有 rendered 测量证据** |
| R-27 | 响应速度影响关键任务 | **必须有 interactive 计时证据** |

严重度由矩阵推导：`impact`（是否阻断关键任务，模型给出）× `reach`（受影响用户占目标用户比例，由命中画像的 `share` 之和推导，≥0.5 为 wide）→ 一级 / 二级 / 三级 / 四级问题（内部仍是 P0~P3，但不上界面）。

### 仓库文件约定

| 文件 | 是否提交 git | 说明 |
|---|---|---|
| `.ux/personas.yml` | ✅ 提交 | 项目级共识，团队共享；CI 模式依赖它 |
| `.ux/glossary.yml` | ✅ 提交 | 术语表与判定，复用价值高 |
| `.ux/rules.local.yml` | ❌ gitignore | 个人走查偏好，不强加给团队。支持 `mode` 与 `autoScan`，其余键宽容忽略 |
| `.ux/history.jsonl` | ❌ gitignore | 指纹历史账本：指纹、首次/末次出现、终态、每次走查的 scope。这是**长期指标数据**，不是判定结果 |

建议在项目 `.gitignore` 中加入：

```gitignore
.ux/rules.local.yml
.ux/history.jsonl
```

个人偏好文件示例：

```yaml
# .ux/rules.local.yml
mode: review        # 固定运行模式；不写则按场景自动选择
autoScan:
  enabled: true     # 改动触发的自动走查开关
  debounceTurns: 1  # 两次自动走查之间的最小回合间隔
```

---

## 安装

> ⚠️ **安全提示（必读）**
>
> 从 GitHub 安装的插件会在**安装时在你的机器上执行构建脚本**（本仓库通过 `prepare` 脚本从源码构建发布产物；pnpm ≥ 10 首次 `add` 时还会要求你在 profile 的 `pnpm-workspace.yaml` 中显式 allowlist 该构建）。这等于**授予该包在安装阶段执行代码的权限**，位于 agent 沙箱之外。
>
> 因此：
> 1. **只安装你信任来源的插件**——安装即执行；
> 2. **锁定 commit**，防止后续推送悄悄改变安装时执行的代码：
>
> ```sh
> dsh plugin --profile <你的profile> add github:DietCokewithSugar/dsh-user-experience#<commit-sha>
> ```
>
> 如果不想授予构建权限，也可以从 npm 安装预构建产物：`dsh plugin add dsh-user-experience`。

安装完成后，插件行（id `ux-experience`）进入配置层；重启 `dsh` 或重新加载 profile 生效。可用配置项（在 profile 的 `cordis.patch.yml` 或 `--patch` 层按 id 覆盖）：

```yaml
- id: ux-experience
  config:
    maxScanFiles: 300            # 单次扫描收集的最大文件数
    maxCandidatesPerRule: 5      # 每条规则每文件的最大候选数
    maxCandidatesPerFile: 25     # 每文件候选总数上限
    maxFindings: 30              # 单份报告最大 finding 数
    excludePatterns: ['test', 'stories']   # 额外跳过目录（在默认排除之上）
    mode: detect                 # detect|auto|review|interactive（默认按场景自动选择）
    autoScan: true               # 改动触发的自动走查（默认开）
    autoScanEditTools: ['write', 'edit']   # 视为"文件编辑"的工具名
    autoScanMaxFiles: 20         # 单次自动走查最多纳入的改动文件数
    autoScanDebounceTurns: 1     # 两次自动走查之间的最小回合间隔
    outputLanguage: auto          # auto|zh-CN|en
```

用户的 `.ux/rules.local.yml` 优先级高于本层配置。

## 使用

```text
/ux init                                  # 初始化目标用户画像（草稿 → 确认 → 落盘）
/ux scan 订单流程从选品到支付              # 发起走查（先定范围，再逐 persona 走查）
/ux scan 管理员页面 --mode=auto            # 显式指定运行模式（不写就按场景自动选）
```

报告出来之后，**点卡片上的按钮，或者直接说话**：

```text
第 2 条不成立
这几条都对
三级以下全部忽略
删除那条我确认
```

确认某条问题后，点击该卡片上的「复制给 AI 的任务 Prompt」，即可粘贴给编码 Agent。Prompt 会聚焦用户实际看到的现象，不会根据局部源码猜测具体实现方案。

改完前端代码（包括 CSS）则完全不用管：回合收尾时自动跑一次静态走查，安静出报告，只有一级 / 二级问题才提示你一句。用户主动发起的走查会在工具可用时进一步获取浏览器截图并执行 Persona 任务。

## 开发

```sh
pnpm install
pnpm run build     # tsdown（node half + client bundle）+ tsc（类型声明）
pnpm test          # 冒烟测试（AST/CSS / 证据等级 / 语言适配 / persona / 模式 / 账本 / 全链路）
```

- **版本锁定**：DSH 处于 developer preview，接口会变。本仓库依赖锁定在 `@deepseek-ai/dsh-*@0.1.0-rc.6`（`@deepseek-ai/cordis@4.0.1`）；升级框架前先在本地跑通。
- 结构：`src/index.ts` 为 Host 插件（命令 + 提示词注入 + 四个模型工具 + 改动触发的自动走查）；`src/client/` 为 Web 客户端插件（报告卡片，经 `dsh.client` 声明被模块表发现）；一个 bundle 行（`cordis.patch.yml`）同时挂载两者。
- 红线：不修改 agent-loop——所有能力挂在文档化扩展点（`ctx.commands` / `ctx.systemPrompt.section()` / `ctx.tools.register()` / `SessionEventMap` / `tools/result` / `agent/turn-stopping`）上。自动走查用的正是框架里 `/loop` 的原生形态：监听器在回合收尾时 `agent.steer()`，机器重读 inbox 再跑一步。

## License

MIT
