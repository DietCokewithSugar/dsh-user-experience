[English](README.md) · [简体中文](README.zh.md)

# dsh-user-experience

> DeepSeek Harness（DSH）UX 走查插件：**帮你发现项目中可能存在的用户体验问题——自动走查 React（TypeScript / JavaScript）与 Vue 3 源码，定位问题并给出具体优化建议。**
>
> v0.2 能力边界：支持 React + TypeScript / React + JavaScript / Vue 3、仅静态证据、不覆盖视觉类问题。

现有自动化检查（axe、Lighthouse）只能校验绝对规则——对比度够不够、有没有 alt。但体验问题的本质是**相对的**：删除前的二次确认，对偶尔操作的用户是保护，对每天处理上百条记录的操作员是损耗。脱离了"给谁用"，"体验问题"无法定义。

本插件把**目标用户画像（Persona）**作为走查的前置输入：所有问题判定都挂靠到明确画像上，无 persona 不出结论。走查在**开发阶段**就产出可行动、可定位、可复核的体验提示，而不是等上线后的用户反馈。

---

## 能力边界（v0.2 明确不做）

| 支持 | 解析引擎 |
|---|---|
| React + TypeScript（.ts / .tsx） | TypeScript 编译器 API（TSX） |
| React + JavaScript（.js / .jsx） | 同一引擎，.js 也可能含 JSX，统一按 TSX 解析 |
| Vue 3（.vue SFC） | `@vue/compiler-sfc` 拆分 + `@vue/compiler-dom` 模板 AST；`<script>` / `<script setup>` 块复用 TypeScript 引擎，行号平移到整个 .vue 文件 |

**明确不支持（检出时如实告知，不给低质量猜测）**：Svelte、Vue 2（SFC 语法与 @vue/compiler-sfc 不兼容）、小程序（.wxml）等。扩展细节见 [`dsh-user-experience-v0.2-spec.md`](dsh-user-experience-v0.2-spec.md)。

- 证据等级固定为 **static**（静态源码证据）；**不覆盖视觉类问题**：对比度、热区尺寸、文字截断、焦点顺序
- 不自动修复 / 不自动改代码：只给优化方向（"提醒开发者去看一眼"，不是判决书）
- 输入源仅源码；网站输入（v0.3）、设计图输入（v0.4）为预留路线

## 功能

| 能力 | 入口 | 说明 |
|---|---|---|
| Persona 初始化 | `/ux init` | 模型从 README / package.json / 路由结构生成 1-3 个画像草稿，**经用户确认后**写入 `.ux/personas.yml`；文件已存在时直接加载，不重复询问 |
| Persona 上下文注入 | 自动 | 每次请求按当前项目注入生效画像与走查协议（对齐 AGENTS.md section provider 模式） |
| 源码走查 | `/ux scan` | 先确定范围（架构说明优先，否则询问功能/流程），再逐 persona 独立走查、合并成一份报告；9 条高置信度规则，模型判断为主、AST 求证为辅 |
| 问题确认闭环 | 报告卡片 | 每条 finding 带 locator 与「成立 / 不成立」按钮；判定写入会话日志，重放完整恢复 |
| 报告输出 | 自动 | Markdown 按 P0→P3 排序，共性问题（≥2 画像命中）在前；仅 confirmed 计入最终清单 |
| 术语表 | 自动 | R-02 判定增量持久化到 `.ux/glossary.yml`，后续只做增量比对 |

### 9 条规则（v0.1）

| ID | 规则 | 验证路径 |
|---|---|---|
| R-01 | 错误提示无行动指引 | 模型（AST 仅提取错误分支文案） |
| R-02 | 术语不一致（条件触发：仅当本轮无 P0/P1） | 模型（AST 仅提取候选位置） |
| R-03 | 不可逆操作文案泛化 | 模型 |
| R-04 | 不可逆操作缺二次确认 | model+ast |
| R-05 | 有 loading 无 empty | model+ast |
| R-06 | 有 success 无 error | model+ast |
| R-07 | 提交中按钮未禁用 | model+ast |
| R-08 | 无超长内容兜底 | model+ast |
| R-09 | 深色/浅色模式适配缺失 | **ast**（快车道，零 token） |

严重度由矩阵推导：`impact`（是否阻断关键任务，模型给出）× `reach`（受影响用户占目标用户比例，由命中画像的 `share` 之和推导，≥0.5 为 wide）→ P0/P1/P2/P3。

### 仓库文件约定

| 文件 | 是否提交 git | 说明 |
|---|---|---|
| `.ux/personas.yml` | ✅ 提交 | 项目级共识，团队共享；CI 模式依赖它 |
| `.ux/glossary.yml` | ✅ 提交 | 术语表与判定，复用价值高 |
| `.ux/rules.local.yml` | ❌ gitignore（v0.1 预留） | 个人走查偏好（关规则、重点方向、排除目录），不强加给团队 |

建议在项目 `.gitignore` 中加入：

```gitignore
.ux/rules.local.yml
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
```

## 使用

```text
/ux init                          # 初始化目标用户画像（草稿 → 确认 → 落盘）
/ux scan 订单流程从选品到支付      # 发起走查（先定范围，再逐 persona 走查）
# 报告卡片上逐条点击「成立 / 不成立」——仅 confirmed 计入最终清单
```

## 开发

```sh
pnpm install
pnpm run build     # tsdown（node half + client bundle）+ tsc（类型声明）
pnpm test          # 冒烟测试（AST 引擎 / persona / glossary / 矩阵 / 全链路）
```

- **版本锁定**：DSH 处于 developer preview，接口会变。本仓库依赖锁定在 `@deepseek-ai/dsh-*@0.1.0-rc.6`（`@deepseek-ai/cordis@4.0.1`）；升级框架前先在本地跑通。
- 结构：`src/index.ts` 为 Host 插件（命令 + 提示词注入 + 三个模型工具）；`src/client/` 为 Web 客户端插件（报告卡片，经 `dsh.client` 声明被模块表发现）；一个 bundle 行（`cordis.patch.yml`）同时挂载两者。
- 红线：不修改 agent-loop——所有能力挂在文档化扩展点（`ctx.commands` / `ctx.systemPrompt.section()` / `ctx.tools.register()` / `SessionEventMap`）上。

## 发布检查项

- [x] README 安全提示（见上方「安装」）
- [x] README 声明 v0.2 能力边界（React TS/JS + Vue 3、仅静态证据、不覆盖视觉类问题）
- [x] v0.2 技术栈扩展说明文档（`dsh-user-experience-v0.2-spec.md`）
- [x] 锁定 DSH 依赖版本（developer preview）
- [x] 仓库添加 **`dsh-plugin`** topic（官方发现机制）
- [x] 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR，中英文 README 各加一行（站点合并后自动同步）——[PR #63 已合并](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/63)，[文案更新 PR #66](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/66)
- [ ] 加入官方 Discord 社区（人工操作，见官方文档/仓库的邀请链接）

## License

MIT
