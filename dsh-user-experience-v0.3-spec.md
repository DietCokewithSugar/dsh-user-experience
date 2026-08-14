# dsh-user-experience v0.3 — 多证据与产品自适应走查

## 目标

在现有 React/Vue 静态走查之上增加 CSS/布局候选、真实页面证据和 Persona
任务证据，同时保证：没有浏览器能力时正常降级，不把静态猜测包装成视觉结论。

## 证据等级

| 等级 | 必要证据 | 可以支持的结论 |
|---|---|---|
| `static` | 源码、AST、CSS、精确 locator | 文案、状态覆盖、主题适配、长列表结构风险 |
| `rendered` | 真实路由截图、DOM/尺寸测量或视口记录；`evidence_refs` 非空 | 留白、拥挤、视觉语言、主要操作层级 |
| `interactive` | 按 Persona 完成关键任务并记录步骤；`evidence_refs` 非空 | 重复跳转、重复输入、冗余弹窗/确认、流程可发现性 |

证据等级是下限而不是装饰标签：

- R-10、R-12、R-13 至少为 `rendered`；
- R-14 至少为 `interactive`；
- `ux_report` 在定稿时执行门槛校验，证据不足的草稿直接丢弃并说明原因；
- 浏览器、截图工具或可运行项目不存在时，继续完成 `static` 走查，不报错退出。

## 产品类型

每轮走查从 README、路由与当前业务流程判断产品类型：

`consumer | enterprise | ecommerce | content | finance | healthcare |
developer-tool | internal-tool | other`

产品类型只改变关注重点，不降低证据门槛。例如：

- 内部工具关注高密度信息下的层级、批量效率、误操作恢复；
- 电商关注商品发现、结算连续性和价格/库存信任信息；
- 金融与医疗关注风险说明、准确性、隐私和关键任务容错；
- 内容产品关注阅读层级、导航和长内容浏览。

“页面密集”“使用 Emoji”等都不是绝对问题，必须结合 Persona、产品类型和真实
证据判断。

## 执行顺序

1. 确定功能、页面或业务流程范围；
2. 判断产品类型与输出语言；
3. 逐 Persona 调用 `ux_scan`，扫描组件、Vue 模板和相邻 CSS；
4. 阅读候选位置核实 static 证据；
5. 浏览器/截图工具可用时检查相关路由和视口，记录 rendered 引用；
6. 能执行关键任务时按 Persona 操作并记录步骤，形成 interactive 证据；
7. 调用 `ux_report` 合并，执行 persona、locator 与证据等级硬约束；
8. 按 impact × reach 排序输出。

## 输出语言

固定界面支持简体中文和英文。语言优先级：

1. 插件配置 `outputLanguage: zh-CN | en`；
2. `auto` 时，模型从当前用户请求识别的语言；
3. 项目主 README 的语言；
4. 无法判断时回退到英文。

模型生成的 `surface`、`headline`、`description`、建议和 Persona 名称应使用同一
输出语言；报告标题、卡片操作、状态和确认后的 AI 任务 Prompt 由 Host/Client
根据报告语言统一渲染。
