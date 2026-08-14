[English](README.md) · [简体中文](README.zh.md)

# dsh-user-experience

> DeepSeek Harness（DSH）UX 走查插件：**帮你发现项目中可能存在的用户体验问题——自动走查 React（TypeScript / JavaScript）与 Vue 3 源码，定位问题并给出具体优化建议。**
>
> 能力边界：支持 React + TypeScript / React + JavaScript / Vue 3、仅静态证据、不覆盖视觉类问题。

现有自动化检查（axe、Lighthouse）只能校验绝对规则——对比度够不够、有没有 alt。但体验问题的本质是**相对的**：删除前的二次确认，对偶尔操作的用户是保护，对每天处理上百条记录的操作员是损耗。脱离了"给谁用"，"体验问题"无法定义。

本插件把**目标用户画像（Persona）**作为走查的前置输入：所有问题判定都挂靠到明确画像上，无 persona 不出结论。走查在**开发阶段**就产出可行动、可定位、可复核的体验提示，而不是等上线后的用户反馈。

**它是流水线，不是命令行工具。**改完前端代码，走查自己就跑了——不用记命令，不用逐步点确认。报告卡片先说人话（哪个页面、出了什么事、严不严重），技术细节折叠在后面、一键复制给 AI。判定也不用敲 ID：点按钮，或者直接说「第 2 条不成立」「三级以下全部忽略」。

---

## 能力边界（明确不做）

| 支持 | 解析引擎 |
|---|---|
| React + TypeScript（.ts / .tsx） | TypeScript 编译器 API（TSX） |
| React + JavaScript（.js / .jsx） | 同一引擎，.js 也可能含 JSX，统一按 TSX 解析 |
| Vue 3（.vue SFC） | `@vue/compiler-sfc` 拆分 + `@vue/compiler-dom` 模板 AST；`<script>` / `<script setup>` 块复用 TypeScript 引擎，行号平移到整个 .vue 文件 |

**明确不支持（检出时如实告知，不给低质量猜测）**：Svelte、Vue 2（SFC 语法与 @vue/compiler-sfc 不兼容）、小程序（.wxml）等。技术栈扩展细节见 [`dsh-user-experience-v0.2-spec.md`](dsh-user-experience-v0.2-spec.md)，形态修订见 [`dsh-user-experience-v0.1.1-spec.md`](dsh-user-experience-v0.1.1-spec.md)。

- 证据等级固定为 **static**（静态源码证据）；**不覆盖视觉类问题**：对比度、热区尺寸、文字截断、焦点顺序
- 不自动修复 / 不自动改代码：只给优化方向（"提醒开发者去看一眼"，不是判决书）
- 输入源仅源码；网站输入（v0.3）、设计图输入（v0.4）为预留路线

## 功能

| 能力 | 入口 | 说明 |
|---|---|---|
| Persona 初始化 | `/ux init` | 模型从 README / package.json / 路由结构生成 1-3 个画像草稿，**经用户确认后**写入 `.ux/personas.yml`；文件已存在时直接加载，不重复询问 |
| Persona 上下文注入 | 自动 | 每次请求按当前项目注入生效画像与走查协议（对齐 AGENTS.md section provider 模式） |
| 源码走查 | `/ux scan` | 先确定范围（架构说明优先，否则询问功能/流程），再逐 persona 独立走查、合并成一份报告；9 条高置信度规则，模型判断为主、AST 求证为辅 |
| **改动触发的自动走查** | 自动 | 改完前端文件，回合收尾时自动对**所属的完整组件 / 页面**跑一次走查（不是 diff 那几行——缺失型问题在 diff 里根本不存在）；安静出报告，只在一级 / 二级问题时提示一句 |
| 报告卡片 | 自动 | 首屏只给人话：`[一级问题] 管理员页面` + 一句话说清出了什么事 + 用户会遇到什么；文件路径、规则 ID、内部编号折叠在「技术细节」里，展开后一键复制成结构化 YAML 直接粘给 AI |
| 问题确认闭环 | 卡片按钮 / 直接说话 | 点「确认存在 / 不是问题」，或直接说「第 2 条不成立」「这几条都对」「三级以下全部忽略」——**全程不需要记任何编号**；判定写入会话日志，重放完整恢复 |
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

### 9 条规则（v0.1）

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

严重度由矩阵推导：`impact`（是否阻断关键任务，模型给出）× `reach`（受影响用户占目标用户比例，由命中画像的 `share` 之和推导，≥0.5 为 wide）→ 一级 / 二级 / 三级 / 四级问题（内部仍是 P0~P3，但不上界面）。

### 仓库文件约定

| 文件 | 是否提交 git | 说明 |
|---|---|---|
| `.ux/personas.yml` | ✅ 提交 | 项目级共识，团队共享；CI 模式依赖它 |
| `.ux/glossary.yml` | ✅ 提交 | 术语表与判定，复用价值高 |
| `.ux/rules.local.yml` | ❌ gitignore | 个人走查偏好，不强加给团队。本版认识 `mode` 与 `autoScan`，其余键宽容忽略 |
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

改完前端代码则完全不用管：回合收尾时自动跑一次走查，安静出报告，只有一级 / 二级问题才提示你一句。

## 开发

```sh
pnpm install
pnpm run build     # tsdown（node half + client bundle）+ tsc（类型声明）
pnpm test          # 冒烟测试（AST 引擎 / persona / glossary / 矩阵 / 模式 / 指纹 / 账本 / 全链路）
```

- **版本锁定**：DSH 处于 developer preview，接口会变。本仓库依赖锁定在 `@deepseek-ai/dsh-*@0.1.0-rc.6`（`@deepseek-ai/cordis@4.0.1`）；升级框架前先在本地跑通。
- 结构：`src/index.ts` 为 Host 插件（命令 + 提示词注入 + 四个模型工具 + 改动触发的自动走查）；`src/client/` 为 Web 客户端插件（报告卡片，经 `dsh.client` 声明被模块表发现）；一个 bundle 行（`cordis.patch.yml`）同时挂载两者。
- 红线：不修改 agent-loop——所有能力挂在文档化扩展点（`ctx.commands` / `ctx.systemPrompt.section()` / `ctx.tools.register()` / `SessionEventMap` / `tools/result` / `agent/turn-stopping`）上。自动走查用的正是框架里 `/loop` 的原生形态：监听器在回合收尾时 `agent.steer()`，机器重读 inbox 再跑一步。

## 发布检查项

- [x] README 安全提示（见上方「安装」）
- [x] README 声明能力边界（React TS/JS + Vue 3、仅静态证据、不覆盖视觉类问题）
- [x] v0.2 技术栈扩展说明文档（`dsh-user-experience-v0.2-spec.md`）
- [x] v0.1.1 形态修订说明文档（`dsh-user-experience-v0.1.1-spec.md`）
- [x] 锁定 DSH 依赖版本（developer preview）
- [x] 仓库添加 **`dsh-plugin`** topic（官方发现机制）
- [x] 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR，中英文 README 各加一行（站点合并后自动同步）——[PR #63 已合并](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/63)，[文案更新 PR #66](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/66)
- [ ] 加入官方 Discord 社区（人工操作，见官方文档/仓库的邀请链接）

## License

MIT
