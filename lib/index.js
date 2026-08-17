import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomUUID } from "node:crypto";
import Schema from "@deepseek-ai/schemastery";
import ts from "typescript";
import { parse as parse$1 } from "@vue/compiler-sfc";
import { NodeTypes, baseParse } from "@vue/compiler-dom";
//#region src/local-rules.ts
/**
* 走查偏好文件 `.ux/rules.local.yml` 的读取（spec §5.4 / v0.1.1 §4.2、§5）。
*
* 定位是**个人偏好**：不提交仓库（gitignore），不强加给团队。用户表达过一次
* 的意愿不该在下一次走查中被再问一遍。
*
* 本版只认两个键——`mode`（运行模式）与 `autoScan`（R7 自动走查开关）。
* 其余键（按 ID 关闭规则、重点关注方向、排除目录等 v0.1 P1 项）**宽容忽略**，
* 后续补齐时不会破坏已有文件格式。解析失败同样不报错：偏好文件坏掉不应该
* 阻断走查，退回默认即可。
*/
const LOCAL_RULES_FILE = ".ux/rules.local.yml";
/** cwd → 最近一次读取结果（mtime + size 一致才命中）。 */
const cache$2 = /* @__PURE__ */ new Map();
function stampOf(file) {
	try {
		const st = statSync(file);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return;
	}
}
function localRulesPath(root) {
	return join(root, LOCAL_RULES_FILE);
}
function asMode$1(value) {
	return value === "auto" || value === "review" || value === "interactive" ? value : void 0;
}
function asAutoScan(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	const preference = {};
	if (typeof record.enabled === "boolean") preference.enabled = record.enabled;
	if (typeof record.debounceTurns === "number" && Number.isSafeInteger(record.debounceTurns) && record.debounceTurns >= 0) preference.debounceTurns = record.debounceTurns;
	return preference;
}
/**
* 读取偏好文件；文件缺失、不可解析或键型不对时返回空偏好（不抛错）。
* @param root - 项目根目录。
* @returns 本版认识的偏好项。
*/
function loadLocalRules(root) {
	const file = localRulesPath(root);
	const stamp = stampOf(file);
	if (stamp === void 0) {
		cache$2.delete(root);
		return {};
	}
	const hit = cache$2.get(root);
	if (hit !== void 0 && hit.stamp === stamp) return hit.rules;
	let rules = {};
	if (existsSync(file)) {
		let parsed;
		try {
			parsed = parse(readFileSync(file, "utf8"));
		} catch {
			parsed = void 0;
		}
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed;
			const mode = asMode$1(record.mode);
			const autoScan = asAutoScan(record.autoScan);
			rules = {
				...mode === void 0 ? {} : { mode },
				...autoScan === void 0 ? {} : { autoScan }
			};
		}
	}
	cache$2.set(root, {
		stamp,
		rules
	});
	return rules;
}
//#endregion
//#region src/heuristics.ts
/** Nielsen 十项可用性原则，作为所有产品类型共享的基础检查框架。 */
const NIELSEN_ZH = [
	"系统状态可见：操作、加载和后台处理要及时反馈",
	"符合现实世界：分类、术语和流程贴近用户任务与心智模型",
	"用户控制与自由：提供退出、返回、取消和撤销",
	"一致性与标准：相同概念、组件和操作保持一致",
	"预防错误：在错误发生前提供约束、默认值和确认",
	"识别优于回忆：让当前位置、可选路径和可执行操作可见",
	"灵活与高效：兼顾新用户引导和熟练用户的高频效率",
	"简洁设计：控制信息密度，突出主要任务",
	"帮助识别、诊断和恢复错误：说明原因与下一步",
	"帮助与文档：在复杂或首次使用场景提供就地指引"
];
const NIELSEN_EN = [
	"Visibility of system status: provide timely feedback for actions and background work",
	"Match with the real world: organize language and flows around user tasks and mental models",
	"User control and freedom: provide exit, back, cancel, and undo paths",
	"Consistency and standards: keep equivalent concepts, components, and actions consistent",
	"Error prevention: use constraints, defaults, and confirmation before errors occur",
	"Recognition rather than recall: expose location, destinations, and available actions",
	"Flexibility and efficiency: support first-time guidance and expert workflows",
	"Aesthetic and minimalist design: control information density and emphasize the primary task",
	"Recognize, diagnose, and recover from errors: explain the reason and the next action",
	"Help and documentation: provide contextual guidance for complex and first-use scenarios"
];
function nielsenGuidance(language) {
	return language === "zh-CN" ? NIELSEN_ZH : NIELSEN_EN;
}
const PRIORITY_ZH = [
	"优先一：反馈与系统状态（R-01、R-06、R-17）",
	"优先二：表单与流程恢复（R-18～R-21）",
	"优先三：信息架构、导航与主要操作（R-13、R-15、R-16）",
	"其后：认知负荷、一致性、边缘状态、基础可用性与性能"
];
const PRIORITY_EN = [
	"Priority 1: feedback and system status (R-01, R-06, R-17)",
	"Priority 2: forms, control, and flow recovery (R-18–R-21)",
	"Priority 3: information architecture, navigation, and primary actions (R-13, R-15, R-16)",
	"Then: cognitive load, consistency, edge states, basic usability, and performance"
];
/** 按常见程度安排检查顺序；最终报告仍按严重度排序。 */
function reviewPriority(language) {
	return language === "zh-CN" ? PRIORITY_ZH : PRIORITY_EN;
}
//#endregion
//#region src/human-copy.ts
/**
* 人话文案的硬性约束（v0.1.1 spec §3.5 / §9）。
*
* `human.description` 必须写"**用户会遇到什么**"，不写"代码里缺什么"：
*
* | ❌ 不要 | ✅ 要 |
* |---|---|
* | `handleDelete` 的 catch 分支中没有调用 toast | 删除失败时界面没有任何提示，用户以为删成功了 |
* | 缺少 empty state 分支 | 列表为空时页面一片空白，看不出是没数据还是加载失败 |
*
* 这条约束靠两处保障：提示词里给正反例，定稿时再做一道校验。
* 无法清楚描述用户影响的 finding 宁可不报。
*
* 校验刻意保守：只认"一眼就是代码"的特征（文件路径、反引号包裹的标识符、
* 函数调用形态、代码术语）。宁可漏掉几条夹带术语的描述，也不能把正常中文
* 描述误杀——误杀等于让插件不敢报。
*/
/** 反引号包裹的内容（模型引用代码时的典型写法）。 */
const BACKTICK = /`[^`]+`/u;
/** 函数调用形态：`handleDelete(`、`toast.error(`。 */
const CALL_FORM = /[A-Za-z_$][\w$]*\s*\(\s*\)|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/u;
/** 文件路径 / 扩展名。 */
const FILE_PATH = /\.(?:tsx?|jsx?|vue|css|scss)\b|(?:^|\s)(?:src|components|pages|views)\//u;
/**
* 代码腔术语：出现即判定为"在讲代码"。
* 只收那些在中文产品描述里几乎不会自然出现的词。
*/
const CODE_TERM = /\b(?:catch|try|await|async|props?|state|hook|useState|useEffect|componentDidMount|render|toast|dispatch|reducer|selector|className|v-if|v-for|setState|throw|promise|callback|api\s*调用|分支)\b/iu;
/** 结构性代码描述的中文说法（"缺少 xxx 分支""没有调用 xxx"）。 */
const CODE_PHRASE = /(?:缺少|没有|未)\s*(?:调用|实现|声明|绑定|定义)|分支(?:中|里)?(?:没有|缺)|函数(?:中|里)/u;
/**
* 判断一段描述是否是"代码腔"（在讲代码而不是讲用户遭遇）。
* @param text - 待检文本。
* @returns 命中的特征说明；不是代码腔时返回 undefined。
*/
function codeSpeakReason(text) {
	const value = text.trim();
	if (value.length === 0) return "描述为空";
	if (FILE_PATH.test(value)) return "描述里出现文件路径";
	if (BACKTICK.test(value)) return "描述里用反引号引用了代码符号";
	if (CALL_FORM.test(value)) return "描述里出现函数调用形态";
	if (CODE_TERM.test(value)) return "描述里出现代码术语";
	if (CODE_PHRASE.test(value)) return "描述在讲\"代码里缺什么\"而不是\"用户会遇到什么\"";
}
/** 写进提示词的正反例对照（spec §3.5 的表格）。 */
const HUMAN_COPY_RULE = [
	"human.description 必须写\"用户会遇到什么\"，不写\"代码里缺什么\"：",
	"  ❌「handleDelete 的 catch 分支中没有调用 toast」→ ✅「删除失败时界面没有任何提示，用户以为删成功了」",
	"  ❌「缺少 empty state 分支」→ ✅「列表为空时页面一片空白，看不出是没数据还是加载失败」",
	"无法清楚描述用户影响的 finding 宁可不报——定稿时带代码腔的描述会被丢弃。"
].join("\n");
//#endregion
//#region src/protocol.ts
/**
* 常驻走查协议（系统提示词）。
*
* 用户侧不再使用 `/ux` / `/ux init` / `/ux scan`。模型根据自然语言意图
* 自己决定是否上场；完整走查步骤写在这里，而不是写在命令的 followup 里。
*/
function renderPersonas(personas) {
	return personas.map((persona) => [
		`- [${persona.id}] ${persona.name}（share ${persona.share}）`,
		`  场景：${persona.scenario}`,
		`  目标：${persona.goals.join("；")}`,
		`  能力：技术素养 ${persona.capability.tech_literacy} / 设备 ${persona.capability.device} / 网络 ${persona.capability.network}` + (persona.capability.accessibility_needs.length > 0 ? ` / 无障碍 ${persona.capability.accessibility_needs.join(", ")}` : ""),
		`  关键路径：${persona.key_paths.join(" → ")}`
	].join("\n")).join("\n");
}
/** 意图门：什么时候上场，什么时候别动。 */
function intentGate() {
	return [
		"[dsh-user-experience] UX 走查插件已启用。用户用自然语言调用你，不要让用户敲任何斜杠命令，也不要在回复里教命令格式。",
		"",
		"何时上场：",
		"- 用户说走查、看看体验、这个页面/流程好不好用、用户会不会懵、检查交互/表单/下单等；",
		"- 用户描述目标用户（「我们主要给运营用」）→ 整理或改画像，确认后调用 ux_personas_write。",
		"",
		"何时不要上场：",
		"- 改 bug、写函数、解释代码、纯实现讨论——不要突然开始走查，也不要插嘴问画像；",
		"- 用户正在改代码时，不要打断。改完前端后的自动走查由插件在回合收尾自己发起，那次必须安静。"
	].join("\n");
}
/** 没有画像文件时：主动走查才确认，自动走查用草稿。 */
function lazyInitProtocol(brief) {
	return [
		"本项目还没有 .ux/personas.yml。没有可推断的用户才不出 UX 结论；有 README / 路由 / 产品描述就可以先猜。",
		"",
		"用户主动要走查时：",
		"1. 阅读 README / package.json / 路由与页面结构（项目素材简报附后），推断 1-3 个画像草稿，宁缺毋滥。",
		"2. 用短列表问一句「我按这些用户来看，对吗？」，每条只写名称、大致占比、一句话场景。不要倒 YAML。",
		"3. 用户说「就这些」或改一句之后，调用 ux_personas_write（status=confirmed）落盘，然后立刻走查。",
		"4. 完全没有线索时才问「这产品主要给谁用」。不要让用户先完成设置再享受能力。",
		"",
		"改动触发的自动走查（R7，agent 自己发起）时：",
		"- 立刻推断草稿并 ux_personas_write（status=draft），用草稿走查；",
		"- 全程不要提问、不要展示画像确认卡片、不要索要确认。",
		"",
		`项目素材简报：\n${brief.length > 0 ? brief : "（未收集到 README / package.json 摘要）"}`
	].join("\n");
}
/** 已有画像时的说明（含草稿校准）。 */
function renderExistingPersonas(personas, status) {
	if (status === "draft") return [
		"本项目目标用户画像是推断草稿（.ux/personas.yml status=draft），尚未经用户确认：",
		renderPersonas(personas),
		"",
		"用户主动走查时，用一句话说明「按这些用户来看」，不要再走完整确认关卡，除非用户要改。",
		"自动走查直接用这些草稿，不要提问。用户之后说「我们其实是给运营用的」再整理、确认、覆盖写入（status=confirmed）。"
	].join("\n");
	return [
		"本项目目标用户画像（.ux/personas.yml，走查的判定依据）：",
		renderPersonas(personas),
		"",
		"目标用户通常不变。用户要改画像时，整理后确认再调用 ux_personas_write（status=confirmed）覆盖写入。"
	].join("\n");
}
/** 走查步骤与铁律（原 /ux scan followup，现为常驻协议）。 */
function walkthroughProtocol() {
	return [
		"UX 走查协议（用户主动发起时按 review 模式；自动走查按插件注入的 auto 提示执行）：",
		"1. 确定范围：优先读架构说明提出范围建议；没有则问具体功能/页面/业务流程。范围未明前不扫大仓库。自动走查不要问范围，用改动所属的完整组件/页面。",
		"2. 根据 README、路由和当前流程判断 product_type；不同产品类型使用不同走查重点。",
		"3. 对每个 persona 调用 ux_scan（paths=范围目录，persona_id、product_type、language 显式传入），阅读候选核实，按该画像判定。",
		"4. 有浏览器/截图工具且项目可打开时检查相关路由和视口；只有附带截图、DOM 或尺寸证据才能标 rendered。按 persona 做完关键任务并记录步骤后才能标 interactive。不可用时退回 static，不得伪造。",
		"5. 全部画像走完后调用一次 ux_report 合并定稿。每条 finding 必须有 locator（file）和 persona_refs；写用户会遇到什么，不写代码里缺什么。",
		"6. 严重度由 impact（你给，是否阻断关键任务）× reach（命中画像 share 之和，>=0.5 为 wide）推导。一级 / 二级问题必须优先处理。",
		"7. R-02 仅当本轮没有一级 / 二级问题时才执行。宁缺毋滥，拿不准的候选丢掉。",
		`   Nielsen 基础框架：${nielsenGuidance("zh-CN").join("；")}。`,
		"   输出语言优先跟随当前用户，再跟随项目主 README。",
		"",
		"报告双读者：",
		`8. 给人看的：surface（人话页面名，拟不出用路由路径，不用文件路径）+ headline + description。`,
		`   ${HUMAN_COPY_RULE.split("\n").join("\n   ")}`,
		"9. 给 AI 看的：locator / rule / verified_by / severity，填进 technical。",
		"",
		"确认闭环：",
		"10. 用户说「第 2 条不成立」「这几条都对」「三级以下全部忽略」时调用 ux_judge。不要让用户报 ID 或敲命令。",
		"    自动走查（auto）不要索要确认；只有一级 / 二级问题才用一句话提示。"
	].join("\n");
}
/**
* R2 入口用的完整系统提示词片段。
* @param loaded - 已读出的画像文件；不存在时为 undefined。
* @param brief - 无画像时附上的项目素材简报。
*/
function buildPersonaSectionText(loaded, brief) {
	if (loaded === void 0) return [
		intentGate(),
		lazyInitProtocol(brief),
		walkthroughProtocol()
	].join("\n\n");
	return [
		intentGate(),
		renderExistingPersonas(loaded.personas, loaded.status),
		walkthroughProtocol()
	].join("\n\n");
}
//#endregion
//#region src/persona.ts
/**
* Persona 文件读写与校验。
*
* 存储位置：`.ux/personas.yml`（仓库内一等公民文件）。
* 推断草稿可先落盘（status=draft）供自动走查使用；用户确认后升为 confirmed。
* 本模块负责结构校验与缓存（按 cwd + mtime）。
*/
/** Persona 文件相对项目根的路径。 */
const PERSONAS_FILE = ".ux/personas.yml";
const PERSONA_ID = /^[a-z][a-z0-9_-]*$/u;
/** cwd → 最近一次读取结果（mtime 一致才命中）。 */
const cache$1 = /* @__PURE__ */ new Map();
function personasPath(root) {
	return join(root, PERSONAS_FILE);
}
function asStatus(value) {
	return value === "draft" ? "draft" : "confirmed";
}
/** 校验单条 persona，失败时抛出带上下文的 TypeError。 */
function validatePersona(value, where) {
	if (typeof value !== "object" || value === null) throw new TypeError(`${where}：persona 必须是对象`);
	const p = value;
	const needString = (key) => {
		const v = p[key];
		if (typeof v !== "string" || v.trim().length === 0) throw new TypeError(`${where}：${key} 必须是非空字符串`);
		return v;
	};
	const id = needString("id");
	if (!PERSONA_ID.test(id)) throw new TypeError(`${where}：id "${id}" 必须匹配 ${PERSONA_ID.toString()}`);
	const goals = p.goals;
	if (!Array.isArray(goals) || goals.length === 0 || goals.some((g) => typeof g !== "string" || g.length === 0)) throw new TypeError(`${where}：goals 必须是非空字符串数组`);
	const paths = p.key_paths;
	if (!Array.isArray(paths) || paths.some((g) => typeof g !== "string" || g.length === 0)) throw new TypeError(`${where}：key_paths 必须是字符串数组（可为空）`);
	const capability = p.capability;
	if (typeof capability !== "object" || capability === null) throw new TypeError(`${where}：capability 必须是对象`);
	const cap = capability;
	if (cap.tech_literacy !== "low" && cap.tech_literacy !== "medium" && cap.tech_literacy !== "high") throw new TypeError(`${where}：capability.tech_literacy 必须是 low | medium | high`);
	if (cap.device !== "mobile" && cap.device !== "desktop" && cap.device !== "both") throw new TypeError(`${where}：capability.device 必须是 mobile | desktop | both`);
	if (cap.network !== "stable" && cap.network !== "unstable") throw new TypeError(`${where}：capability.network 必须是 stable | unstable`);
	if (!Array.isArray(cap.accessibility_needs) || cap.accessibility_needs.some((n) => typeof n !== "string")) throw new TypeError(`${where}：capability.accessibility_needs 必须是字符串数组`);
	const share = p.share;
	if (typeof share !== "number" || !Number.isFinite(share) || share <= 0 || share > 1) throw new TypeError(`${where}：share 必须是 (0, 1] 之间的有限数字`);
	const extra = Object.keys(p).filter((key) => ![
		"id",
		"name",
		"scenario",
		"goals",
		"capability",
		"key_paths",
		"share"
	].includes(key));
	if (extra.length > 0) throw new TypeError(`${where}：未知字段 ${extra.join(", ")}`);
	return {
		id,
		name: needString("name"),
		scenario: needString("scenario"),
		goals,
		key_paths: paths,
		capability: {
			tech_literacy: cap.tech_literacy,
			device: cap.device,
			network: cap.network,
			accessibility_needs: cap.accessibility_needs
		},
		share
	};
}
/** 校验 personas 列表；id 必须唯一。 */
function validatePersonas(values, where) {
	const seen = /* @__PURE__ */ new Set();
	return values.map((value, index) => {
		const persona = validatePersona(value, `${where}[${index}]`);
		if (seen.has(persona.id)) throw new TypeError(`${where}：persona id "${persona.id}" 重复`);
		seen.add(persona.id);
		return persona;
	});
}
/** 校验 `.ux/personas.yml` 文件内容并转成强类型结构。 */
function parsePersonaFile(raw, where) {
	if (typeof raw !== "object" || raw === null) throw new TypeError(`${where}：顶层必须是对象`);
	const doc = raw;
	const extra = Object.keys(doc).filter((key) => key !== "personas" && key !== "status");
	if (extra.length > 0) throw new TypeError(`${where}：未知字段 ${extra.join(", ")}`);
	const personas = doc.personas;
	if (!Array.isArray(personas) || personas.length === 0) throw new TypeError(`${where}：personas 必须是非空数组`);
	return {
		status: asStatus(doc.status),
		personas: validatePersonas(personas, `${where}.personas`)
	};
}
/**
* 读取项目根目录下的 persona 文件（含 status）。
* @returns 画像与确认状态；文件不存在时返回 undefined。
*/
function loadPersonaFile(root) {
	const file = personasPath(root);
	let mtimeMs;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		cache$1.delete(root);
		return;
	}
	const hit = cache$1.get(root);
	if (hit !== void 0 && hit.mtimeMs === mtimeMs) return hit.loaded;
	const loaded = parsePersonaFile(parse(readFileSync(file, "utf8")), file);
	cache$1.set(root, {
		mtimeMs,
		loaded
	});
	return loaded;
}
/**
* 写入 `.ux/personas.yml`（`ux_personas_write` 工具的唯一写入口）。
* 写入前完整校验；返回落盘的 persona 列表。
*/
function writePersonas(root, personas, status = "confirmed") {
	const validated = validatePersonas(personas, `${PERSONAS_FILE} 写入`);
	const file = personasPath(root);
	mkdirSync(dirname(file), { recursive: true });
	const doc = {
		status,
		personas: [...validated]
	};
	writeFileSync(file, stringify(doc, { lineWidth: 100 }) + "\n", "utf8");
	const mtimeMs = statSync(file).mtimeMs;
	cache$1.set(root, {
		mtimeMs,
		loaded: {
			status,
			personas: validated
		}
	});
	return validated;
}
/**
* R2 入口：为一次系统提示词装配渲染 persona 片段。
* 每次装配按当前 agent 的 cwd 读取文件（带 mtime 缓存）。
*/
function renderPersonaSection(agent) {
	const cwd = agent?.session.header.cwd;
	if (cwd === void 0) return "";
	return buildPersonaSectionText(loadPersonaFile(cwd), collectInitBrief(cwd));
}
/** 收集生成画像草稿的素材简报：README 片段 + package.json + 顶层目录。 */
function collectInitBrief(root) {
	const parts = [];
	const readme = [
		"README.md",
		"readme.md",
		"README.zh.md"
	].map((name) => join(root, name)).find((file) => existsSync(file));
	if (readme !== void 0) {
		const text = readFileSync(readme, "utf8").slice(0, 3e3);
		parts.push(`README 片段（${readme}）：\n${text}`);
	}
	const pkgFile = join(root, "package.json");
	if (existsSync(pkgFile)) try {
		const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
		parts.push(`package.json 摘要：name=${String(pkg.name ?? "")} description=${String(pkg.description ?? "")}`);
	} catch {}
	try {
		const top = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules").map((entry) => entry.name).slice(0, 12);
		if (top.length > 0) parts.push(`顶层目录：${top.join(", ")}`);
	} catch {}
	return parts.join("\n\n");
}
//#endregion
//#region src/project.ts
/**
* 项目探测与扫描范围收敛（spec §6 R3 / R6）。
*
* - `detectStack`：v0.2 技术栈范围 = React（TypeScript / JavaScript）+ Vue 3。
*   检出非支持技术栈时明确告知不支持，不给低质量猜测（spec §边界场景 9）。
* - `gatherFiles`：按用户给定的范围（文件/目录列表）与探测出的技术栈收集
*   对应扩展名的源文件。大仓库不做全量扫描：范围建议由模型在 R6 流程中给出
*   （架构说明文件优先，否则主动询问），本函数只负责执行收集。
*/
/** 默认跳过的目录名（扫描收集阶段）。 */
const DEFAULT_EXCLUDES = [
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".git",
	".next",
	".nuxt",
	".turbo",
	"vendor",
	"__snapshots__"
];
/**
* 探测项目技术栈。
*
* React：package.json 依赖含 react；TypeScript：存在 tsconfig.json 或
* .ts/.tsx 源文件，否则按 React + JavaScript 处理。Vue：依赖含 vue（或
* @vue/runtime-core）或存在 .vue 源文件；Vue 2 明确不支持（SFC 解析基于
* @vue/compiler-sfc）。非支持栈（Svelte / 小程序等）给出明确原因。
*/
function detectStack(root) {
	const pkgFile = join(root, "package.json");
	let pkg;
	if (existsSync(pkgFile)) try {
		pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
	} catch {}
	const deps = () => {
		if (pkg === void 0) return [];
		return [
			"dependencies",
			"devDependencies",
			"peerDependencies"
		].flatMap((key) => Object.keys(pkg?.[key] ?? {}));
	};
	const dependencyNames = deps();
	const hasReact = dependencyNames.includes("react");
	const hasVue = dependencyNames.includes("vue") || dependencyNames.includes("@vue/runtime-core");
	const hasSvelte = dependencyNames.includes("svelte");
	const hasTs = existsSync(join(root, "tsconfig.json"));
	const sourceRoots = [
		"src",
		"app",
		"pages"
	].filter((name) => existsSync(join(root, name)));
	const hasTsFiles = sourceRoots.some((name) => containsExtension(join(root, name), [".ts", ".tsx"], 40));
	const hasVueFiles = sourceRoots.some((name) => containsExtension(join(root, name), [".vue"], 40));
	const hasSvelteFiles = sourceRoots.some((name) => containsExtension(join(root, name), [".svelte"], 40));
	if (hasSvelte || hasSvelteFiles) return {
		supported: false,
		stack: "Svelte",
		reason: "当前版本支持 React（TypeScript / JavaScript）与 Vue 3；Svelte 项目暂不支持（扩展规划中）"
	};
	if (hasVue || hasVueFiles) {
		const vueVersion = vueDependencyVersion(pkg);
		if (vueVersion !== void 0 && /^[~^]?2\./u.test(vueVersion)) return {
			supported: false,
			stack: "Vue 2",
			reason: "当前版本仅支持 Vue 3（SFC 解析基于 @vue/compiler-sfc）；Vue 2 项目暂不支持"
		};
		const label = hasTs || hasTsFiles ? "Vue 3 (+ TypeScript)" : "Vue 3 (JavaScript)";
		if (hasReact) return {
			supported: true,
			kind: "vue",
			stack: `${label}（同时检测到 react 依赖，可能为 monorepo；请按目标应用收敛走查范围）`
		};
		return {
			supported: true,
			kind: "vue",
			stack: label
		};
	}
	if (!hasReact) return {
		supported: false,
		stack: "未知（未检测到 React / Vue）",
		reason: "package.json 中未声明 react 或 vue 依赖；当前版本支持 React（TypeScript / JavaScript）与 Vue 3"
	};
	if (hasTs || hasTsFiles) return {
		supported: true,
		kind: "react-ts",
		stack: "React + TypeScript"
	};
	return {
		supported: true,
		kind: "react-js",
		stack: "React + JavaScript"
	};
}
/** 读取 package.json 中声明的 vue 版本字符串（dependencies 优先）。 */
function vueDependencyVersion(pkg) {
	if (pkg === void 0) return void 0;
	const dependencies = pkg.dependencies;
	const devDependencies = pkg.devDependencies;
	const read = (map) => {
		if (typeof map !== "object" || map === null) return void 0;
		const version = map.vue;
		return typeof version === "string" ? version : void 0;
	};
	return read(dependencies) ?? read(devDependencies);
}
/** 在目录中浅层探测是否存在某扩展名文件（受最大探测数约束）。 */
function containsExtension(dir, extensions, maxProbe) {
	let probed = 0;
	const queue = [dir];
	while (queue.length > 0) {
		const current = queue.pop();
		if (current === void 0) break;
		let entries;
		try {
			entries = readdirSync(current);
		} catch {
			continue;
		}
		for (const entry of entries) {
			probed += 1;
			if (probed > maxProbe) return false;
			const path = join(current, entry);
			if (!entry.endsWith(".d.ts") && extensions.some((ext) => entry.endsWith(ext))) return true;
			let stat;
			try {
				stat = statSync(path);
			} catch {
				continue;
			}
			if (stat.isDirectory() && !DEFAULT_EXCLUDES.includes(entry)) queue.push(path);
		}
	}
	return false;
}
/** 各技术栈收集的源文件扩展名。 */
const SOURCE_EXTENSIONS = {
	"react-ts": [".ts", ".tsx"],
	"react-js": [
		".js",
		".jsx",
		".ts",
		".tsx"
	],
	"vue": [
		".vue",
		".ts",
		".js"
	]
};
function gatherFiles(root, paths, excludes, maxFiles, stack) {
	return gatherByExtensions(root, paths, excludes, maxFiles, SOURCE_EXTENSIONS[stack]);
}
/** 收集与组件范围相邻的样式文件，供 CSS/布局候选分析。 */
function gatherStyleFiles(root, paths, excludes, maxFiles) {
	return gatherByExtensions(root, paths, excludes, maxFiles, [
		".css",
		".scss",
		".sass",
		".less",
		".pcss"
	]);
}
/** 收集范围：相对项目根的文件或目录列表；缺省为 ['src']。 */
function gatherByExtensions(root, paths, excludes, maxFiles, extensions) {
	const excludesSet = /* @__PURE__ */ new Set([...DEFAULT_EXCLUDES, ...excludes]);
	const targets = paths.length > 0 ? paths : ["src"];
	const files = /* @__PURE__ */ new Map();
	let truncated = false;
	let skipped = 0;
	const consider = (absolute) => {
		if (files.size >= maxFiles) {
			truncated = true;
			skipped += 1;
			return;
		}
		const rel = normalizePath(relative(root, absolute));
		if (!isSourceFile(rel, extensions)) {
			skipped += 1;
			return;
		}
		let size = 0;
		try {
			size = statSync(absolute).size;
		} catch {
			skipped += 1;
			return;
		}
		files.set(rel, {
			path: rel,
			size
		});
	};
	const walk = (absolute) => {
		if (truncated && files.size >= maxFiles) return;
		let stat;
		try {
			stat = statSync(absolute);
		} catch {
			return;
		}
		if (stat.isFile()) {
			consider(absolute);
			return;
		}
		if (!stat.isDirectory()) return;
		let entries;
		try {
			entries = readdirSync(absolute);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (excludesSet.has(entry)) continue;
			walk(join(absolute, entry));
		}
	};
	for (const target of targets) {
		const resolved = resolve(root, target);
		if (!resolved.startsWith(resolve(root) + sep) && resolved !== resolve(root)) {
			skipped += 1;
			continue;
		}
		walk(resolved);
	}
	return {
		files: [...files.values()].sort((left, right) => left.path < right.path ? -1 : 1),
		truncated,
		skipped
	};
}
function isSourceFile(rel, extensions) {
	if (rel.endsWith(".d.ts")) return false;
	return extensions.some((ext) => rel.endsWith(ext));
}
function normalizePath(path) {
	return path.split(sep).join("/");
}
/** 项目根内最可能承载前端源码的目录建议（R6 范围建议的兜底素材）。 */
function suggestSourceRoots(root) {
	return [
		"src",
		"app",
		"pages",
		"components",
		"views"
	].filter((name) => existsSync(join(root, name))).map((name) => `${basename(root)}/${name}`);
}
/** 读取文件文本（带 size 上限保护）。 */
function readSourceFile(root, file, maxBytes) {
	const text = readFileSync(join(root, file.path), "utf8");
	return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}
//#endregion
//#region src/auto-scan.ts
/**
* R7 改动触发的自动走查（v0.1.1 spec §5，本版从 P1 提升为 P0）。
*
* **这是"流水线"与"命令行工具"的分界线。** v0.1 少了这一环，插件就只剩一串
* 手动命令，形态自然退化。有了它，agent 改完代码自己就把体验走查跑掉了。
*
* 实现挂在两个文档化的扩展点上（红线：不改 agent-loop）：
* 1. `tools/result` —— 观察文件编辑类工具的最终结果，收集变更文件；
* 2. `agent/turn-stopping` —— 回合收尾时 `agent.steer()` 送入走查提示，
*    这正是框架里 `/loop` 的原生形态（监听器 steer，机器重读 inbox 再跑一步）。
*
* 三条关键约束：
* - **扫描单元是被改动文件所属的完整组件 / 页面，不是 diff 的那几行**：体验
*   问题大量是缺失型的（没有空态、没有错误分支、没有二次确认），这些在 diff
*   里是不存在的行，扫 diff 必然漏掉。diff 只用来确定范围。
* - **前端改动优先，纯后端改动默认排除**：用户不可感知的改动报出来只是噪音。
* - **以 auto 模式运行，只在一级 / 二级问题时提示一句**：agent 自己发起的走查
*   就该由 agent 自己消化，否则等于在用户写代码写到一半时打断他。
*/
/** 值得走查的前端源码扩展名（纯后端改动不进入）。 */
const FRONTEND_EXTENSIONS = [
	".tsx",
	".jsx",
	".vue",
	".ts",
	".js",
	".css",
	".scss",
	".sass",
	".less",
	".pcss"
];
/** 一定不是"用户可感知界面"的路径特征。 */
const NON_UI_PATH = /(?:^|\/)(?:node_modules|dist|build|out|coverage|__tests__|__mocks__|scripts|server|api|migrations)\//u;
/** 测试 / 配置 / 类型声明文件：改了也不产生界面变化。 */
const NON_UI_FILE = /\.(?:test|spec|d)\.[cm]?tsx?$|\.config\.[cm]?[jt]s$/u;
const pending = /* @__PURE__ */ new Map();
function ensure$1(agentId) {
	const existing = pending.get(agentId);
	if (existing !== void 0) return existing;
	const created = {
		files: /* @__PURE__ */ new Set(),
		running: false,
		lastTurn: -1,
		lastSignature: ""
	};
	pending.set(agentId, created);
	return created;
}
/**
* 判断一个改动文件是否值得走查（前端、非测试、非构建产物）。
* @param file - 相对项目根的路径。
* @returns 是否纳入自动走查范围。
*/
function isReviewableChange(file) {
	if (file.length === 0 || file.startsWith("..")) return false;
	if (NON_UI_PATH.test(`/${file}`)) return false;
	if (NON_UI_FILE.test(file)) return false;
	return FRONTEND_EXTENSIONS.some((extension) => file.endsWith(extension));
}
/**
* 把工具参数里的 `file_path` 归一成相对项目根的路径。
* @param filePath - 工具收到的路径（可能是绝对路径）。
* @param cwd - 会话工作目录。
* @returns 相对路径；越出项目根时 undefined。
*/
function relativizeChange(filePath, cwd) {
	const normalized = (isAbsolute(filePath) ? relative(cwd, filePath) : filePath).split(sep).join("/");
	if (normalized.length === 0 || normalized.startsWith("../")) return void 0;
	return normalized;
}
/**
* 由改动文件推出走查范围：**取其所属目录**，因为扫描单元是完整组件 / 页面。
* @param files - 改动文件（相对项目根）。
* @returns 去重后的目录清单（文件位于项目根时退回该文件本身）。
*/
function scanUnitsOf(files) {
	const units = /* @__PURE__ */ new Set();
	for (const file of files) {
		const slash = file.lastIndexOf("/");
		units.add(slash === -1 ? file : file.slice(0, slash));
	}
	return [...units].sort();
}
function personaInstruction(state) {
	if (state === "missing") return [
		"2. 项目还没有 .ux/personas.yml。先根据 README / package.json / 路由推断 1-3 个画像，",
		"   立即调用 ux_personas_write（status=draft）落盘，然后用这些草稿走查。",
		"   不要向用户展示画像确认卡片，不要问「这些用户对吗」。"
	].join("\n");
	if (state === "draft") return "2. 当前画像是推断草稿。直接用它们走查，不要再问确认。";
	return "2. 按 .ux/personas.yml 的画像和产品类型重点判定；CSS/布局候选没有截图时只能作为候选，不得输出需要 rendered/interactive 的规则。";
}
/** R7 送给模型的走查提示。 */
function buildAutoScanPrompt(units, files, personaState = "confirmed") {
	return [
		"[dsh-user-experience R7] 刚才的改动涉及前端界面，按下面的方式**安静地**跑一次 UX 走查：",
		"",
		`1. 根据项目 README、路由和本次流程判断 product_type，并跟随用户/项目语言；调用 ux_scan 时传入这两个字段，paths 用改动所属的完整目录：${units.map((unit) => `"${unit}"`).join("、")}。`,
		"   **扫描单元是完整组件 / 页面，不是改动的那几行**——没有空态、没有错误分支、没有二次确认",
		"   这类缺失型问题在 diff 里根本不存在，只看改动行必然漏掉。",
		`   （本次改动的文件：${files.join("、")}）`,
		personaInstruction(personaState),
		"3. 调用一次 ux_report 定稿，带相同的 product_type/language，mode 设为 \"auto\"。",
		"4. 【重要】这次走查是你自己发起的，不是用户要求的：",
		"   - 全程不要向用户提问、不要索要确认、不要问走查范围、不要问画像对不对；",
		"   - 报告出来后，只有存在一级 / 二级问题时才用一句话提示用户；",
		"   - 没有一级 / 二级问题就安静收尾，不要复述报告，继续等用户的下一个指令；",
		"   - 若画像是这次才推断的草稿，一级 / 二级提示里可以加半句「这次按『某某』视角看的，不对可以说」，不要做成弹窗。",
		"5. 如果这次改动明显与界面体验无关（纯类型、纯工具函数），直接跳过走查，不要硬跑。"
	].join("\n");
}
/** 是否启用自动走查（本地偏好优先于插件配置）。 */
function autoScanEnabled(cwd, config) {
	return loadLocalRules(cwd).autoScan?.enabled ?? config.autoScan;
}
function debounceTurns(cwd, config) {
	return loadLocalRules(cwd).autoScan?.debounceTurns ?? config.autoScanDebounceTurns;
}
/**
* 接线 R7：注册两个监听器。
* @param ctx - 插件上下文（监听器随上下文卸载而解绑）。
* @param config - 插件配置。
*/
function registerAutoScan(ctx, config) {
	const editTools = new Set(config.autoScanEditTools);
	ctx.on("tools/result", (exec, result) => {
		if (!editTools.has(exec.name)) return;
		if (result.isError) return;
		const agent = exec.agent;
		const cwd = agent?.session.header.cwd;
		if (agent === void 0 || cwd === void 0) return;
		const args = exec.arguments;
		if (typeof args !== "object" || args === null) return;
		const filePath = args.file_path;
		if (typeof filePath !== "string" || filePath.length === 0) return;
		const state = ensure$1(agent.id);
		if (state.running) return;
		const relativePath = relativizeChange(filePath, cwd);
		if (relativePath === void 0 || !isReviewableChange(relativePath)) return;
		if (state.files.size >= config.autoScanMaxFiles) return;
		state.files.add(relativePath);
	});
	ctx.on("agent/turn-stopping", (payload) => {
		const agent = payload.agent;
		const cwd = agent.session.header.cwd;
		if (cwd === void 0) return;
		const state = pending.get(agent.id);
		if (state === void 0) return;
		if (state.running && payload.turn !== state.lastTurn) state.running = false;
		if (state.running || state.files.size === 0) return;
		const files = [...state.files].sort();
		state.files.clear();
		if (!autoScanEnabled(cwd, config)) return;
		if (!detectStack(cwd).supported) return;
		const personas = loadPersonaFile(cwd);
		const personaState = personas === void 0 ? "missing" : personas.status;
		const signature = files.join("|");
		if (signature === state.lastSignature) return;
		if (state.lastTurn >= 0 && payload.turn - state.lastTurn < debounceTurns(cwd, config)) return;
		state.running = true;
		state.lastTurn = payload.turn;
		state.lastSignature = signature;
		agent.steer(createUserMessage({
			content: [{
				type: "text",
				text: buildAutoScanPrompt(scanUnitsOf(files), files, personaState)
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-user-experience"
			}
		}));
	});
	ctx.on("agent/disposed", (payload) => {
		pending.delete(payload.agent.id);
	});
}
//#endregion
//#region src/fingerprint.ts
/**
* 跨走查指纹（v0.1.1 spec §6.2）。
*
* 隐式确认要回答的问题是"上次那条问题，这次还在不在"。这需要一个**在代码
* 编辑之后仍然稳定**的标识——**不能用 `file:line`**，加一行代码位置就漂了。
*
* ```
* fingerprint = hash(
*   rule_id,          // R-06
*   symbol_path,      // src/pages/Admin/UserTable.tsx::UserTable::handleDelete
*   feature_digest    // 文案类取文案 hash；结构类取被指认元素的语法特征
* )
* ```
*
* - `persona_refs` **不进指纹**——同一问题被不同 persona 命中时是合并的；
* - `surface` **不进指纹**——人话名称会变。
*
* 重命名会让 symbol_path 漂移，所以比对不是纯等值：**三元组中两项相同即
* 视为同一问题**，进入模糊匹配。
*/
function sha(value) {
	return createHash("sha256").update(value).digest("hex");
}
/**
* 构造符号路径。行号**不参与**——加一行代码不该让指纹漂移。
* @param file - 相对项目根的文件路径。
* @param symbol - 组件 / 符号名（缺省时只用文件路径）。
* @param member - 更内层的成员名（如事件处理函数），可选。
* @returns `file::symbol::member` 形式的稳定路径。
*/
function symbolPathOf(file, symbol, member) {
	return [
		file,
		symbol,
		member
	].filter((part) => typeof part === "string" && part.trim().length > 0).join("::");
}
/**
* 归一化特征原文后取摘要：空白折叠 + 小写，避免格式化改动导致漂移。
* @param feature - 文案原文或结构特征描述；空值时退到规则本身。
* @param fallback - 特征缺失时的兜底串（通常是 rule + symbolPath）。
* @returns 16 位十六进制摘要。
*/
function featureDigestOf(feature, fallback) {
	return sha((feature === void 0 || feature.trim().length === 0 ? fallback : feature).replace(/\s+/gu, " ").trim().toLowerCase()).slice(0, 16);
}
/**
* 由三元组计算指纹。
* @param parts - 规则、符号路径、特征摘要。
* @returns 16 位十六进制指纹。
*/
function fingerprintOf(parts) {
	return sha([
		parts.rule,
		parts.symbolPath,
		parts.featureDigest
	].join("|")).slice(0, 16);
}
/**
* 模糊匹配：三元组中**任意两项相同**即视为同一问题（spec §6.2 的重命名缓解）。
* @param left - 一侧三元组。
* @param right - 另一侧三元组。
* @returns 是否视为同一问题。
*/
function isSameFinding(left, right) {
	return [
		left.rule === right.rule,
		left.symbolPath === right.symbolPath,
		left.featureDigest === right.featureDigest
	].filter(Boolean).length >= 2;
}
//#endregion
//#region src/types.ts
/** 由 impact × reach 推导严重度等级。 */
function levelOf(impact, reach) {
	if (impact === "high") return reach === "wide" ? "P0" : "P1";
	return reach === "wide" ? "P2" : "P3";
}
/** 由命中 persona 的 share 之和推导 reach：>= 0.5 为 wide。 */
function reachOf(shares) {
	return shares.reduce((sum, share) => sum + share, 0) >= .5 ? "wide" : "narrow";
}
/** P0~P3 → 人话标签（v0.1.1 spec §3.3：内部标识不再上界面）。 */
const SEVERITY_LABEL = {
	P0: "一级问题",
	P1: "二级问题",
	P2: "三级问题",
	P3: "四级问题"
};
/** 严重度的人话标签；未知等级退到"待定级"，绝不回落成 `P?` 字面量。 */
function severityLabel(level, language = "zh-CN") {
	if (language === "en") return {
		P0: "Level one",
		P1: "Level two",
		P2: "Level three",
		P3: "Level four"
	}[level] ?? "Unrated";
	return SEVERITY_LABEL[level] ?? "待定级问题";
}
/** 排序权重：P0 最前。 */
const SEVERITY_ORDER = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3
};
/** 是否属于需要主动提示用户的严重度（一级 / 二级问题）。 */
function isUrgent(level) {
	return level === "P0" || level === "P1";
}
//#endregion
//#region src/history.ts
/**
* 指纹历史账本 `.ux/history.jsonl`（v0.1.1 spec §6 / §7）。
*
* **注意区分判定结果与指标账本**：单次判定（confirmed / rejected）是阶段性
* 事实，留在会话日志里，不进仓库；本文件是**长期指标数据**——指纹、首次出现、
* 末次出现、终态、每次走查的 scope。gitignore，不提交。
*
* 隐式确认的机制是：**下一次走查时某条 finding 消失了 = 用户把它改掉了 =
* 这条问题成立**。用户什么都不用点，而且这个信号比人工点"确认存在"更硬。
*
* 但 finding 消失有三种可能（spec §6.3，整个机制最容易出错的地方）：
* 1. 用户改掉了                   → 隐式确认成立
* 2. 这次走查范围没覆盖到那里     → **不能判定**，置 stale，不计入指标分母
* 3. 代码被整块删除 / 页面下线     → 不算"改进"，同样不计入
*
* 因此隐式确认**仅在同一 scope 被重新扫描时生效**，走查记录必须存下本次的 scope。
*/
const HISTORY_FILE = ".ux/history.jsonl";
function historyPath(root) {
	return join(root, HISTORY_FILE);
}
function appendRecords(root, records) {
	if (records.length === 0) return;
	const file = historyPath(root);
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}
/**
* 读取并折叠账本。坏行跳过——append-only 文件被外部工具截断时不应炸掉走查。
* @param root - 项目根目录。
* @returns 折叠后的账本。
*/
function loadLedger(root) {
	const file = historyPath(root);
	const ledger = {
		entries: /* @__PURE__ */ new Map(),
		lastScope: []
	};
	if (!existsSync(file)) return ledger;
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return ledger;
	}
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.kind === "scan") {
			ledger.lastScope = Array.isArray(record.scope) ? record.scope : [];
			continue;
		}
		if (record.kind === "finding") {
			const existing = ledger.entries.get(record.fingerprint);
			if (existing === void 0) {
				ledger.entries.set(record.fingerprint, {
					fingerprint: record.fingerprint,
					rule: record.rule,
					symbol_path: record.symbol_path,
					feature_digest: record.feature_digest,
					file: record.file,
					surface: record.surface,
					report_id: record.report_id,
					finding_id: record.finding_id,
					first_seen: record.at,
					last_seen: record.at,
					status: "pending"
				});
				continue;
			}
			existing.last_seen = record.at;
			existing.file = record.file;
			existing.surface = record.surface;
			existing.report_id = record.report_id;
			existing.finding_id = record.finding_id;
			if (existing.status === "stale") {
				existing.status = "pending";
				delete existing.reason;
			}
			continue;
		}
		const entry = ledger.entries.get(record.fingerprint);
		if (entry === void 0) continue;
		entry.status = record.status;
		if (record.reason === void 0) delete entry.reason;
		else entry.reason = record.reason;
	}
	return ledger;
}
/** 由已定稿的 finding 取出比对三元组。 */
function comparableOf(finding, featureDigest) {
	return {
		fingerprint: finding.fingerprint,
		rule: finding.technical.rule,
		symbolPath: [finding.technical.locator.file, finding.technical.locator.symbol].filter((part) => typeof part === "string" && part.length > 0).join("::"),
		featureDigest
	};
}
/**
* 比对上一轮遗留的待判定条目，算出隐式确认与失效标记，并落账。
*
* 判定顺序刻意如此：**先查文件是否还在，再查是否在 scope 内**——代码被整块
* 删除时文件仍可能落在 scope 里，若先判 scope 就会把"删代码"误判成"改进"。
* @param root - 项目根目录。
* @param input - 本次 scope、本次仍存在的 finding。
* @returns 本次产生的隐式判定列表（调用方据此回写会话事件）。
*/
function reconcile(root, input) {
	const at = input.at ?? Date.now();
	const ledger = loadLedger(root);
	const scope = new Set(input.scopeFiles);
	const stillPresent = (entry) => {
		if (input.current.some((finding) => finding.fingerprint === entry.fingerprint)) return true;
		const parts = {
			rule: entry.rule,
			symbolPath: entry.symbol_path,
			featureDigest: entry.feature_digest
		};
		return input.current.some((finding) => isSameFinding(parts, finding));
	};
	const verdicts = [];
	for (const entry of ledger.entries.values()) {
		if (entry.status !== "pending" && entry.status !== "stale") continue;
		if (stillPresent(entry)) continue;
		const computed = !existsSync(join(root, entry.file)) ? {
			entry,
			status: "stale",
			reason: "removed"
		} : !scope.has(entry.file) ? {
			entry,
			status: "stale",
			reason: "scope-miss"
		} : {
			entry,
			status: "confirmed_implicit"
		};
		if (computed.status === entry.status && computed.reason === entry.reason) continue;
		verdicts.push(computed);
	}
	appendRecords(root, verdicts.map((verdict) => ({
		kind: "verdict",
		at,
		fingerprint: verdict.entry.fingerprint,
		status: verdict.status,
		...verdict.reason === void 0 ? {} : { reason: verdict.reason }
	})));
	return verdicts;
}
/**
* 记录一次走查：先写 scope，再写本轮每条 finding。
* @param root - 项目根目录。
* @param input - 报告 id、本次 scope、定稿 findings。
*/
function recordScan(root, input) {
	const at = input.at ?? Date.now();
	const records = [{
		kind: "scan",
		at,
		scope: [...input.scope]
	}];
	for (const finding of input.findings) records.push({
		kind: "finding",
		at,
		fingerprint: finding.fingerprint,
		rule: finding.technical.rule,
		symbol_path: [finding.technical.locator.file, finding.technical.locator.symbol].filter((part) => typeof part === "string" && part.length > 0).join("::"),
		feature_digest: input.featureDigests.get(finding.id) ?? "",
		file: finding.technical.locator.file,
		surface: finding.surface,
		report_id: input.reportId,
		finding_id: finding.id
	});
	appendRecords(root, records);
}
/**
* 记录一条显式判定（卡片按钮 / 自然语言），让长期指标也能看见人工确认。
* @param root - 项目根目录。
* @param fingerprint - 目标 finding 的指纹。
* @param status - 判定终态。
*/
function recordVerdict(root, fingerprint, status) {
	if (fingerprint.length === 0) return;
	appendRecords(root, [{
		kind: "verdict",
		at: Date.now(),
		fingerprint,
		status
	}]);
}
//#endregion
//#region src/i18n.ts
/** 把 BCP-47/自然语言名称归一到固定界面支持的语言。 */
function normalizeLanguage(value) {
	if (value === void 0) return void 0;
	const normalized = value.trim().toLowerCase();
	if (normalized === "zh" || normalized.startsWith("zh-") || normalized.includes("chinese") || normalized.includes("中文")) return "zh-CN";
	if (normalized === "en" || normalized.startsWith("en-") || normalized.includes("english") || normalized.includes("英文")) return "en";
}
/**
* 从项目主 README 推断开发文档语言。双语仓库以 README.md 为准，因为它通常
* 是默认落地页；无法判断时使用英语作为跨项目回退。
*/
function detectProjectLanguage(root) {
	const file = [
		"README.md",
		"readme.md",
		"README.zh.md"
	].map((name) => join(root, name)).find((path) => existsSync(path));
	if (file === void 0) return "en";
	let text = "";
	try {
		text = readFileSync(file, "utf8").slice(0, 12e3);
	} catch {
		return "en";
	}
	return (text.match(/\p{Script=Han}/gu)?.length ?? 0) > (text.match(/[A-Za-z]/gu)?.length ?? 0) * .35 ? "zh-CN" : "en";
}
/**
* 输出语言优先级：插件显式配置 > 当前请求中模型识别的语言 > 项目主文档语言。
*/
function resolveOutputLanguage(root, configured, requested) {
	if (configured !== "auto") return configured;
	return normalizeLanguage(requested) ?? detectProjectLanguage(root);
}
function isChinese(language) {
	return language === "zh-CN";
}
//#endregion
//#region src/judge-tool.ts
/**
* 确认闭环的去 ID 化入口（v0.1.1 spec §4.3）。
*
* 判定由自然语言或卡片按钮完成。`/ux judge` 只是卡片按钮的隐藏通道，
* 不出现在任何面向用户的提示里。会话里始终存在"当前报告"上下文，用户
* 只需要点按钮或直接说话。
*
* 三种入口共用这里的解析：
* - 卡片按钮 → `/ux judge`（脚本接口，不出现在任何面向用户的提示里）
* - 自然语言 → `ux_judge` 工具（「第 2 条不成立」「这几条都对」）
* - 批量操作 → 同上（「三级以下全部忽略」「全部确认」）
*/
/**
* 取会话日志里最近一份报告，并折叠出每条 finding 的当前状态。
* @param session - 当前会话。
* @param reportId - 指定报告；缺省取最近一份。
* @returns 当前报告；会话里还没有报告时 undefined。
*/
function currentReport(session, reportId) {
	let latest;
	for (const event of session.events) {
		if (event.type !== "ux/report") continue;
		if (reportId !== void 0 && event.data.reportId !== reportId) continue;
		latest = {
			reportId: event.data.reportId,
			title: event.data.title,
			language: event.data.language ?? "zh-CN",
			productType: event.data.productType ?? "other",
			findings: event.data.findings
		};
	}
	if (latest === void 0) return void 0;
	const statuses = new Map(latest.findings.map((finding) => [finding.id, finding.status]));
	for (const event of session.events) {
		if (event.type !== "ux/finding-status") continue;
		if (event.data.reportId !== latest.reportId) continue;
		statuses.set(event.data.findingId, event.data.status);
	}
	return {
		...latest,
		statuses
	};
}
const LEVEL_BY_WORD = {
	一级: "P0",
	二级: "P1",
	三级: "P2",
	四级: "P3",
	one: "P0",
	two: "P1",
	three: "P2",
	four: "P3"
};
const ALL_WORDS = /* @__PURE__ */ new Set([
	"全部",
	"所有",
	"都",
	"all",
	"*"
]);
/** 「三级以下」「三级及以下」这类批量表达。 */
const BELOW = /^([一二三四])级(?:问题)?(?:及)?以下$/u;
const BELOW_EN_PREFIX = /^below\s+(?:level\s+)?(one|two|three|four)$/iu;
const BELOW_EN_SUFFIX = /^(?:level\s+)?(one|two|three|four)\s+(?:and|or)\s+below$/iu;
/** 「第 2 条」「2」「UX-0002」这类单条表达。 */
const ORDINAL = /^第?\s*(\d+)\s*条?$/u;
const ORDINAL_EN = /^(?:(?:item|finding|issue)\s+|#)(\d+)(?:st|nd|rd|th)?$/iu;
/**
* 把一个自然语言选择器解析成 finding id 列表。
*
* 支持：序号（`2` / `第 2 条` / `item 2`）、finding id（`UX-0002`）、
* 批量词（`全部` / `三级以下` / `below level three` / `all`），以及
* headline / surface 的关键词匹配。
* @param report - 当前报告。
* @param selector - 一个选择器文本。
* @returns 命中的 finding id；无法解析时为空数组。
*/
function resolveSelector(report, selector) {
	const value = selector.trim();
	if (value.length === 0) return [];
	if (ALL_WORDS.has(value.toLowerCase())) return report.findings.map((finding) => finding.id);
	const below = BELOW.exec(value) ?? BELOW_EN_PREFIX.exec(value) ?? BELOW_EN_SUFFIX.exec(value);
	if (below !== null) {
		const floor = LEVEL_BY_WORD[below[1] ?? ""] ?? "P2";
		return report.findings.filter((finding) => finding.technical.severity.level >= floor).map((finding) => finding.id);
	}
	const levelWord = /^([一二三四])级(?:问题)?$/u.exec(value) ?? /^(?:level\s+)?(one|two|three|four)$/iu.exec(value);
	if (levelWord !== null) {
		const level = LEVEL_BY_WORD[(levelWord[1] ?? "").toLowerCase()];
		return report.findings.filter((finding) => finding.technical.severity.level === level).map((finding) => finding.id);
	}
	const ordinal = ORDINAL.exec(value) ?? ORDINAL_EN.exec(value);
	if (ordinal !== null) {
		const index = Number.parseInt(ordinal[1] ?? "", 10) - 1;
		const finding = report.findings[index];
		return finding === void 0 ? [] : [finding.id];
	}
	const byId = report.findings.find((finding) => finding.id.toLowerCase() === value.toLowerCase() || finding.id.toLowerCase().endsWith(`-${value.toLowerCase().padStart(4, "0")}`));
	if (byId !== void 0) return [byId.id];
	const keyword = value.toLowerCase();
	return report.findings.filter((finding) => finding.human.headline.toLowerCase().includes(keyword) || finding.surface.toLowerCase().includes(keyword)).map((finding) => finding.id);
}
/**
* 应用一组判定：写入会话事件，并把显式判定记进长期账本。
* @param session - 当前会话。
* @param report - 当前报告。
* @param targets - 选择器列表。
* @param verdict - 判定终态。
* @param root - 项目根目录（记账本用）。
* @returns 实际生效的条目与无法解析的选择器。
*/
function applyVerdicts(session, report, targets, verdict, root) {
	const ids = /* @__PURE__ */ new Set();
	const unresolved = [];
	for (const target of targets) {
		const resolved = resolveSelector(report, target);
		if (resolved.length === 0) {
			unresolved.push(target);
			continue;
		}
		for (const id of resolved) ids.add(id);
	}
	const applied = [];
	for (const id of ids) {
		const finding = report.findings.find((item) => item.id === id);
		if (finding === void 0) continue;
		session.append("ux/finding-status", {
			reportId: report.reportId,
			findingId: id,
			status: verdict
		});
		if (root !== void 0) recordVerdict(root, finding.fingerprint, verdict);
		applied.push({
			id,
			headline: finding.human.headline,
			surface: finding.surface
		});
	}
	return {
		applied,
		unresolved
	};
}
/** 注册 `ux_judge` 工具（自然语言与批量判定的落点）。 */
function uxJudgeTool() {
	return defineTool({
		name: "ux_judge",
		description: [
			"记录用户对 UX 报告中问题的判定（成立 / 不成立）。",
			"用户说「第 2 条不成立」「三级以下全部忽略」，或 “item 2 is not an issue” / “ignore below level three” 时调用本工具。",
			"targets 直接写用户的说法即可：序号（2 / item 2）、批量词（全部 / all / 三级以下 / below level three）或问题关键词。",
			"本工具自己定位当前报告——不要向用户索要任何报告 ID 或问题编号。"
		].join(" "),
		parameters: {
			targets: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "要判定的目标：序号（\"2\"）、批量词（\"全部\"/\"三级以下\"/\"一级\"）或问题关键词（\"删除\"）"
			},
			verdict: {
				type: "string",
				required: true,
				enum: ["confirmed", "rejected"],
				description: "confirmed = 问题成立；rejected = 不是问题"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					report_id: { type: "string" },
					verdict: { type: "string" },
					applied: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								headline: { type: "string" },
								surface: { type: "string" }
							}
						}
					},
					unresolved: {
						type: "array",
						items: { type: "string" }
					},
					summary: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.summary
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("ux_judge：需要 agent 上下文（应在 agent loop 中调用）");
			const report = currentReport(agent.session);
			if (report === void 0) throw new Error("ux_judge：本次会话还没有 UX 走查报告，无法记录判定。先完成一次走查。");
			const verdict = args.verdict === "rejected" ? "rejected" : "confirmed_explicit";
			const outcome = applyVerdicts(agent.session, report, args.targets, verdict, agent.session.header.cwd);
			const zh = isChinese(report.language);
			const label = verdict === "rejected" ? zh ? "不是问题" : "not an issue" : zh ? "问题成立" : "confirmed";
			const lines = [];
			if (outcome.applied.length === 0) {
				lines.push(zh ? `没有匹配到要判定的问题：${outcome.unresolved.join("、") || "（未给出目标）"}` : `No findings matched: ${outcome.unresolved.join(", ") || "(no target provided)"}`);
				lines.push(zh ? `当前报告「${report.title}」共 ${report.findings.length} 条，可以说序号、严重度或问题里的关键词。` : `Report "${report.title}" has ${report.findings.length} findings; refer to an ordinal, severity, or headline keyword.`);
			} else {
				lines.push(zh ? `已记录 ${outcome.applied.length} 条为「${label}」：` : `Marked ${outcome.applied.length} finding(s) as ${label}:`);
				for (const item of outcome.applied) lines.push(`- ${item.surface}｜${item.headline}`);
				if (verdict === "confirmed_explicit") lines.push(zh ? "报告卡片现已提供「复制给 AI 的任务 Prompt」：它只描述观察到的现象，并提醒 AI 先补齐完整项目上下文。" : "The report card now provides a task Prompt for AI. It describes the observed behavior and asks the AI to inspect the complete project context.");
				if (outcome.unresolved.length > 0) lines.push(zh ? `没匹配上的说法：${outcome.unresolved.join("、")}` : `Unmatched selectors: ${outcome.unresolved.join(", ")}`);
			}
			const pending = report.findings.filter((finding) => {
				return report.statuses.get(finding.id) === "pending" && !outcome.applied.some((item) => item.id === finding.id);
			});
			if (pending.length > 0) {
				const urgent = pending.filter((finding) => finding.technical.severity.level === "P0").length;
				lines.push(zh ? `还有 ${pending.length} 条待判定（其中 ${urgent} 条一级问题）。` : `${pending.length} findings remain (${urgent} level-one).`);
			}
			return {
				report_id: report.reportId,
				verdict,
				applied: outcome.applied,
				unresolved: outcome.unresolved,
				summary: lines.join("\n")
			};
		}
	});
}
//#endregion
//#region src/commands.ts
function naturalLanguageHint(language) {
	return isChinese(language) ? "直接用自然语言说即可，例如「看看下单流程好不好用」。不需要敲斜杠命令。" : "Just say what you want in plain language, for example \"check the checkout flow\". No slash command is needed.";
}
/** 解析并执行隐藏判定通道；其余输入一律引导用户说话。 */
function runSubcommand(invocation, configuredLanguage) {
	const raw = invocation.rawInput.trim();
	const [sub, ...rest] = raw.length === 0 ? [""] : raw.split(/\s+/u);
	const cwd = invocation.agent.session.header.cwd;
	const requestLanguage = /\p{Script=Han}/u.test(raw) ? "zh-CN" : void 0;
	const language = resolveOutputLanguage(cwd ?? process.cwd(), configuredLanguage, requestLanguage);
	if (sub !== "judge") return {
		kind: "success",
		text: naturalLanguageHint(language)
	};
	const reportRef = rest[0];
	const targets = (rest[1] ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0);
	const verdictWord = rest[2];
	if (reportRef === void 0 || targets.length === 0 || verdictWord !== "confirmed" && verdictWord !== "rejected") return {
		kind: "error",
		text: "判定参数不完整：点卡片上的按钮，或直接说「第 2 条不成立」。"
	};
	const report = currentReport(invocation.agent.session, reportRef === "latest" ? void 0 : reportRef);
	if (report === void 0) return {
		kind: "error",
		text: "找不到对应的走查报告，可能会话已被清理。"
	};
	const verdict = verdictWord === "rejected" ? "rejected" : "confirmed_explicit";
	let outcome;
	try {
		outcome = applyVerdicts(invocation.agent.session, report, targets, verdict, cwd);
	} catch (error) {
		return {
			kind: "error",
			text: `判定记录失败：${error instanceof Error ? error.message : String(error)}`
		};
	}
	if (outcome.applied.length === 0) return {
		kind: "error",
		text: "没有匹配到要判定的问题。"
	};
	const label = verdict === "rejected" ? "不是问题" : "问题成立";
	const promptHint = verdict === "confirmed_explicit" ? "；可在报告卡片中复制现象导向的任务 Prompt 交给 AI" : "";
	return {
		kind: "success",
		text: outcome.applied.length === 1 ? `已记录「${outcome.applied[0]?.headline ?? ""}」为「${label}」${promptHint}` : `已记录 ${outcome.applied.length} 条为「${label}」${promptHint}`
	};
}
/**
* 注册隐藏的 `/ux` 判定通道。
* 命令栏若仍能看到它，hint 故意留空，避免再教 init / scan。
*/
function createUxCommand(language = "auto") {
	return {
		name: "ux",
		description: "内部判定通道（报告卡片使用）",
		input: { hint: "" },
		recordInput: true,
		handler: (invocation) => runSubcommand(invocation, language)
	};
}
//#endregion
//#region src/config.ts
/**
* 插件配置与内部设置类型。
*
* 配置项可被 profile 的 cordis.patch.yml / --patch 层按 id `ux-experience`
* 覆盖（spec 发布要求：可调值不硬编码，全部进 schema）。
*/
const Config = Schema.object({
	maxScanFiles: Schema.number().default(300),
	maxCandidatesPerRule: Schema.number().default(5),
	maxCandidatesPerFile: Schema.number().default(25),
	maxFindings: Schema.number().default(30),
	excludePatterns: Schema.array(String).default([
		"node_modules",
		"dist",
		"build",
		"out",
		"coverage",
		".git",
		"test",
		"tests",
		"__tests__",
		"spec",
		"e2e",
		"stories",
		"mocks"
	]),
	mode: Schema.union([
		Schema.const("detect"),
		Schema.const("auto"),
		Schema.const("review"),
		Schema.const("interactive")
	]).default("detect"),
	autoScan: Schema.boolean().default(true),
	autoScanEditTools: Schema.array(String).default(["write", "edit"]),
	autoScanMaxFiles: Schema.number().default(20),
	autoScanDebounceTurns: Schema.number().default(1),
	outputLanguage: Schema.union([
		Schema.const("auto"),
		Schema.const("zh-CN"),
		Schema.const("en")
	]).default("auto")
});
//#endregion
//#region src/personas-tool.ts
/**
* `ux_personas_write` 工具：
*
* 把目标用户画像写入 `.ux/personas.yml`。这是 persona 文件的唯一写入口。
* - status=draft：自动走查推断的草稿，允许未经用户确认落盘，避免打断写代码；
* - status=confirmed：用户主动走查时确认或修改后的正式画像。
*/
/** 注册 `ux_personas_write` 工具。 */
function uxPersonasWriteTool(config) {
	return defineTool({
		name: "ux_personas_write",
		description: [
			"把目标用户画像写入项目根目录 .ux/personas.yml（仓库内一等公民文件，可 git 提交）。",
			"status=draft：改动触发的自动走查可在未打扰用户的情况下写入推断草稿。",
			"status=confirmed：仅在用户主动走查并确认/修改画像后使用。不要让用户敲任何斜杠命令。",
			"画像 id 使用小写字母/数字/连字符；share 为占目标用户比例估计（(0,1]，全量画像之和宜 ≈ 1）。",
			"文件已存在时本调用整体覆盖。"
		].join(" "),
		parameters: {
			language: {
				type: "string",
				description: "输出语言（zh-CN 或 en）；跟随当前用户语言。"
			},
			status: {
				type: "string",
				description: "draft=推断草稿（自动走查）；confirmed=用户已确认。缺省 confirmed。",
				enum: ["draft", "confirmed"]
			},
			personas: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: {
							type: "string",
							required: true,
							description: "稳定 id，如 novice-investor"
						},
						name: {
							type: "string",
							required: true,
							description: "人类可读名称"
						},
						scenario: {
							type: "string",
							required: true,
							description: "使用场景一句话"
						},
						goals: {
							type: "array",
							items: { type: "string" },
							required: true,
							description: "目标清单（非空）"
						},
						capability: {
							type: "object",
							additionalProperties: false,
							required: true,
							properties: {
								tech_literacy: {
									type: "string",
									required: true,
									enum: [
										"low",
										"medium",
										"high"
									]
								},
								device: {
									type: "string",
									required: true,
									enum: [
										"mobile",
										"desktop",
										"both"
									]
								},
								network: {
									type: "string",
									required: true,
									enum: ["stable", "unstable"]
								},
								accessibility_needs: {
									type: "array",
									items: { type: "string" },
									required: true,
									description: "如 low_vision / motor"
								}
							}
						},
						key_paths: {
							type: "array",
							items: { type: "string" },
							required: true,
							description: "关键路径，如 [登录, 查看持仓, 下单]"
						},
						share: {
							type: "number",
							required: true,
							description: "占目标用户比例估计 (0, 1]"
						}
					}
				},
				required: true,
				description: "完整画像列表"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					written: { type: "number" },
					path: { type: "string" },
					status: { type: "string" },
					language: { type: "string" },
					personas: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								name: { type: "string" },
								share: { type: "number" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const result = value;
				const draft = result.status === "draft";
				return [{
					type: "text",
					text: (isChinese(result.language) ? [
						draft ? `已写入 ${result.written} 个草稿画像到 ${result.path}（尚未经用户确认，自动走查可用）：` : `已写入 ${result.written} 个目标用户画像到 ${result.path}（可 git 提交、团队共享）：`,
						...result.personas.map((persona) => `- [${persona.id}] ${persona.name}（share ${persona.share}）`),
						draft ? "之后用户说画像不对时再覆盖为正式画像。" : "后续走查将以这些画像作为判定依据。"
					] : [
						draft ? `Wrote ${result.written} draft personas to ${result.path} (usable for automatic walkthroughs, not yet confirmed):` : `Wrote ${result.written} target personas to ${result.path} (commit this file to share it with the team):`,
						...result.personas.map((persona) => `- [${persona.id}] ${persona.name} (share ${persona.share})`),
						draft ? "Overwrite with confirmed personas when the user later corrects who the product is for." : "Future walkthroughs will use these personas as their evaluation context."
					]).join("\n")
				}];
			}
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("ux_personas_write：需要 agent 上下文（应在 agent loop 中调用）");
			const cwd = agent.session.header.cwd;
			if (cwd === void 0) throw new Error("ux_personas_write：当前会话没有工作目录（cwd），无法定位项目");
			const status = args.status === "draft" ? "draft" : "confirmed";
			const written = writePersonas(cwd, args.personas, status);
			return {
				written: written.length,
				path: ".ux/personas.yml",
				status,
				language: resolveOutputLanguage(cwd, config.outputLanguage, args.language),
				personas: written.map((persona) => ({
					id: persona.id,
					name: persona.name,
					share: persona.share
				}))
			};
		}
	});
}
//#endregion
//#region src/glossary.ts
/**
* 术语表（`.ux/glossary.yml`）读写与增量合并（spec §5.4 / R-02）。
*
* R-02 是规则集中跨文件比对最贵的一条：术语表持久化后，后续走查只对
* 新增或变更的术语做增量判断，不重复全量比对。
*/
const GLOSSARY_FILE = ".ux/glossary.yml";
const cache = /* @__PURE__ */ new Map();
function glossaryPath(root) {
	return join(root, GLOSSARY_FILE);
}
/** 读取术语表；文件不存在时返回空表。 */
function loadGlossary(root) {
	const file = glossaryPath(root);
	let mtimeMs;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		cache.delete(root);
		return { terms: [] };
	}
	const hit = cache.get(root);
	if (hit !== void 0 && hit.mtimeMs === mtimeMs) return hit.glossary;
	let glossary = { terms: [] };
	if (existsSync(file)) {
		const parsed = parse(readFileSync(file, "utf8"));
		const terms = typeof parsed === "object" && parsed !== null ? parsed.terms : void 0;
		if (Array.isArray(terms)) glossary = { terms: terms.filter((term) => typeof term === "object" && term !== null && typeof term.canonical === "string" && Array.isArray(term.variants)) };
	}
	cache.set(root, {
		mtimeMs,
		glossary
	});
	return glossary;
}
/** 校验并规范化一组术语更新。 */
function validateTerms(updates, where) {
	return updates.map((term, index) => {
		if (typeof term.canonical !== "string" || term.canonical.trim().length === 0) throw new TypeError(`${where}[${index}]：canonical 必须是非空字符串`);
		if (!Array.isArray(term.variants) || term.variants.some((v) => typeof v !== "string" || v.length === 0)) throw new TypeError(`${where}[${index}]：variants 必须是非空字符串数组（可为空）`);
		return {
			canonical: term.canonical.trim(),
			variants: [...new Set(term.variants.map((v) => v.trim()))],
			...term.note === void 0 ? {} : { note: term.note }
		};
	});
}
/**
* 增量合并术语更新到 `.ux/glossary.yml`：
* 同 canonical 条目合并变体并集，新条目追加；有变更才落盘。
*/
function mergeGlossary(root, updates) {
	const validated = validateTerms(updates, `${GLOSSARY_FILE} 更新`);
	if (validated.length === 0) return loadGlossary(root);
	const current = loadGlossary(root);
	const byCanonical = new Map(current.terms.map((term) => [term.canonical, term]));
	for (const update of validated) {
		const existing = byCanonical.get(update.canonical);
		if (existing === void 0) byCanonical.set(update.canonical, update);
		else {
			existing.variants = [.../* @__PURE__ */ new Set([...existing.variants, ...update.variants])];
			if (update.note !== void 0) existing.note = update.note;
		}
	}
	const glossary = { terms: [...byCanonical.values()] };
	const file = glossaryPath(root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, stringify(glossary, { lineWidth: 100 }) + "\n", "utf8");
	cache.set(root, {
		mtimeMs: statSync(file).mtimeMs,
		glossary
	});
	return glossary;
}
//#endregion
//#region src/mode.ts
function asMode(value) {
	return value === "auto" || value === "review" || value === "interactive" ? value : void 0;
}
/** 是否是 CI / headless 场景（无人在交互界面前等结果）。 */
function isUnattended(env) {
	return [
		env.CI,
		env.DSH_HEADLESS,
		env.CONTINUOUS_INTEGRATION
	].some((flag) => flag !== void 0 && flag !== "" && flag !== "0" && flag !== "false");
}
/**
* 按判定顺序解析本次走查的运行模式，先命中先生效：
* 1. 命令行显式指定 `--mode`；
* 2. `.ux/rules.local.yml` 的 `mode`；
* 3. 插件配置（非 `detect` 时）；
* 4. 自动探测：CI / headless → auto；R7 自动触发 → auto；用户发起 → review。
* @param input - 各优先级的输入信号。
* @returns 生效模式与命中的依据。
*/
function resolveMode(input) {
	const explicit = asMode(input.explicit?.toLowerCase());
	if (explicit !== void 0) return {
		mode: explicit,
		reason: "命令行显式指定 --mode"
	};
	const local = asMode(input.localRules?.mode);
	if (local !== void 0) return {
		mode: local,
		reason: ".ux/rules.local.yml 的 mode"
	};
	const configured = input.configured;
	if (configured !== void 0 && configured !== "detect") {
		const fromConfig = asMode(configured);
		if (fromConfig !== void 0) return {
			mode: fromConfig,
			reason: "插件配置 mode"
		};
	}
	if (isUnattended(input.env ?? process.env)) return {
		mode: "auto",
		reason: "CI / headless 环境，无人等待确认"
	};
	if (input.trigger === "auto-scan") return {
		mode: "auto",
		reason: "R7 改动自动触发，由 agent 自行消化"
	};
	return {
		mode: "review",
		reason: "用户主动发起，出报告后批量确认"
	};
}
//#endregion
//#region src/product.ts
const PRODUCT_TYPES = [
	"consumer",
	"enterprise",
	"ecommerce",
	"content",
	"finance",
	"healthcare",
	"developer-tool",
	"internal-tool",
	"other"
];
function normalizeProductType(value) {
	return PRODUCT_TYPES.includes(value) ? value : "other";
}
const FOCUS_ZH = {
	consumer: [
		"首次使用与引导",
		"主要操作是否容易发现",
		"移动端与弱网体验"
	],
	enterprise: [
		"高频任务效率",
		"信息密度与批量操作",
		"错误恢复与权限反馈"
	],
	ecommerce: [
		"商品发现与比较",
		"购物车/结算连续性",
		"价格、库存与信任信息"
	],
	content: [
		"阅读层级与可读性",
		"内容发现与导航",
		"长内容和列表浏览效率"
	],
	finance: [
		"风险与后果说明",
		"数据可信度和状态反馈",
		"不可逆操作保护"
	],
	healthcare: [
		"信息准确与可理解性",
		"隐私和风险提示",
		"关键任务容错"
	],
	"developer-tool": [
		"功能可发现性",
		"诊断信息与恢复路径",
		"高频操作效率"
	],
	"internal-tool": [
		"高信息密度下的层级",
		"批量操作效率",
		"误操作防护与恢复"
	],
	other: [
		"主要任务是否清楚",
		"状态反馈是否完整",
		"布局层级与操作效率"
	]
};
const FOCUS_EN = {
	consumer: [
		"first-use guidance",
		"discoverability of primary actions",
		"mobile and unstable-network experience"
	],
	enterprise: [
		"high-frequency task efficiency",
		"information density and bulk actions",
		"error recovery and permission feedback"
	],
	ecommerce: [
		"product discovery and comparison",
		"cart/checkout continuity",
		"price, stock, and trust information"
	],
	content: [
		"reading hierarchy and readability",
		"content discovery and navigation",
		"long-content and list browsing"
	],
	finance: [
		"risk and consequence communication",
		"data trust and state feedback",
		"protection for irreversible actions"
	],
	healthcare: [
		"accuracy and comprehension",
		"privacy and risk communication",
		"fault tolerance for critical tasks"
	],
	"developer-tool": [
		"feature discoverability",
		"diagnostics and recovery paths",
		"high-frequency operation efficiency"
	],
	"internal-tool": [
		"hierarchy under high information density",
		"bulk-operation efficiency",
		"mistake prevention and recovery"
	],
	other: [
		"clarity of the primary task",
		"complete state feedback",
		"layout hierarchy and operation efficiency"
	]
};
function productReviewFocus(type, language) {
	return language === "zh-CN" ? FOCUS_ZH[type] : FOCUS_EN[type];
}
//#endregion
//#region src/rules.ts
const RULES = [
	{
		id: "R-01",
		name: "错误提示无行动指引",
		category: "microcopy",
		signal: "catch / error 分支的用户可见文案只描述失败，无下一步建议",
		astAssertion: "仅能验证\"这是错误分支中的用户可见文案\"，文案质量本身无法验证",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-02",
		name: "术语不一致",
		category: "microcopy",
		signal: "同一概念在不同页面使用不同词（如\"账户/帐号/用户\"混用）",
		astAssertion: "仅能提取候选术语位置，是否同义由模型判断",
		astAssertable: false,
		fastLane: false,
		conditional: true,
		minimumEvidence: "static"
	},
	{
		id: "R-03",
		name: "不可逆操作文案泛化",
		category: "microcopy",
		signal: "delete / remove / clear 类操作使用\"确定\"\"提交\"等无信息量文案",
		astAssertion: "仅能提取确认文案字面量，是否泛化由模型判断",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-04",
		name: "不可逆操作缺二次确认",
		category: "state-coverage",
		signal: "删除 / 清空类调用前无确认交互",
		astAssertion: "该调用路径上确实不存在确认交互节点",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-05",
		name: "有 loading 无 empty",
		category: "state-coverage",
		signal: "列表渲染存在加载分支但无空数组分支",
		astAssertion: "条件渲染分支中确实不存在空数组分支",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-06",
		name: "有 success 无 error",
		category: "state-coverage",
		signal: "异步调用无 catch，或 catch 内无用户可见反馈",
		astAssertion: "该异步调用确实无 catch，或 catch 内无渲染输出",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-07",
		name: "提交中按钮未禁用",
		category: "state-coverage",
		signal: "异步提交流程中无 pending 态锁定",
		astAssertion: "提交流程中确实无 pending 态绑定到 disabled",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-08",
		name: "无超长内容兜底",
		category: "state-coverage",
		signal: "直接渲染用户输入字段，无截断或占位处理",
		astAssertion: "该字段确实被直接渲染，无截断或占位处理",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-09",
		name: "深色 / 浅色模式适配缺失",
		category: "theme-adaptation",
		signal: "硬编码颜色字面量未走主题变量；或 Tailwind 类名写死 text-*/bg-* 无 dark: 变体",
		astAssertion: "该 className 确实无对应 dark: 变体；该颜色确实是硬编码字面量",
		astAssertable: true,
		fastLane: true,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-10",
		name: "布局拥挤或分组层级不清",
		category: "layout-density",
		signal: "同一区域承载过多操作，或间距/分组信号不足",
		astAssertion: "源码只能提取高密度操作与间距候选；必须结合真实截图确认视觉结果",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "rendered"
	},
	{
		id: "R-11",
		name: "长列表缺少浏览控制",
		category: "layout-density",
		signal: "列表直接渲染，未发现分页、虚拟滚动、折叠或数量限制",
		astAssertion: "列表渲染路径中未发现常见的分页/虚拟化/截断信号",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-12",
		name: "装饰元素与视觉语言不一致",
		category: "layout-density",
		signal: "Emoji、文字图标与图标库混用，可能破坏产品视觉一致性",
		astAssertion: "源码可定位 Emoji/装饰元素；是否影响审美必须结合产品类型与截图判断",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "rendered"
	},
	{
		id: "R-13",
		name: "页面用途或主要操作不清",
		category: "navigation-guidance",
		signal: "页面有多个操作，但缺少标题、用途说明、主要操作层级或首次使用指引",
		astAssertion: "源码只能提取标题和操作入口候选；是否容易理解必须结合首屏截图判断",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "rendered"
	},
	{
		id: "R-14",
		name: "关键任务存在冗余交互",
		category: "interaction-flow",
		signal: "完成关键任务需要不必要的跳转、重复输入、弹窗或确认步骤",
		astAssertion: "单个文件无法证明流程冗余；必须按 persona 实际执行任务并记录步骤",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "interactive"
	},
	{
		id: "R-15",
		name: "功能分类不符合用户任务",
		category: "information-architecture",
		signal: "导航按组织架构或内部模块切分，目标用户难以找到完成任务所需功能",
		astAssertion: "源码只能提供路由和导航结构；必须按 persona 实际寻找功能并记录路径",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "interactive"
	},
	{
		id: "R-16",
		name: "导航层级过深或缺少位置感",
		category: "information-architecture",
		signal: "关键任务需要多次跳转，且页面缺少当前位置、上级和后续路径提示",
		astAssertion: "路由层级只能作为候选；点击深度和位置感必须通过任务执行验证",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "interactive"
	},
	{
		id: "R-17",
		name: "长时间操作缺少进度反馈",
		category: "state-coverage",
		signal: "加载、提交或后台处理存在等待过程，但没有 pending/progress/status 反馈",
		astAssertion: "异步流程中未发现 loading、pending、progress 或状态反馈信号",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-18",
		name: "表单字段或必填项过多",
		category: "form-flow",
		signal: "单个任务要求填写大量字段，或将非必要信息设为必填",
		astAssertion: "源码可统计字段和 required 候选；必要性必须结合业务目标与页面确认",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "rendered"
	},
	{
		id: "R-19",
		name: "表单校验反馈过晚",
		category: "form-flow",
		signal: "用户完成整份表单或提交后才看到本可提前发现的字段错误",
		astAssertion: "校验触发时机需要输入和提交表单后验证",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "interactive"
	},
	{
		id: "R-20",
		name: "中途退出会丢失表单进度",
		category: "form-flow",
		signal: "长表单或多步骤流程无法暂存，返回或刷新后已填内容丢失",
		astAssertion: "必须实际填写、离开并恢复流程，记录数据是否保留",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "interactive"
	},
	{
		id: "R-21",
		name: "缺少退出、取消或撤销路径",
		category: "form-flow",
		signal: "用户进入流程后无法安全退出，或完成操作后没有合理撤销机制",
		astAssertion: "单个组件无法证明用户被困住；必须执行流程并检查退出与恢复路径",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "interactive"
	},
	{
		id: "R-22",
		name: "选项过多且缺少默认值或推荐",
		category: "layout-density",
		signal: "同一决策点提供大量同级选项，没有默认值、推荐项、搜索或分组",
		astAssertion: "源码可统计候选选项；认知负担必须结合实际页面和 persona 判断",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "rendered"
	},
	{
		id: "R-23",
		name: "同一操作跨页面不一致",
		category: "consistency",
		signal: "相同操作在不同页面使用不同位置、命名或交互方式",
		astAssertion: "需要比较多个真实页面或状态，单个源码位置不能定稿",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "rendered"
	},
	{
		id: "R-24",
		name: "相似组件的行为不一致",
		category: "consistency",
		signal: "视觉相同的组件行为不同，或行为相同但视觉表达明显不同",
		astAssertion: "必须操作并比较相似组件的真实行为",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "interactive"
	},
	{
		id: "R-25",
		name: "首次使用、离线或无权限状态缺失",
		category: "edge-state",
		signal: "页面只覆盖理想路径，没有首次使用、无网络、无权限等关键边缘状态",
		astAssertion: "在完整组件/页面范围内检查相应状态分支是否存在",
		astAssertable: true,
		fastLane: false,
		conditional: false,
		minimumEvidence: "static"
	},
	{
		id: "R-26",
		name: "基础视觉可用性不足",
		category: "accessibility-performance",
		signal: "对比度不足、字号过小或触控热区过小",
		astAssertion: "必须基于真实计算样式、元素尺寸和目标视口测量",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "rendered"
	},
	{
		id: "R-27",
		name: "响应速度影响关键任务",
		category: "accessibility-performance",
		signal: "首屏、提交或关键交互等待时间过长，且缺少可接受的渐进反馈",
		astAssertion: "必须执行关键任务并记录等待时间和反馈过程",
		astAssertable: false,
		fastLane: false,
		conditional: false,
		minimumEvidence: "interactive"
	}
];
/** 规则 ID 快速索引。 */
const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));
/** 是否是合法规则 ID。 */
function isRuleId(value) {
	return RULE_BY_ID.has(value);
}
/** 规则对应的默认分类。 */
function categoryOfRule(ruleId) {
	return RULE_BY_ID.get(ruleId)?.category ?? "state-coverage";
}
//#endregion
//#region src/surface.ts
/**
* 人话页面名（`surface`）的素材提取（v0.1.1 spec §3.4）。
*
* 卡片首屏要回答的第一个问题是"**哪个页面**出了事"。文件路径回答不了这个
* 问题——它对人没有意义。所以走查要给出人话位置名，来源按优先级：
*
* 1. 路由配置中的 `title` / `meta.title`
* 2. 页面根组件内的 `h1` 文本
* 3. 面包屑或导航中指向该路由的链接文案
* 4. 以上都没有时，由模型根据组件名与页面内容拟一个中文名称
*
* **兜底规则**：拟不出人话名称时用路由路径（`/admin/users`），但**不得**退化
* 为文件路径。
*
* 本模块只负责提取 1-3 的**素材**（hints），交给模型选用或据以拟名；
* 净化与兜底在 `ux_report` 定稿时执行（见 {@link sanitizeSurface}）。
*/
/** 新建一份空索引。 */
function createSurfaceIndex() {
	return {
		routes: [],
		navLinks: [],
		headings: /* @__PURE__ */ new Map(),
		symbols: /* @__PURE__ */ new Map()
	};
}
const TITLE_KEYS = /* @__PURE__ */ new Set([
	"title",
	"label",
	"name"
]);
const NAV_TAGS = /* @__PURE__ */ new Set([
	"Link",
	"NavLink",
	"router-link",
	"RouterLink",
	"a"
]);
function literalText(node) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		const text = node.text.trim();
		return text.length === 0 ? void 0 : text;
	}
}
/** 读取对象字面量里某个键的字符串值。 */
function stringProperty(object, key) {
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const name = property.name;
		if ((ts.isIdentifier(name) ? name.text : ts.isStringLiteral(name) ? name.text : void 0) !== key) continue;
		return literalText(property.initializer);
	}
}
/** 读取对象字面量里 `meta: { title }` 之类的嵌套标题。 */
function nestedTitle(object) {
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const name = property.name;
		const propertyName = ts.isIdentifier(name) ? name.text : void 0;
		if (propertyName !== "meta" && propertyName !== "handle") continue;
		if (!ts.isObjectLiteralExpression(property.initializer)) continue;
		for (const key of TITLE_KEYS) {
			const value = stringProperty(property.initializer, key);
			if (value !== void 0) return value;
		}
	}
}
/** 从 `component: () => import('./x')` / `element: <X/>` 提取组件线索。 */
function componentHint(object) {
	const hint = {};
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const name = property.name;
		const key = ts.isIdentifier(name) ? name.text : void 0;
		if (key !== "component" && key !== "element" && key !== "Component") continue;
		const initializer = property.initializer;
		if (ts.isIdentifier(initializer)) {
			hint.component = initializer.text;
			continue;
		}
		if (ts.isJsxSelfClosingElement(initializer) || ts.isJsxElement(initializer)) {
			const tag = ts.isJsxElement(initializer) ? initializer.openingElement.tagName : initializer.tagName;
			if (ts.isIdentifier(tag)) hint.component = tag.text;
			continue;
		}
		const found = findImportSpecifier(initializer);
		if (found !== void 0) hint.module = found;
	}
	return hint;
}
function findImportSpecifier(node) {
	let specifier;
	const visit = (current) => {
		if (specifier !== void 0) return;
		if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const argument = current.arguments[0];
			if (argument !== void 0) specifier = literalText(argument);
			return;
		}
		ts.forEachChild(current, visit);
	};
	visit(node);
	return specifier;
}
/** 从 JSX 属性里读取字符串值（`path="/admin"` 或 `to={'/admin'}`）。 */
function jsxAttributeText(element, key) {
	for (const attribute of element.attributes.properties) {
		if (!ts.isJsxAttribute(attribute)) continue;
		if (attribute.name.getText() !== key) continue;
		const initializer = attribute.initializer;
		if (initializer === void 0) continue;
		if (ts.isStringLiteral(initializer)) return initializer.text.trim();
		if (ts.isJsxExpression(initializer) && initializer.expression !== void 0) return literalText(initializer.expression);
	}
}
/** JSX 元素内的直接文本（导航链接文案）。 */
function jsxChildText(element) {
	const parts = [];
	for (const child of element.children) {
		if (ts.isJsxText(child)) {
			const text = child.text.trim();
			if (text.length > 0) parts.push(text);
			continue;
		}
		if (ts.isJsxExpression(child) && child.expression !== void 0) {
			const text = literalText(child.expression);
			if (text !== void 0) parts.push(text);
		}
	}
	const joined = parts.join("").trim();
	return joined.length === 0 ? void 0 : joined;
}
/**
* 从一个 TS / TSX 源文件收集素材，合并进索引。
* @param index - 累积索引（就地写入）。
* @param file - 相对项目根的文件路径。
* @param source - 源码文本。
* @param scriptKind - 解析用的脚本种类。
*/
function collectSurfaceHints(index, file, source, scriptKind = ts.ScriptKind.TSX) {
	let sourceFile;
	try {
		sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
	} catch {
		return;
	}
	const visit = (node) => {
		if (ts.isObjectLiteralExpression(node)) {
			const route = stringProperty(node, "path");
			if (route !== void 0 && route.length > 0) {
				const title = nestedTitle(node) ?? stringProperty(node, "title");
				const hint = componentHint(node);
				index.routes.push({
					route,
					...title === void 0 ? {} : { title },
					...hint.component === void 0 ? {} : { component: hint.component },
					...hint.module === void 0 ? {} : { module: hint.module }
				});
			}
		}
		if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
			const tag = node.tagName.getText();
			if (tag === "Route") {
				const route = jsxAttributeText(node, "path");
				if (route !== void 0) {
					const title = jsxAttributeText(node, "title");
					const element = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText() === "element");
					let component;
					const initializer = element?.initializer;
					if (initializer !== void 0 && ts.isJsxExpression(initializer) && initializer.expression !== void 0) {
						const expression = initializer.expression;
						const inner = ts.isJsxSelfClosingElement(expression) ? expression.tagName : ts.isJsxElement(expression) ? expression.openingElement.tagName : void 0;
						if (inner !== void 0 && ts.isIdentifier(inner)) component = inner.text;
					}
					index.routes.push({
						route,
						...title === void 0 ? {} : { title },
						...component === void 0 ? {} : { component }
					});
				}
			}
			if (NAV_TAGS.has(tag) && ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent)) {
				const route = jsxAttributeText(node, "to") ?? jsxAttributeText(node, "href");
				const text = jsxChildText(node.parent);
				if (route !== void 0 && text !== void 0) index.navLinks.push({
					route,
					text
				});
			}
		}
		if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === "h1" && !index.headings.has(file)) {
			const text = jsxChildText(node);
			if (text !== void 0) index.headings.set(file, text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	const symbol = exportedComponentName(sourceFile);
	if (symbol !== void 0) index.symbols.set(file, symbol);
}
/** 文件的主要导出组件名（首字母大写的导出函数 / 变量 / 类）。 */
function exportedComponentName(sourceFile) {
	let fallback;
	for (const statement of sourceFile.statements) {
		if (!(ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true)) continue;
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
			const name = statement.name?.text;
			if (name !== void 0 && /^[A-Z]/u.test(name)) return name;
			fallback ??= name;
			continue;
		}
		if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) continue;
			const name = declaration.name.text;
			if (/^[A-Z]/u.test(name)) return name;
			fallback ??= name;
		}
	}
	return fallback;
}
/**
* 从一个 Vue SFC 收集素材：模板里的 h1 与 router-link 文案。
* @param index - 累积索引（就地写入）。
* @param file - 相对项目根的 .vue 路径。
* @param source - SFC 源码。
*/
function collectVueSurfaceHints(index, file, source) {
	let descriptor;
	try {
		descriptor = parse$1(source, { filename: file }).descriptor;
	} catch {
		return;
	}
	const symbol = file.split("/").at(-1)?.replace(/\.vue$/u, "");
	if (symbol !== void 0 && symbol.length > 0) index.symbols.set(file, symbol);
	const scriptBlocks = [descriptor.scriptSetup, descriptor.script].filter((block) => block !== null && block.content.trim().length > 0);
	for (const block of scriptBlocks) collectSurfaceHints(index, file, block.content, ts.ScriptKind.TS);
	const template = descriptor.template;
	if (template === null || template.content.trim().length === 0) return;
	let root;
	try {
		root = baseParse(template.content, { onError: () => {} });
	} catch {
		return;
	}
	const textOf = (element) => {
		const joined = element.children.filter((child) => child.type === NodeTypes.TEXT).map((child) => child.content.trim()).filter((text) => text.length > 0).join("").trim();
		return joined.length === 0 ? void 0 : joined;
	};
	const walk = (children) => {
		for (const child of children) {
			if (child.type !== NodeTypes.ELEMENT) continue;
			const element = child;
			if (element.tag === "h1" && !index.headings.has(file)) {
				const text = textOf(element);
				if (text !== void 0) index.headings.set(file, text);
			}
			if (NAV_TAGS.has(element.tag)) {
				const to = element.props.find((prop) => prop.type === NodeTypes.ATTRIBUTE && (prop.name === "to" || prop.name === "href"));
				const route = to !== void 0 && to.type === NodeTypes.ATTRIBUTE ? to.value?.content : void 0;
				const text = textOf(element);
				if (route !== void 0 && route.length > 0 && text !== void 0) index.navLinks.push({
					route,
					text
				});
			}
			walk(element.children);
		}
	};
	walk(root.children);
}
/** 路由条目是否指向该文件（组件名或懒加载模块说明符匹配）。 */
function routePointsTo(entry, file, symbol) {
	if (entry.component !== void 0 && symbol !== void 0 && entry.component === symbol) return true;
	if (entry.module === void 0) return false;
	const base = entry.module.replace(/^[./]+/u, "").replace(/\.(?:tsx?|jsx?|vue)$/u, "");
	const target = file.replace(/\.(?:tsx?|jsx?|vue)$/u, "");
	return base.length > 0 && (target.endsWith(base) || target.endsWith(`${base}/index`));
}
/**
* 为一个文件计算人话位置名候选（spec §3.4 的优先级顺序）。
* @param index - 扫描期累积的素材索引。
* @param file - 相对项目根的文件路径。
* @returns 候选名（可能为空）与关联路由。
*/
function surfaceCandidatesFor(index, file) {
	const symbol = index.symbols.get(file);
	const entry = index.routes.find((route) => routePointsTo(route, file, symbol));
	const heading = index.headings.get(file);
	const navText = entry === void 0 ? void 0 : index.navLinks.find((link) => link.route === entry.route)?.text;
	const candidates = [
		entry?.title,
		heading,
		navText
	].filter((value) => value !== void 0);
	return {
		file,
		...entry?.title === void 0 ? {} : { routeTitle: entry.title },
		...heading === void 0 ? {} : { heading },
		...navText === void 0 ? {} : { navText },
		...entry === void 0 ? {} : { route: entry.route },
		...symbol === void 0 ? {} : { symbol },
		candidates: [...new Set(candidates)]
	};
}
/** 看起来像文件路径 / 代码标识而非人话页面名。 */
function looksLikeFilePath(value) {
	return /\.(?:tsx?|jsx?|vue|css|scss)\b/u.test(value) || /(?:^|[\\/])(?:src|app|pages|components|views)[\\/]/u.test(value) || value.includes("\\") || /^[.~@]?\//u.test(value);
}
/**
* 定稿时的 surface 净化与兜底：
* 模型给的名字像文件路径 → 换成路由路径 → 再不行退到组件名。
* **任何情况下都不会返回文件路径**（spec §8 验收）。
* @param proposed - 模型给出的位置名（可能缺失或不合格）。
* @param fallback - 兜底素材：路由路径与组件名。
* @returns 可直接上界面的人话位置名。
*/
function sanitizeSurface(proposed, fallback) {
	const trimmed = proposed?.trim() ?? "";
	if (trimmed.length > 0 && !looksLikeFilePath(trimmed)) return trimmed;
	if (fallback.route !== void 0 && fallback.route.trim().length > 0) return fallback.route.trim();
	if (fallback.symbol !== void 0 && fallback.symbol.trim().length > 0) return fallback.symbol.trim();
	return "未命名页面";
}
//#endregion
//#region src/scope.ts
/**
* 本次走查的扫描范围记录（v0.1.1 spec §6.3）。
*
* 隐式确认必须区分「扫了没发现」与「根本没扫」——这是整个机制最容易出错的
* 地方。判断依据只能是**本次实际扫描到的文件清单**，所以 `ux_scan` 每跑一次
* 就把收集到的文件累加进来，`ux_report` 定稿时取走。
*
* 多 persona 走查会连续调用多次 `ux_scan`（逐个画像独立走查），最后只调一次
* `ux_report`，所以这里是**累加**语义：取走时才清空。
*
* 保存在进程内存里（按 sessionId 键控）而不是文件：它只在"扫描 → 定稿"这一
* 小段窗口内有意义，落盘反而要处理陈旧数据。定稿时拿不到（进程重启等）则
* 退回 `ux_report` 的显式 `scope_paths` 参数。
*/
const scopes = /* @__PURE__ */ new Map();
function ensure(sessionId) {
	const existing = scopes.get(sessionId);
	if (existing !== void 0) return existing;
	const created = {
		files: /* @__PURE__ */ new Set(),
		surface: createSurfaceIndex()
	};
	scopes.set(sessionId, created);
	return created;
}
/**
* 累加一次 `ux_scan` 的扫描结果。
* @param sessionId - 会话 id。
* @param files - 本次收集到的文件路径。
* @param surface - 本次收集到的位置素材（就地合并）。
*/
function rememberScope(sessionId, files, surface) {
	const scope = ensure(sessionId);
	for (const file of files) scope.files.add(file);
	scope.surface.routes.push(...surface.routes);
	scope.surface.navLinks.push(...surface.navLinks);
	for (const [file, heading] of surface.headings) scope.surface.headings.set(file, heading);
	for (const [file, symbol] of surface.symbols) scope.surface.symbols.set(file, symbol);
}
/**
* 取走并清空当前累积的范围（`ux_report` 定稿时调用）。
* @param sessionId - 会话 id。
* @returns 累积范围；没有扫描过时 undefined。
*/
function takeScope(sessionId) {
	const scope = scopes.get(sessionId);
	scopes.delete(sessionId);
	return scope;
}
//#endregion
//#region src/report-tool.ts
/**
* `ux_report` 工具（spec §6 R3/R5 + 多 persona 合并；v0.1.1 §3/§4/§6）：
*
* 模型完成判定后的**唯一定稿入口**。职责：
* - 校验 persona_refs（必须存在且非空；无 persona 不出结论）；
* - 执行硬约束：没有 locator 的 finding 不输出（丢弃并给出原因）；
* - 执行人话约束：写不出人话 description 的 finding 宁可不报（v0.1.1 §3.5/§9）；
* - surface 净化：人话位置名兜底到路由路径，**绝不退化为文件路径**（§3.4）；
* - 严重度矩阵：impact 由模型给出，reach 由命中 persona 的 share 之和推导，
*   level 由矩阵推导（spec §5.3），上界面时换成人话标签（§3.3）；
* - 多 persona 合并：同一 locator 同一规则合并为一条，persona_refs 取并集；
* - 跨走查指纹 + 隐式确认：上一轮消失且位置被重新扫描的问题记为
*   `confirmed_implicit`，没扫到的记为 `stale` 不计入指标（§6）；
* - 以 `ux/report` 会话事件持久化（卡片与确认闭环的数据源）；
* - R-02 术语判定增量合并进 `.ux/glossary.yml`；
* - 输出 Markdown 报告：共性问题在前，各 persona 个性问题随后，按严重度排序。
*/
/** 实例 token：跨进程重启的报告 id 也不会重复。 */
const instanceToken = randomUUID().slice(0, 8);
let reportSeq = 0;
const EVIDENCE_ORDER = {
	static: 0,
	rendered: 1,
	interactive: 2
};
function mintReportId() {
	reportSeq += 1;
	return `ux-rpt-${instanceToken}-${reportSeq}`;
}
/** 是否属于"共性问题"（>= 2 个 persona 命中）。 */
function isCommon(finding) {
	return finding.technical.persona_refs.length > 1;
}
function bySeverity(left, right) {
	return (SEVERITY_ORDER[left.technical.severity.level] ?? 9) - (SEVERITY_ORDER[right.technical.severity.level] ?? 9);
}
/** 渲染一份 Markdown 报告（spec §R5；人话在前，技术细节缩进在后）。 */
function renderReport(result, personas) {
	const zh = isChinese(result.language);
	const evidenceLevels = [...new Set(result.findings.map((finding) => finding.technical.evidence_level))].join(" / ") || "static";
	const focus = productReviewFocus(result.product_type, result.language).join(zh ? "、" : ", ");
	const lines = [
		`# ${zh ? "UX 走查报告" : "UX walkthrough report"}: ${result.title}`,
		"",
		`> ${zh ? "产品类型" : "Product type"}: **${result.product_type}** · ${zh ? "证据等级" : "Evidence"}: **${evidenceLevels}**`,
		`> ${zh ? "本类产品重点" : "Product-specific focus"}: ${focus}`,
		""
	];
	if (result.persona_status === "draft") lines.push(zh ? "> 本次按草稿画像走查。画像不对可以直接说。" : "> This walkthrough used draft personas. Say so if they are wrong.", "");
	const findings = [...result.findings].sort(bySeverity);
	const common = findings.filter(isCommon);
	if (common.length > 0) {
		lines.push(zh ? "## 共性问题（≥ 2 个画像独立命中，可信度更高）" : "## Shared findings (independently observed for ≥2 personas)", "");
		for (const finding of common) lines.push(renderFinding(finding, personas, result.language), "");
	}
	const seen = new Set(common.map((finding) => finding.id));
	const perPersona = /* @__PURE__ */ new Map();
	for (const finding of findings) {
		if (seen.has(finding.id)) continue;
		for (const ref of finding.technical.persona_refs) {
			const list = perPersona.get(ref) ?? [];
			list.push(finding);
			perPersona.set(ref, list);
		}
	}
	for (const [personaId, list] of perPersona) {
		lines.push(`## ${zh ? "画像问题" : "Persona findings"} — ${personas.get(personaId) ?? personaId}`, "");
		for (const finding of list) lines.push(renderFinding(finding, personas, result.language), "");
	}
	if (findings.length === 0) lines.push(zh ? "## 结果" : "## Result", "", zh ? "本轮未发现有充分证据支持的问题。" : "No findings with sufficient evidence were found in this walkthrough.", "");
	const counts = /* @__PURE__ */ new Map();
	for (const finding of findings) {
		const label = finding.human.severity_label;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const countText = (zh ? [
		"一级问题",
		"二级问题",
		"三级问题",
		"四级问题"
	] : [
		"Level one",
		"Level two",
		"Level three",
		"Level four"
	]).filter((label) => counts.has(label)).map((label) => `${label} × ${counts.get(label) ?? 0}`).join(zh ? "，" : ", ") || (zh ? "无" : "none");
	lines.push(zh ? "## 汇总" : "## Summary", "", zh ? `- 本轮输出 ${findings.length} 条（${countText}）` : `- ${findings.length} findings (${countText})`);
	if (result.implicit_confirmed > 0) lines.push(zh ? `- 上一轮有 ${result.implicit_confirmed} 条问题在本次走查中消失、且位置确实被重新扫描 → 记为已改进（隐式确认）` : `- ${result.implicit_confirmed} previous findings disappeared from locations that were re-scanned and are marked improved`);
	if (result.stale > 0) lines.push(zh ? `- ${result.stale} 条历史问题的位置本次未被扫描，无法判定，不计入指标` : `- ${result.stale} previous findings were outside this scan and are excluded from metrics`);
	lines.push(...confirmationHint(result.mode, findings, result.language));
	if (result.dropped.length > 0) {
		lines.push(zh ? `- 丢弃 ${result.dropped.length} 条：` : `- Dropped ${result.dropped.length} unsupported findings:`);
		for (const dropped of result.dropped) lines.push(zh ? `  - ${dropped.reason}${dropped.file === void 0 ? "" : `（${dropped.file}）`}` : `  - ${dropped.rule ?? "Finding"}${dropped.file === void 0 ? "" : ` at ${dropped.file}`} did not meet report constraints`);
	}
	if (result.glossary_terms > 0) lines.push(zh ? `- 术语表更新 ${result.glossary_terms} 条（.ux/glossary.yml）` : `- Glossary contains ${result.glossary_terms} terms (.ux/glossary.yml)`);
	return lines.join("\n");
}
/**
* 按模式给出确认提示。
* **auto 模式不索要确认**——agent 自己发起的走查由 agent 自己消化，
* 只在出现一级 / 二级问题时提示一句（v0.1.1 §4.2）。
*/
function confirmationHint(mode, findings, language) {
	const zh = isChinese(language);
	if (mode === "auto") {
		const urgent = findings.filter((finding) => isUrgent(finding.technical.severity.level));
		if (urgent.length === 0) return [];
		return [zh ? `- 其中 ${urgent.length} 条是一级 / 二级问题，建议优先查看` : `- ${urgent.length} level-one/two findings should be reviewed first`];
	}
	if (mode === "interactive") return [zh ? "- 逐条确认：卡片上点「确认存在 / 不是问题」，或直接说「第 2 条不成立」" : "- Review one by one using Confirm / Not an issue on each card"];
	return [zh ? "- 批量确认：卡片上勾选后一并提交，或直接说「这几条都对」「三级以下全部忽略」" : "- Select multiple findings on the card to confirm or reject them together"];
}
/** 单条 finding：人话在前，技术细节缩进在后（双读者，§3.1）。 */
function renderFinding(finding, personas, language) {
	const zh = isChinese(language);
	const tech = finding.technical;
	const locator = `${tech.locator.file}` + (tech.locator.line === void 0 ? "" : `:${String(tech.locator.line)}`) + (tech.locator.symbol === void 0 ? "" : `（${tech.locator.symbol}）`);
	const refs = tech.persona_refs.map((ref) => personas.get(ref) ?? ref).join("、");
	return [
		`### [${finding.human.severity_label}] ${finding.surface}｜${finding.human.headline}`,
		"",
		finding.human.description,
		"",
		`<details><summary>${zh ? "技术细节" : "Technical details"}</summary>`,
		"",
		`- ${zh ? "位置" : "Location"}: \`${locator}\``,
		`- ${zh ? "规则" : "Rule"}: ${tech.rule} (${tech.category}) | ${zh ? "证据" : "Evidence"}: ${tech.evidence_level} / ${tech.verified_by}`,
		`- ${zh ? "证据引用" : "Evidence references"}: ${tech.evidence_refs.join(" | ") || (zh ? "源码定位" : "source location")}`,
		`- ${zh ? "命中画像" : "Personas"}: ${refs} | ${zh ? "内部编号" : "Internal ID"}: ${finding.id} / ${tech.severity.level}`,
		`- ${zh ? "依据" : "Rationale"}: ${tech.rationale}`,
		`- ${zh ? "建议" : "Suggestion"}: ${tech.suggestion}`,
		"",
		"</details>"
	].join("\n");
}
const DRAFT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		rule: {
			type: "string",
			required: true,
			description: "R-01 … R-27"
		},
		category: {
			type: "string",
			description: "microcopy | state-coverage | theme-adaptation | layout-density | navigation-guidance | interaction-flow | information-architecture | form-flow | consistency | edge-state | accessibility-performance；缺省按规则推导"
		},
		persona_refs: {
			type: "array",
			items: { type: "string" },
			required: true,
			description: "命中该问题的 persona id 列表（非空）"
		},
		impact: {
			type: "string",
			required: true,
			enum: ["high", "low"],
			description: "是否阻断该 persona 完成关键任务"
		},
		impact_confidence: {
			type: "string",
			enum: [
				"high",
				"medium",
				"low"
			],
			description: "impact 判定的把握程度；缺省 medium"
		},
		verified_by: {
			type: "string",
			enum: [
				"model",
				"model+ast",
				"ast",
				"model+browser"
			],
			description: "验证来源；缺省 model"
		},
		evidence_level: {
			type: "string",
			enum: [
				"static",
				"rendered",
				"interactive"
			],
			description: "static=源码/CSS；rendered=真实 DOM/尺寸/截图；interactive=按 persona 实际执行任务。缺省 static。"
		},
		evidence_refs: {
			type: "array",
			items: { type: "string" },
			description: "可复核证据，如截图路径、route+viewport、DOM 测量或任务步骤。rendered/interactive 必填。"
		},
		file: {
			type: "string",
			required: true,
			description: "相对项目根的文件路径（locator 硬约束）"
		},
		symbol: {
			type: "string",
			description: "组件 / 符号级定位"
		},
		line: {
			type: "number",
			description: "行号（可选）"
		},
		surface: {
			type: "string",
			required: true,
			description: "开发者可理解的页面名，如\"管理员页面\"。优先取 ux_scan 的 surface_hints；拟不出时用路由路径。**不要给文件路径**——文件路径对人没有意义，会被丢弃并替换。"
		},
		headline: {
			type: "string",
			required: true,
			description: "一句话说清出了什么事，如\"删除用户后没有任何提示\"（不含文件名、规则 ID）"
		},
		description: {
			type: "string",
			required: true,
			description: "用户会遇到什么（2-3 句）。❌「handleDelete 的 catch 分支中没有调用 toast」 ✅「删除失败时界面没有任何提示，用户以为删成功了」。无法描述用户影响时不要报这条。"
		},
		feature: {
			type: "string",
			description: "跨走查比对用的特征：文案类给文案原文，结构类给被指认元素的语法特征（如 \"handleDelete 无 catch\"）"
		},
		rationale: {
			type: "string",
			required: true,
			description: "判定依据：规则 ID 或启发式条目原文（技术细节，给 AI 看）"
		},
		suggestion: {
			type: "string",
			required: true,
			description: "优化方向描述（不给具体代码）"
		}
	}
};
/** 注册 `ux_report` 工具。 */
function uxReportTool(config) {
	return defineTool({
		name: "ux_report",
		description: [
			"UX 走查定稿：把你判定后的 findings 汇总成正式报告。",
			"每条 finding 分两半——面向开发者的 surface/headline/description 与技术定位 locator/rule/severity。",
			"description 必须写\"用户会遇到什么\"，不写\"代码里缺什么\"；带代码腔的描述会被丢弃。",
			"surface 必须是开发者可理解的位置名或路由路径，给文件路径会被替换。",
			"证据分 static/rendered/interactive：后两者必须带截图、DOM 测量或任务步骤等 evidence_refs。",
			"每条规则的最低证据等级由规则目录约束；视觉/跨页面比较通常需要 rendered，实际流程与性能通常需要 interactive。",
			"必须携带 persona_refs（每一条都非空且存在于 .ux/personas.yml）——无 persona 不出结论。",
			"硬约束：没有 locator（file）的 finding 会被丢弃并在报告中列出原因。",
			"严重度由矩阵推导：impact 由你给出，reach 由命中画像 share 之和推导（>=0.5 为 wide）；上界面时换成一级~四级问题。",
			"同一位置同一规则自动合并为一条（persona_refs 取并集），多 persona 走查只需调用一次。",
			"本工具还会比对上一轮的问题：消失且位置被重新扫描的记为已改进，位置没扫到的记为无法判定。",
			"返回的 markdown 直接呈现给用户。"
		].join(" "),
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "报告标题（如\"订单流程 UX 走查\"）"
			},
			language: {
				type: "string",
				description: "输出语言（zh-CN 或 en）。优先跟随当前用户使用的语言；缺省按插件配置和项目 README 推断。"
			},
			product_type: {
				type: "string",
				enum: [
					"consumer",
					"enterprise",
					"ecommerce",
					"content",
					"finance",
					"healthcare",
					"developer-tool",
					"internal-tool",
					"other"
				],
				description: "根据 README、路由和业务流程判断的产品类型；无法可靠判断时用 other。"
			},
			persona_ids: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "本次走查覆盖的 persona id 列表（与画像文件一致）"
			},
			mode: {
				type: "string",
				enum: [
					"auto",
					"review",
					"interactive"
				],
				description: "本次走查的运行模式；缺省按场景自动选择（发起走查时的提示里已给出）"
			},
			scope_paths: {
				type: "array",
				items: { type: "string" },
				description: "本次实际走查到的文件清单；缺省自动取本会话 ux_scan 收集到的范围"
			},
			findings: {
				type: "array",
				items: DRAFT_SCHEMA,
				required: true,
				description: "模型判定后的 finding 草稿列表"
			},
			glossary_updates: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						canonical: {
							type: "string",
							required: true,
							description: "规范词"
						},
						variants: {
							type: "array",
							items: { type: "string" },
							required: true,
							description: "同义变体"
						},
						note: {
							type: "string",
							description: "判定备注"
						}
					}
				},
				description: "R-02 术语判定（增量合并进 .ux/glossary.yml）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					report_id: { type: "string" },
					title: { type: "string" },
					mode: { type: "string" },
					language: { type: "string" },
					product_type: { type: "string" },
					scope: {
						type: "array",
						items: { type: "string" }
					},
					findings: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								fingerprint: { type: "string" },
								surface: { type: "string" },
								human: {
									type: "object",
									additionalProperties: false,
									properties: {
										headline: { type: "string" },
										description: { type: "string" },
										severity_label: { type: "string" }
									}
								},
								technical: {
									type: "object",
									additionalProperties: false,
									properties: {
										locator: {
											type: "object",
											additionalProperties: false,
											properties: {
												file: { type: "string" },
												symbol: { type: "string" },
												line: { type: "number" }
											}
										},
										rule: { type: "string" },
										category: { type: "string" },
										verified_by: { type: "string" },
										evidence_level: { type: "string" },
										evidence_refs: {
											type: "array",
											items: { type: "string" }
										},
										persona_refs: {
											type: "array",
											items: { type: "string" }
										},
										severity: {
											type: "object",
											additionalProperties: false,
											properties: {
												impact: { type: "string" },
												impact_confidence: { type: "string" },
												reach: { type: "string" },
												level: { type: "string" }
											}
										},
										rationale: { type: "string" },
										suggestion: { type: "string" }
									}
								},
								status: { type: "string" }
							}
						}
					},
					dropped: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								reason: { type: "string" },
								rule: { type: "string" },
								file: { type: "string" }
							}
						}
					},
					implicit_confirmed: { type: "number" },
					stale: { type: "number" },
					glossary_terms: { type: "number" },
					persona_status: { type: "string" },
					markdown: { type: "string" }
				}
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: value.markdown
				}];
			}
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("ux_report：需要 agent 上下文（应在 agent loop 中调用）");
			const cwd = agent.session.header.cwd;
			if (cwd === void 0) throw new Error("ux_report：当前会话没有工作目录（cwd），无法定位项目");
			const loaded = loadPersonaFile(cwd);
			if (loaded === void 0) throw new Error("ux_report：项目还没有目标用户画像。请先根据 README 推断草稿并调用 ux_personas_write（自动走查用 status=draft；用户主动走查须确认后写入）。不要让用户敲命令。");
			const personas = loaded.personas;
			const personaNames = new Map(personas.map((persona) => [persona.id, persona.name]));
			const shareById = new Map(personas.map((persona) => [persona.id, persona.share]));
			const unknownReportPersonas = args.persona_ids.filter((id) => !shareById.has(id));
			if (unknownReportPersonas.length > 0) throw new Error(`ux_report：persona_ids 含未知画像 ${unknownReportPersonas.join(", ")}；合法画像：${personas.map((persona) => persona.id).join(", ")}`);
			if (args.persona_ids.length === 0) throw new Error("ux_report：persona_ids 不能为空（无 persona 不出结论）");
			const scanScope = takeScope(agent.session.id);
			const scope = scanScope !== void 0 && scanScope.files.size > 0 ? [...scanScope.files] : [...args.scope_paths ?? []];
			const surfaceIndex = scanScope?.surface ?? createSurfaceIndex();
			const mode = args.mode === "auto" || args.mode === "review" || args.mode === "interactive" ? args.mode : resolveMode({
				localRules: loadLocalRules(cwd),
				configured: config.mode,
				trigger: "user"
			}).mode;
			const language = resolveOutputLanguage(cwd, config.outputLanguage, args.language);
			const productType = normalizeProductType(args.product_type);
			const dropped = [];
			const merged = /* @__PURE__ */ new Map();
			const featureDigests = /* @__PURE__ */ new Map();
			const dedupeKey = (rule, file, symbol) => `${rule}|${file}|${symbol ?? ""}`;
			for (const draft of args.findings) {
				if (!isRuleId(draft.rule)) {
					dropped.push({
						reason: `未知规则 ${draft.rule}`,
						rule: draft.rule,
						file: draft.file
					});
					continue;
				}
				if (typeof draft.file !== "string" || draft.file.trim().length === 0) {
					dropped.push({
						reason: "无 locator（file 缺失）——硬约束：没有 locator 的问题不输出",
						rule: draft.rule
					});
					continue;
				}
				const refs = draft.persona_refs.filter((id) => shareById.has(id));
				if (refs.length === 0) {
					dropped.push({
						reason: "persona_refs 为空或全部无效——无 persona 不出结论",
						rule: draft.rule,
						file: draft.file
					});
					continue;
				}
				const headline = draft.headline?.trim() ?? "";
				if (headline.length === 0) {
					dropped.push({
						reason: "缺少 headline（一句话说清出了什么事）",
						rule: draft.rule,
						file: draft.file
					});
					continue;
				}
				const codeSpeak = codeSpeakReason(draft.description ?? "");
				if (codeSpeak !== void 0) {
					dropped.push({
						reason: `${codeSpeak}——description 要写"用户会遇到什么"，不写"代码里缺什么"`,
						rule: draft.rule,
						file: draft.file
					});
					continue;
				}
				const evidenceLevel = draft.evidence_level === "rendered" || draft.evidence_level === "interactive" ? draft.evidence_level : "static";
				const evidenceRefs = (draft.evidence_refs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0);
				const minimumEvidence = RULE_BY_ID.get(draft.rule)?.minimumEvidence ?? "static";
				if (EVIDENCE_ORDER[evidenceLevel] < EVIDENCE_ORDER[minimumEvidence]) {
					dropped.push({
						reason: `${draft.rule} 至少需要 ${minimumEvidence} 证据；当前只有 ${evidenceLevel}，不能把候选当成正式结论`,
						rule: draft.rule,
						file: draft.file
					});
					continue;
				}
				if (evidenceLevel !== "static" && evidenceRefs.length === 0) {
					dropped.push({
						reason: `${evidenceLevel} finding 缺少 evidence_refs（截图、DOM 测量或任务步骤）`,
						rule: draft.rule,
						file: draft.file
					});
					continue;
				}
				const file = draft.file.trim();
				const key = dedupeKey(draft.rule, file, draft.symbol);
				const existing = merged.get(key);
				if (existing !== void 0) {
					existing.technical.persona_refs = [.../* @__PURE__ */ new Set([...existing.technical.persona_refs, ...refs])];
					if (draft.impact === "high" && existing.technical.severity.impact === "low") existing.technical.severity.impact = "high";
					existing.technical.evidence_refs = [.../* @__PURE__ */ new Set([...existing.technical.evidence_refs, ...evidenceRefs])];
					if (EVIDENCE_ORDER[evidenceLevel] > EVIDENCE_ORDER[existing.technical.evidence_level]) existing.technical.evidence_level = evidenceLevel;
					continue;
				}
				const category = draft.category === "microcopy" || draft.category === "state-coverage" || draft.category === "theme-adaptation" || draft.category === "layout-density" || draft.category === "navigation-guidance" || draft.category === "interaction-flow" || draft.category === "information-architecture" || draft.category === "form-flow" || draft.category === "consistency" || draft.category === "edge-state" || draft.category === "accessibility-performance" ? draft.category : categoryOfRule(draft.rule);
				const impact = draft.impact === "high" ? "high" : "low";
				const reach = reachOf(refs.map((id) => shareById.get(id) ?? 0));
				const level = levelOf(impact, reach);
				const candidate = surfaceCandidatesFor(surfaceIndex, file);
				const resolvedSurface = sanitizeSurface(draft.surface, {
					...candidate.route === void 0 ? {} : { route: candidate.route },
					...draft.symbol === void 0 ? {} : { symbol: draft.symbol }
				});
				const surface = language === "en" && resolvedSurface === "未命名页面" ? "Unnamed page" : resolvedSurface;
				const symbolPath = symbolPathOf(file, draft.symbol);
				const featureDigest = featureDigestOf(draft.feature, `${draft.rule}|${symbolPath}`);
				const finding = {
					id: "",
					fingerprint: fingerprintOf({
						rule: draft.rule,
						symbolPath,
						featureDigest
					}),
					surface,
					human: {
						headline,
						description: draft.description.trim(),
						severity_label: severityLabel(level, language)
					},
					technical: {
						locator: {
							file,
							...draft.symbol === void 0 ? {} : { symbol: draft.symbol },
							...typeof draft.line === "number" && Number.isSafeInteger(draft.line) ? { line: draft.line } : {}
						},
						rule: draft.rule,
						category,
						verified_by: draft.verified_by === "model+ast" || draft.verified_by === "ast" || draft.verified_by === "model+browser" ? draft.verified_by : "model",
						evidence_level: evidenceLevel,
						evidence_refs: evidenceRefs,
						persona_refs: refs,
						severity: {
							impact,
							impact_confidence: draft.impact_confidence === "high" || draft.impact_confidence === "low" ? draft.impact_confidence : "medium",
							reach,
							level
						},
						rationale: draft.rationale,
						suggestion: draft.suggestion
					},
					status: "pending"
				};
				merged.set(key, finding);
				featureDigests.set(finding.fingerprint, featureDigest);
			}
			const findings = [...merged.values()].sort(bySeverity);
			while (findings.length > config.maxFindings) {
				const overflow = findings.pop();
				if (overflow !== void 0) dropped.push({
					reason: `超出单份报告上限（${config.maxFindings} 条），已按严重度裁剪`,
					rule: overflow.technical.rule,
					file: overflow.technical.locator.file
				});
			}
			findings.forEach((finding, index) => {
				finding.id = `UX-${String(index + 1).padStart(4, "0")}`;
			});
			const verdicts = reconcile(cwd, {
				scopeFiles: scope,
				current: findings.map((finding) => comparableOf(finding, featureDigests.get(finding.fingerprint) ?? ""))
			});
			const knownReports = new Set(agent.session.events.filter((event) => event.type === "ux/report").map((event) => event.data.reportId));
			for (const verdict of verdicts) {
				if (!knownReports.has(verdict.entry.report_id)) continue;
				agent.session.append("ux/finding-status", {
					reportId: verdict.entry.report_id,
					findingId: verdict.entry.finding_id,
					status: verdict.status
				});
			}
			const reportId = mintReportId();
			agent.session.append("ux/report", {
				reportId,
				title: args.title,
				mode,
				language,
				productType,
				scope,
				findings
			});
			recordScan(cwd, {
				reportId,
				scope,
				findings,
				featureDigests: new Map(findings.map((finding) => [finding.id, featureDigests.get(finding.fingerprint) ?? ""]))
			});
			let glossaryTerms = 0;
			if (args.glossary_updates !== void 0 && args.glossary_updates.length > 0) glossaryTerms = mergeGlossary(cwd, args.glossary_updates.map((update) => ({
				canonical: update.canonical,
				variants: update.variants,
				...update.note === void 0 ? {} : { note: update.note }
			}))).terms.length;
			else glossaryTerms = loadGlossary(cwd).terms.length;
			const result = {
				report_id: reportId,
				title: args.title,
				mode,
				language,
				product_type: productType,
				scope,
				findings,
				dropped,
				implicit_confirmed: verdicts.filter((verdict) => verdict.status === "confirmed_implicit").length,
				stale: verdicts.filter((verdict) => verdict.status === "stale").length,
				glossary_terms: glossaryTerms,
				persona_status: loaded.status,
				markdown: ""
			};
			result.markdown = renderReport(result, personaNames);
			return result;
		}
	});
}
//#endregion
//#region src/css.ts
const EMOJI = /\p{Extended_Pictographic}/u;
const SPACING_DECLARATION = /\b(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block))?\s*:\s*([0-9]+(?:\.[0-9]+)?)px\b/giu;
const BLOCK = /([^{}]+)\{([^{}]*)\}/gu;
function lineAt(source, offset) {
	return source.slice(0, offset).split("\n").length;
}
function snippet(text, max = 180) {
	const normalized = text.replace(/\s+/gu, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
/**
* CSS/SCSS/Less 的保守候选扫描。它只定位可能影响布局密度与视觉语言的信号；
* R-10/R-12 仍要求真实页面截图，不能由 CSS 候选直接定稿。
*/
function extractCssCandidates(file, source, options) {
	const candidates = [];
	const perRule = /* @__PURE__ */ new Map();
	const add = (candidate) => {
		if (candidates.length >= options.maxPerFile) return;
		const count = perRule.get(candidate.rule) ?? 0;
		if (count >= options.maxPerRule) return;
		perRule.set(candidate.rule, count + 1);
		candidates.push({
			...candidate,
			file
		});
	};
	const spacing = [...source.matchAll(SPACING_DECLARATION)];
	const values = new Set(spacing.map((match) => Number.parseFloat(match[1] ?? "0")).filter((value) => value > 0));
	if (spacing.length >= 8 && values.size >= 6) {
		const first = spacing[0];
		add({
			rule: "R-10",
			line: lineAt(source, first?.index ?? 0),
			snippet: `spacing values: ${[...values].sort((a, b) => a - b).join(", ")}px`,
			note: "同一文件出现较多离散间距值，可能削弱页面分组与留白的一致性；必须结合真实页面截图确认",
			verified_by: "model+ast"
		});
	}
	for (const match of source.matchAll(BLOCK)) {
		const selector = match[1] ?? "";
		const body = match[2] ?? "";
		const offset = match.index ?? 0;
		if (/display\s*:\s*(?:flex|grid)/iu.test(body) && /(?:^|;)\s*gap\s*:\s*(?:0|[1-4](?:\.\d+)?)px/iu.test(body) && /(?:^|;)\s*padding\s*:\s*(?:0|[1-4](?:\.\d+)?)px/iu.test(body)) add({
			rule: "R-10",
			line: lineAt(source, offset),
			snippet: snippet(`${selector} { ${body} }`),
			note: "flex/grid 容器同时使用很小的 gap 与 padding，可能造成内容拥挤；必须用对应视口截图确认",
			verified_by: "model+ast"
		});
		const content = /\bcontent\s*:\s*(['"])(.*?)\1/iu.exec(body)?.[2];
		if (content !== void 0 && EMOJI.test(content)) add({
			rule: "R-12",
			line: lineAt(source, offset),
			snippet: snippet(`${selector} { content: "${content}" }`),
			note: "CSS 伪元素使用 Emoji/装饰符号；是否与产品视觉语言一致需结合产品类型和截图判断",
			verified_by: "model+ast"
		});
	}
	return candidates;
}
//#endregion
//#region src/ast.ts
/**
* AST 求证引擎（spec 附录 A）：
*
* 用 TypeScript 编译器 API 把代码解析成结构化的语法树，按规则目录提取
* "可证伪的结构断言"。分工是：模型负责召回与语义判断，AST 负责精度——
* 把模型的猜测降为可证伪的结构断言（`verified_by: model+ast`）；
* R-09 是纯结构问题，AST 直接出结论（`verified_by: ast`，快车道，零 token）。
*
* 输出的 AstCandidate 是**候选证据**，不是最终 finding：
* - 每条候选都带 locator 与原文片段，模型可以据此去读码核实；
* - 模型确认后才经 `ux_report` 落为 finding；
* - R-02 的候选仅提供术语位置，同义判断只能由模型完成（verified_by: model）。
*
* 为什么不用正则：搜 `text-black` 会把注释、字符串常量、变量名一起搜出来；
* AST 知道它到底是不是 JSX 元素 className 属性里的类名（spec A.1）。
*/
/** 深色模式相关的 Tailwind 颜色类（含任意值），不含纯布局类如 text-center。 */
const COLOR_CLASS = /^(?:text|bg|border|ring|outline|fill|stroke|from|to|via|accent|caret|decoration|divide|placeholder|shadow)-(?:[a-z]+-\d+(?:\/\d+)?|\[(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))[^\]]*\]|black|white)(?:\/\d+)?$/u;
/** 硬编码颜色字面量。 */
const COLOR_LITERAL = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/u;
/** 硬编码颜色字面量的子串搜索版本（Vue :style 绑定等整段表达式内检索）。 */
const COLOR_LITERAL_SEARCH = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/u;
/** 错误文案中的"行动指引"词。 */
const ACTION_WORD = /重试|再试|刷新|稍后|点击|联系|查看|返回|取消|关闭|retry|refresh|try again|reload|contact|dismiss|undo|重连/u;
/** 泛化的确认文案（无信息量）。 */
const GENERIC_CONFIRM = /^(确定|确认|提交|继续|知道了|好的|OK|ok|Yes|yes|Submit|submit|Confirm|confirm|Yes,? I'?m sure)$/u;
/** 截断 / 占位兜底的信号。 */
const TRUNCATION_PATTERN = /truncate|ellipsis|clamp|line-clamp|text-overflow|word-break|break-all|overflow:\s*hidden|white-space:\s*nowrap/u;
/** 文件内出现任意确认交互的信号。 */
const CONFIRM_PATTERN = /confirm\(|Confirm|Dialog|Popconfirm|Modal\.|二次确认/u;
/** 破坏性操作调用名。 */
const DESTRUCTIVE_CALL = /^(?:handle)?(?:delete|remove|clear|reset|drop|destroy|wipe)\w*$/iu;
/** 提交类异步处理器名。 */
const SUBMIT_HANDLER = /submit|save|confirm|delete|remove/iu;
/** 函数体中出现"空态覆盖"的信号。 */
const EMPTY_PATTERN = /(?:\.length\s*(?:===|==|!==|!=|<=|>=|<|>)\s*0)|!\s*[\w[\].]*\.length|empty|isEmpty|hasData|暂无|空数据|空态|无数据|no data|no results|isBlank/iu;
/** 长列表控制信号：分页、虚拟化、窗口化、截断或显式数量限制。 */
const LIST_CONTROL_PATTERN = /paginat|pageSize|page_size|virtual|windowed|react-window|react-virtual|useVirtual|infinite|loadMore|slice\s*\(|take\s*\(|limit\b|showMore/iu;
/** 用户可见 Emoji / 图形符号。 */
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
/** 函数体中出现"加载分支"的信号（作用于条件表达式条件文本）。 */
const LOADING_PATTERN = /loading|pending|fetching|submitting/iu;
/** 类 label 属性名（术语候选素材）。 */
const LABEL_ATTRS = /* @__PURE__ */ new Set([
	"placeholder",
	"aria-label",
	"label",
	"title",
	"alt"
]);
function snippetOf$1(node, sf, max = 160) {
	const text = node.getText(sf).replace(/\s+/gu, " ").trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
function lineOf(node, sf) {
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
/** 找到 node 的命名祖先函数名（向上查一层即可，栈里已是最内层）。 */
function enclosingSymbol(ctx) {
	return ctx.frames.at(-1)?.symbol;
}
function addCandidate(ctx, candidate) {
	if (ctx.candidates.length >= ctx.options.maxPerFile) return;
	const count = ctx.perRule.get(candidate.rule) ?? 0;
	if (count >= ctx.options.maxPerRule) return;
	ctx.perRule.set(candidate.rule, count + 1);
	ctx.candidates.push({
		...candidate,
		file: ctx.file
	});
}
/** 节点是否位于 JSX 内部（用于区分用户可见文案与日志文案）。 */
function insideJsx(node) {
	let current = node.parent;
	while (current !== void 0 && !ts.isStatement(current)) {
		if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) return true;
		current = current.parent;
	}
	return false;
}
/** 提取 catch 体内的用户可见文案候选（R-01）。 */
function collectErrorCopy(ctx, clause) {
	const literals = [];
	const visit = (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			const text = node.text.trim();
			if (text.length >= 4) {
				if (insideJsx(node) || isUserFacingCallArg(node)) literals.push({
					text,
					node
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(clause);
	for (const literal of literals.slice(0, 3)) {
		if (ACTION_WORD.test(literal.text)) continue;
		addCandidate(ctx, {
			rule: "R-01",
			symbol: enclosingSymbol(ctx),
			line: lineOf(literal.node, ctx.sourceFile),
			snippet: snippetOf$1(literal.node, ctx.sourceFile),
			note: `catch/error 分支的用户可见文案仅描述失败、无行动指引："${literal.text}"（文案质量需模型复核）`,
			verified_by: "model"
		});
	}
}
/** 字面量是否是用户可见调用的实参（alert/toast/message/…）。 */
function isUserFacingCallArg(node) {
	const call = node.parent;
	if (!ts.isCallExpression(call)) return false;
	const callee = call.expression;
	if (ts.isIdentifier(callee)) return /alert|toast|notify|message|error|warn/iu.test(callee.text);
	if (ts.isPropertyAccessExpression(callee)) return /alert|toast|notify|message|error|warn/iu.test(callee.name.text);
	return false;
}
/** 一个函数结束时，收敛 R-05 / R-06 的候选。 */
function finalizeFrame(ctx, frame) {
	const frameText = frame.node.getText(ctx.sourceFile);
	if (frame.loadingSite !== void 0 && frame.hasMapRender) {
		if (!EMPTY_PATTERN.test(frameText)) addCandidate(ctx, {
			rule: "R-05",
			symbol: frame.symbol,
			line: lineOf(frame.loadingSite.node, ctx.sourceFile),
			snippet: frame.loadingSite.snippet,
			note: "列表存在加载分支，但未发现空数组/空态分支（loading 有、empty 无）",
			verified_by: "model+ast"
		});
	}
	if (frame.mapSite !== void 0 && !LIST_CONTROL_PATTERN.test(frameText)) addCandidate(ctx, {
		rule: "R-11",
		symbol: frame.symbol,
		line: lineOf(frame.mapSite.node, ctx.sourceFile),
		snippet: frame.mapSite.snippet,
		note: "列表直接渲染，当前组件内未发现分页、虚拟滚动、折叠或显式数量限制；需结合真实数据规模判断影响",
		verified_by: "model+ast"
	});
	if (frame.actionSites.length >= 8) {
		const site = frame.actionSites[0];
		if (site !== void 0) addCandidate(ctx, {
			rule: "R-10",
			symbol: frame.symbol,
			line: lineOf(site.node, ctx.sourceFile),
			snippet: site.snippet,
			note: `同一组件静态包含 ${frame.actionSites.length} 个可操作元素，可能造成首屏功能堆叠；必须用真实页面截图确认`,
			verified_by: "model+ast"
		});
	}
	if (frame.actionSites.length >= 2 && frame.headingCount === 0) {
		const site = frame.actionSites[0];
		if (site !== void 0) addCandidate(ctx, {
			rule: "R-13",
			symbol: frame.symbol,
			line: lineOf(site.node, ctx.sourceFile),
			snippet: site.snippet,
			note: "组件包含多个操作入口，但源码中未发现 h1/h2 或等价页面标题；是否难以理解页面用途必须结合首屏截图确认",
			verified_by: "model+ast"
		});
	}
	if (frame.asyncSites.length > 0 && !/loading|pending|progress|processing|submitting|isBusy|isLoading|进度|处理中|加载中/iu.test(frameText)) {
		const site = frame.asyncSites[0];
		if (site !== void 0) addCandidate(ctx, {
			rule: "R-17",
			symbol: frame.symbol,
			line: lineOf(site.node, ctx.sourceFile),
			snippet: site.snippet,
			note: "异步流程未发现 loading/pending/progress/processing 等用户可见进度状态；需核实该操作是否存在可感知等待",
			verified_by: "model+ast"
		});
	}
	const requiredFields = frame.formFields.filter((field) => field.required);
	if (frame.formFields.length >= 8 || requiredFields.length >= 5) {
		const field = frame.formFields[0];
		if (field !== void 0) addCandidate(ctx, {
			rule: "R-18",
			symbol: frame.symbol,
			line: lineOf(field.node, ctx.sourceFile),
			snippet: field.snippet,
			note: `同一组件包含 ${frame.formFields.length} 个表单字段，其中 ${requiredFields.length} 个标记为必填；是否过度索取需结合任务目标和页面确认`,
			verified_by: "model+ast"
		});
	}
	if (frame.choiceSites.length >= 10 && !/defaultValue|defaultChecked|selected|recommend|suggest|search|filter|推荐|默认/iu.test(frameText)) {
		const choice = frame.choiceSites[0];
		if (choice !== void 0) addCandidate(ctx, {
			rule: "R-22",
			symbol: frame.symbol,
			line: lineOf(choice.node, ctx.sourceFile),
			snippet: choice.snippet,
			note: `同一组件静态包含 ${frame.choiceSites.length} 个同级选项，未发现默认值、推荐项、搜索或分组信号；必须结合页面截图判断认知负担`,
			verified_by: "model+ast"
		});
	}
	for (const site of frame.awaitSites.slice(0, 2)) addCandidate(ctx, {
		rule: "R-06",
		symbol: frame.symbol,
		line: lineOf(site.node, ctx.sourceFile),
		snippet: site.snippet,
		note: "异步调用无 catch / 无 try-catch 包裹，失败后用户看不到任何提示",
		verified_by: "model+ast"
	});
	if (frame.catchClauses.length > 0 && !frame.catchFeedback && frame.awaitSites.length > 0) addCandidate(ctx, {
		rule: "R-06",
		symbol: frame.symbol,
		line: lineOf(frame.catchClauses[0], ctx.sourceFile),
		snippet: snippetOf$1(frame.catchClauses[0], ctx.sourceFile),
		note: "异步调用有 catch，但 catch 内未发现用户可见反馈（无渲染/提示/状态更新）",
		verified_by: "model+ast"
	});
}
/** await 是否被 try-catch 或同链 .catch 覆盖。 */
function awaitCovered(node) {
	let current = node.parent;
	while (current !== void 0 && !ts.isStatement(current)) {
		if (ts.isTryStatement(current) && current.catchClause !== void 0) return true;
		if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === "catch") return true;
		current = current.parent;
	}
	return false;
}
/** catch 体内是否存在用户可见反馈（状态 setter / 提示调用 / JSX 渲染）。 */
function catchHasFeedback(clause) {
	let feedback = false;
	const visit = (node) => {
		if (feedback) return;
		if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
			feedback = true;
			return;
		}
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (ts.isIdentifier(callee) && /^set[A-Z]|alert|toast|notify|message|show|open/iu.test(callee.text)) {
				feedback = true;
				return;
			}
			if (ts.isPropertyAccessExpression(callee) && /alert|toast|notify|message|confirm/iu.test(callee.name.text)) {
				feedback = true;
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(clause);
	return feedback;
}
function functionSymbol(node) {
	if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "anonymous";
	if (ts.isMethodDeclaration(node)) return ts.isIdentifier(node.name) ? node.name.text : "anonymous";
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
	if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
	return "anonymous";
}
function walk(node, ctx) {
	if (ctx.candidates.length >= ctx.options.maxPerFile) return;
	const frame = ctx.frames.at(-1);
	if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
		const inner = {
			symbol: functionSymbol(node),
			node,
			awaitSites: [],
			asyncSites: [],
			catchClauses: [],
			catchFeedback: false,
			loadingSite: void 0,
			hasMapRender: false,
			mapSite: void 0,
			actionSites: [],
			headingCount: 0,
			formFields: [],
			choiceSites: [],
			destructiveSites: []
		};
		ctx.frames.push(inner);
		ts.forEachChild(node, (child) => walk(child, ctx));
		ctx.frames.pop();
		finalizeFrame(ctx, inner);
		return;
	}
	if (frame !== void 0) {
		if (ts.isAwaitExpression(node)) {
			const chainRoot = outermostChain(node);
			frame.asyncSites.push({
				node,
				snippet: snippetOf$1(chainRoot, ctx.sourceFile)
			});
			if (!awaitCovered(chainRoot)) frame.awaitSites.push({
				node,
				snippet: snippetOf$1(chainRoot, ctx.sourceFile)
			});
		}
		if (ts.isCatchClause(node)) {
			frame.catchClauses.push(node);
			if (catchHasFeedback(node)) frame.catchFeedback = true;
			collectErrorCopy(ctx, node);
		}
	}
	if (frame !== void 0) {
		if (ts.isConditionalExpression(node) && insideJsx(node)) {
			const conditionText = node.condition.getText(ctx.sourceFile);
			if (LOADING_PATTERN.test(conditionText) && frame.loadingSite === void 0) frame.loadingSite = {
				node,
				snippet: snippetOf$1(node, ctx.sourceFile)
			};
		}
		if (ts.isCallExpression(node) && insideJsx(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") {
			frame.hasMapRender = true;
			frame.mapSite ??= {
				node,
				snippet: snippetOf$1(node, ctx.sourceFile)
			};
		}
	}
	if (frame !== void 0 && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) {
		const tag = jsxTagName(node);
		const name = ts.isIdentifier(tag) ? tag.text : tag.getText(ctx.sourceFile);
		if (/^(?:button|a|input|select|textarea)$/iu.test(name) || /Button|Link|Select|Input|MenuItem/iu.test(name)) frame.actionSites.push({
			node,
			snippet: snippetOf$1(node, ctx.sourceFile)
		});
		if (/^h[1-2]$/iu.test(name) || /PageTitle|Heading|Header/iu.test(name)) frame.headingCount += 1;
		if (/^(?:input|select|textarea)$/iu.test(name) || /Input|Select|Textarea|Field/iu.test(name)) {
			const required = jsxAttributes(node).properties.some((attr) => ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && (attr.name.text === "required" || attr.name.text === "rules"));
			frame.formFields.push({
				node,
				snippet: snippetOf$1(node, ctx.sourceFile),
				required
			});
		}
		if (/^option$/iu.test(name) || /Option|Choice|Radio/iu.test(name)) frame.choiceSites.push({
			node,
			snippet: snippetOf$1(node, ctx.sourceFile)
		});
	}
	if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "className" && node.initializer !== void 0 && ts.isStringLiteral(node.initializer)) {
		const value = node.initializer.text;
		const colorClasses = value.split(/\s+/u).filter((cls) => COLOR_CLASS.test(cls));
		if (colorClasses.length > 0 && !/dark:/u.test(value)) addCandidate(ctx, {
			rule: "R-09",
			symbol: enclosingSymbol(ctx),
			line: lineOf(node, ctx.sourceFile),
			snippet: snippetOf$1(node, ctx.sourceFile),
			note: `className 写死颜色类但无 dark: 变体：${colorClasses.join(", ")}`,
			verified_by: "ast"
		});
	}
	if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "style" && node.initializer !== void 0 && ts.isJsxExpression(node.initializer)) {
		const styleExpr = node.initializer.expression;
		if (styleExpr !== void 0 && ts.isObjectLiteralExpression(styleExpr)) for (const property of styleExpr.properties) {
			if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) continue;
			if (COLOR_LITERAL.test(property.initializer.text)) addCandidate(ctx, {
				rule: "R-09",
				symbol: enclosingSymbol(ctx),
				line: lineOf(property, ctx.sourceFile),
				snippet: snippetOf$1(property, ctx.sourceFile),
				note: `style 内联硬编码颜色字面量：${property.initializer.text}（未走主题变量）`,
				verified_by: "ast"
			});
		}
	}
	if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && isButtonLike(node)) {
		const attributes = jsxAttributes(node);
		const onClick = attributes.properties.find((attr) => ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === "onClick");
		const hasDisabled = attributes.properties.some((attr) => ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && (attr.name.text === "disabled" || attr.name.text === "loading"));
		if (onClick !== void 0 && onClick.initializer !== void 0 && ts.isJsxExpression(onClick.initializer)) {
			const handler = onClick.initializer.expression;
			if (handler !== void 0 && handlerLooksAsync$1(handler) && !hasDisabled) addCandidate(ctx, {
				rule: "R-07",
				symbol: enclosingSymbol(ctx),
				line: lineOf(node, ctx.sourceFile),
				snippet: snippetOf$1(node, ctx.sourceFile),
				note: "异步提交按钮未见 pending 态绑定（无 disabled/loading），可重复触发",
				verified_by: "model+ast"
			});
		}
	}
	if (frame !== void 0 && ts.isCallExpression(node)) {
		const callee = node.expression;
		const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : void 0;
		if (calleeName !== void 0 && DESTRUCTIVE_CALL.test(calleeName)) frame.destructiveSites.push({
			node,
			snippet: snippetOf$1(node, ctx.sourceFile)
		});
		if (calleeName !== void 0 && /confirm$/iu.test(calleeName)) {
			const first = node.arguments[0];
			if (first !== void 0 && ts.isStringLiteral(first) && GENERIC_CONFIRM.test(first.text.trim())) addCandidate(ctx, {
				rule: "R-03",
				symbol: enclosingSymbol(ctx),
				line: lineOf(node, ctx.sourceFile),
				snippet: snippetOf$1(node, ctx.sourceFile),
				note: `不可逆操作确认文案泛化："${first.text}"（无对象与后果信息；是否真的不可逆由模型复核）`,
				verified_by: "model"
			});
		}
	}
	if (frame !== void 0 && ts.isPropertyAccessExpression(node) && insideJsx(node)) {
		const text = node.getText(ctx.sourceFile);
		if (/^item\.\w+|^data\.\w+|^row\.\w+|^record\.\w+/u.test(text) && !TRUNCATION_PATTERN.test(ctx.sourceFile.text)) addCandidate(ctx, {
			rule: "R-08",
			symbol: frame.symbol,
			line: lineOf(node, ctx.sourceFile),
			snippet: snippetOf$1(node.parent, ctx.sourceFile),
			note: "直接渲染输入/外部字段，未发现截断或占位处理（truncate/ellipsis/line-clamp）",
			verified_by: "model+ast"
		});
	}
	if (ctx.termCount < 12 && (ts.isJsxText(node) || isLabelLikeAttribute(node) || isJsxTextChild(node))) {
		const raw = jsxRawText(node);
		if (raw !== void 0 && EMOJI_PATTERN.test(raw)) addCandidate(ctx, {
			rule: "R-12",
			symbol: enclosingSymbol(ctx),
			line: lineOf(node, ctx.sourceFile),
			snippet: raw,
			note: "用户可见内容使用 Emoji；是否与产品定位、图标体系和视觉语言一致需结合真实截图判断",
			verified_by: "model+ast"
		});
		const text = jsxVisibleText(node);
		if (text !== void 0) {
			const key = text;
			if (!ctx.termSeen.has(key)) {
				ctx.termSeen.add(key);
				ctx.termCount += 1;
				addCandidate(ctx, {
					rule: "R-02",
					symbol: enclosingSymbol(ctx),
					line: lineOf(node, ctx.sourceFile),
					snippet: text,
					note: "术语候选：是否与其他位置用词同义，由模型判定（条件触发规则，仅无一级 / 二级问题时执行）",
					verified_by: "model"
				});
			}
		}
	}
	ts.forEachChild(node, (child) => walk(child, ctx));
}
function outermostChain(node) {
	let current = node;
	while (current.parent !== void 0 && !ts.isStatement(current.parent) && !ts.isExpressionStatement(current.parent)) current = current.parent;
	return current;
}
function isButtonLike(node) {
	const name = jsxTagName(node);
	if (ts.isIdentifier(name)) return name.text === "button" || /Button|Btn/iu.test(name.text);
	return false;
}
/** JsxElement / JsxSelfClosingElement 的 attributes（两种节点形态字段不同）。 */
function jsxAttributes(node) {
	return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}
/** JsxElement / JsxSelfClosingElement 的 tag 名。 */
function jsxTagName(node) {
	return ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
}
function handlerLooksAsync$1(expression) {
	if (ts.isArrowFunction(expression)) {
		if ((expression.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return true;
		let hasAwait = false;
		const visit = (node) => {
			if (hasAwait) return;
			if (ts.isAwaitExpression(node)) hasAwait = true;
			ts.forEachChild(node, visit);
		};
		visit(expression.body);
		return hasAwait;
	}
	if (ts.isIdentifier(expression)) return SUBMIT_HANDLER.test(expression.text);
	return false;
}
/** JSX 文本或类 label 属性中的可见文本（术语候选素材）。 */
function jsxRawText(node) {
	let raw = "";
	if (ts.isJsxText(node)) raw = node.text.trim();
	else if (ts.isStringLiteral(node)) raw = node.text.trim();
	else if (ts.isJsxExpression(node)) {
		const expression = node.expression;
		if (expression === void 0 || !ts.isStringLiteral(expression)) return void 0;
		raw = expression.text.trim();
	} else return;
	return raw;
}
function jsxVisibleText(node) {
	const raw = jsxRawText(node);
	if (raw === void 0) return void 0;
	if (raw.length < 2 || raw.length > 30) return void 0;
	if (/^(https?:)?\/\//u.test(raw)) return void 0;
	if (/[{}<>;=()[\]]/u.test(raw)) return void 0;
	if (!/[\p{Script=Han}A-Za-z]/u.test(raw)) return void 0;
	if (/^\d+%?$/u.test(raw)) return void 0;
	return raw;
}
function isLabelLikeAttribute(node) {
	if (!ts.isJsxAttribute(node) || node.initializer === void 0) return false;
	if (!ts.isIdentifier(node.name) || !LABEL_ATTRS.has(node.name.text)) return false;
	return ts.isStringLiteral(node.initializer);
}
function isJsxTextChild(node) {
	if (!ts.isJsxExpression(node)) return false;
	const expression = node.expression;
	return expression !== void 0 && ts.isStringLiteral(expression);
}
/**
* 从单个文件提取候选证据。
* @param file - 相对项目根路径（写入候选的 locator）。
* @param source - 文件文本。
* @param options - 候选数量上限配置。
* @param scriptKind - 解析方式：React 源码一律 TSX（.js 也可能含 JSX）；
*   Vue `<script>` 块用 TS（无 JSX，lang=jsx/tsx 除外）。
*/
function extractCandidates(file, source, options, scriptKind = ts.ScriptKind.TSX) {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
	const ctx = {
		sourceFile,
		file,
		options,
		candidates: [],
		perRule: /* @__PURE__ */ new Map(),
		frames: [],
		termSeen: /* @__PURE__ */ new Set(),
		termCount: 0
	};
	walk(sourceFile, ctx);
	return finalizeDestructive(sourceFile, ctx);
}
/** R-04 收敛：破坏性调用站点，其调用路径（向内两层函数）无确认交互 → 候选。 */
function finalizeDestructive(sourceFile, ctx) {
	const sites = [];
	const frames = [];
	const visit = (node) => {
		if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
			frames.push({
				symbol: functionSymbol(node),
				node
			});
			ts.forEachChild(node, visit);
			frames.pop();
			return;
		}
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : void 0;
			if (calleeName !== void 0 && DESTRUCTIVE_CALL.test(calleeName)) sites.push({
				node,
				frames: frames.map((frame) => frame.node)
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	for (const site of sites.slice(0, 3)) {
		if (site.frames.slice(-2).some((frame) => CONFIRM_PATTERN.test(frame.getText(sourceFile)))) continue;
		addCandidate(ctx, {
			rule: "R-04",
			symbol: void 0,
			line: lineOf(site.node, sourceFile),
			snippet: snippetOf$1(site.node, sourceFile),
			note: "破坏性操作调用，其调用路径（两层包围函数内）未发现确认交互（confirm/Modal/Dialog/Popconfirm）",
			verified_by: "model+ast"
		});
	}
	return ctx.candidates;
}
//#endregion
//#region src/vue.ts
/**
* Vue 3 SFC 走查引擎（v0.2 技术栈扩展）：
*
* 与 React 引擎（ast.ts）同一分工——模型判断为主、AST 求证为辅。一个 .vue
* 文件被拆成两部分分别求证：
*
* - `<script>` / `<script setup>` 块：直接复用 TypeScript 编译器 API 引擎
*   （R-01 错误分支文案、R-03 泛化确认调用、R-04 破坏性调用路径、R-06 异步
*   无 catch）。块内行号被平移到整个 .vue 文件的行号（locator 精度）。
* - `<template>` 块：用 `@vue/compiler-dom` 的 `baseParse` 得到真实模板 AST
*   （ElementNode / DirectiveNode / InterpolationNode…），按规则目录在
*   结构节点上提取候选——v-if/v-for/@click/:class/:style 都是结构化节点，
*   不会把注释、字符串常量误判进来（对齐 spec 附录 A.1 的"为什么不用正则"）。
*
* 模板级判定是文件粒度（等价 React 引擎的函数粒度），比 React 引擎更粗：
* 候选 note 中明确要求模型核实"信号与结论是否属于同一列表/同一操作"。
*/
/** 模板中的确认交互元素（ant-design-vue / element-plus 等组件库惯例）。 */
const CONFIRM_TAG = /modal|dialog|popconfirm|confirm/iu;
/** 模板事件处理器表达式中的破坏性调用（近似 DESTRUCTIVE_CALL 的源码级等价）。 */
const DESTRUCTIVE_HANDLER = /(?:^|[^\w$])(?:handle)?(?:delete|remove|clear|reset|drop|destroy|wipe)\w*\s*\(/iu;
/** 错误分支条件信号（v-if / v-show 的表达式）。 */
const ERROR_CONDITION = /error|fail|失败|错误/iu;
/** R-08 关注的外部字段前缀（与 React 引擎一致：item/row/record/data）。 */
const EXTERNAL_FIELD = /^(?:item|row|record|data)\.[A-Za-z_$][\w$]*$/u;
/** 一个 .vue 文件中 script 与 template 各自的候选预算（合并 ≤ 2×maxPerFile）。 */
const SFC_BUDGET_FACTOR = 2;
function addVueCandidate(ctx, candidate) {
	if (ctx.used >= ctx.budget) return;
	const count = ctx.perRule.get(candidate.rule) ?? 0;
	if (count >= ctx.options.maxPerRule) return;
	ctx.perRule.set(candidate.rule, count + 1);
	ctx.used += 1;
	ctx.candidates.push({
		...candidate,
		file: ctx.file,
		symbol: ctx.symbol
	});
}
/** 节点源码片段（折叠空白，截断到 160 字符）。 */
function snippetOf(node, max = 160) {
	const text = node.loc.source.replace(/\s+/gu, " ").trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** 计算块内容在源文件中的首行偏移（0 起：内容第 1 行 = 文件第 offset+1 行）。 */
function contentLineOffset(source, block) {
	const content = block.content;
	if (content.length === 0) return block.loc.start.line - 1;
	const at = source.indexOf(content, block.loc.start.offset);
	return source.slice(0, at).split("\n").length - 1;
}
/** 术语候选可见文本过滤（与 React 引擎 jsxVisibleText 同口径）。 */
function visibleText(raw) {
	const text = raw.replace(/\s+/gu, " ").trim();
	if (text.length < 2 || text.length > 30) return void 0;
	if (/^(https?:)?\/\//u.test(text)) return void 0;
	if (/[{}<>;=()[\]]/u.test(text)) return void 0;
	if (!/[\p{Script=Han}A-Za-z]/u.test(text)) return void 0;
	if (/^\d+%?$/u.test(text)) return void 0;
	return text;
}
/** 指令的静态参数名（如 :class 的 arg="class"；动态参数返回 undefined）。 */
function directiveArgName(directive) {
	const arg = directive.arg;
	if (arg === void 0) return void 0;
	return arg.type === NodeTypes.SIMPLE_EXPRESSION ? arg.content : void 0;
}
/** 收集元素子树的用户可见文本（静态文本 + 字符串字面量插值）。 */
function collectVisibleText(children, out) {
	for (const child of children) if (child.type === NodeTypes.TEXT) {
		const text = child.content.replace(/\s+/gu, " ").trim();
		if (text.length > 0) out.push(text);
	} else if (child.type === NodeTypes.INTERPOLATION) {
		const expression = child.content;
		if (expression.type === NodeTypes.SIMPLE_EXPRESSION) {
			const simple = expression;
			if (simple.isStatic) {
				const text = simple.content.replace(/^['"]|['"]$/gu, "").trim();
				if (text.length > 0) out.push(text);
			}
		}
	} else if (child.type === NodeTypes.COMPOUND_EXPRESSION) {
		const parts = [];
		for (const part of child.children) {
			if (typeof part === "string" || typeof part === "symbol") continue;
			if (part.type === NodeTypes.TEXT || part.type === NodeTypes.INTERPOLATION || part.type === NodeTypes.COMPOUND_EXPRESSION) parts.push(part);
		}
		collectVisibleText(parts, out);
	}
}
/** 遍历模板 AST：结构信号收集 + 逐节点候选求证。 */
function walkTemplate(root, ctx, state) {
	const walkChildren = (children, parentEl, grandEl) => {
		let confirmInSubtree = false;
		for (const child of children) {
			if (ctx.used >= ctx.budget) return confirmInSubtree;
			switch (child.type) {
				case NodeTypes.ELEMENT:
					if (walkElement(child, parentEl, grandEl)) confirmInSubtree = true;
					break;
				case NodeTypes.TEXT: {
					const textNode = child;
					recordVisualText(ctx, textNode.content, textNode.loc.start.line);
					recordTerm(ctx, textNode.content, textNode.loc.start.line);
					break;
				}
				case NodeTypes.INTERPOLATION:
					handleInterpolation(ctx, state, child);
					break;
				case NodeTypes.COMPOUND_EXPRESSION:
					for (const part of child.children) {
						if (typeof part === "string" || typeof part === "symbol") continue;
						if (part.type === NodeTypes.TEXT) recordTerm(ctx, part.content, part.loc.start.line);
						else if (part.type === NodeTypes.INTERPOLATION) handleInterpolation(ctx, state, part);
					}
					break;
				case NodeTypes.IF:
					for (const branch of child.branches) walkChildren(branch.children, parentEl, grandEl);
					break;
				case NodeTypes.FOR: walkChildren(child.children, parentEl, grandEl);
			}
		}
		return confirmInSubtree;
	};
	const walkElement = (el, parentEl, grandEl) => {
		if (/^(?:button|a|input|select|textarea)$/iu.test(el.tag) || /Button|Link|Select|Input|MenuItem/iu.test(el.tag)) {
			state.actionCount += 1;
			state.firstAction ??= {
				line: el.loc.start.line,
				snippet: snippetOf(el)
			};
		}
		if (/^h[1-2]$/iu.test(el.tag) || /PageTitle|Heading|Header/iu.test(el.tag)) state.headingCount += 1;
		const isConfirmEl = CONFIRM_TAG.test(el.tag);
		const confirmInSubtree = walkChildren(el.children, el, parentEl);
		const inConfirmContext = isConfirmEl || confirmInSubtree || parentEl !== null && CONFIRM_TAG.test(parentEl.tag) || grandEl !== null && CONFIRM_TAG.test(grandEl.tag);
		const buttonLike = el.tag === "button" || /Button|Btn/iu.test(el.tag);
		const formField = /^(?:input|select|textarea)$/iu.test(el.tag) || /Input|Select|Textarea|Field/iu.test(el.tag);
		const choiceLike = /^option$/iu.test(el.tag) || /Option|Choice|Radio/iu.test(el.tag);
		let onClickExp;
		let covered = false;
		let fieldRequired = false;
		const attrs = /* @__PURE__ */ new Map();
		for (const prop of el.props) if (prop.type === NodeTypes.ATTRIBUTE) {
			const attr = prop;
			if (attr.value !== void 0) {
				attrs.set(attr.name, attr.value.content);
				if (LABEL_ATTRS.has(attr.name)) recordVisualText(ctx, attr.value.content, prop.loc.start.line);
			}
			if (attr.name === "disabled") covered = true;
			if (attr.name === "required" || attr.name === "rules") fieldRequired = true;
			if (attr.name === "class" && attr.value !== void 0) {
				const value = attr.value.content;
				const colorClasses = value.split(/\s+/u).filter((cls) => COLOR_CLASS.test(cls));
				if (colorClasses.length > 0 && !/dark:/u.test(value)) addVueCandidate(ctx, {
					rule: "R-09",
					line: prop.loc.start.line,
					snippet: snippetOf(prop),
					note: `class 写死颜色类但无 dark: 变体：${colorClasses.join(", ")}`,
					verified_by: "ast"
				});
			}
			if (attr.name === "style" && attr.value !== void 0 && COLOR_LITERAL_SEARCH.test(attr.value.content)) addVueCandidate(ctx, {
				rule: "R-09",
				line: prop.loc.start.line,
				snippet: snippetOf(prop),
				note: `style 内联硬编码颜色字面量：${attr.value.content.match(COLOR_LITERAL_SEARCH)?.[0] ?? ""}（未走主题变量）`,
				verified_by: "ast"
			});
			if (LABEL_ATTRS.has(attr.name) && attr.value !== void 0) recordTerm(ctx, attr.value.content, prop.loc.start.line);
		} else if (prop.type === NodeTypes.DIRECTIVE) {
			const directive = prop;
			const argName = directiveArgName(directive);
			const expSource = directive.exp?.loc.source ?? "";
			if (directive.name === "bind") {
				if (argName === "class") {
					const colorClasses = (expSource.match(/[A-Za-z][\w-]*/gu) ?? []).filter((cls) => COLOR_CLASS.test(cls));
					if (colorClasses.length > 0 && !/dark:/u.test(expSource)) addVueCandidate(ctx, {
						rule: "R-09",
						line: prop.loc.start.line,
						snippet: snippetOf(prop),
						note: `:class 绑定写死颜色类但无 dark: 变体：${colorClasses.join(", ")}`,
						verified_by: "ast"
					});
				}
				if (argName === "style" && COLOR_LITERAL_SEARCH.test(expSource)) addVueCandidate(ctx, {
					rule: "R-09",
					line: prop.loc.start.line,
					snippet: snippetOf(prop),
					note: `:style 绑定硬编码颜色字面量：${expSource.match(COLOR_LITERAL_SEARCH)?.[0] ?? ""}（未走主题变量）`,
					verified_by: "ast"
				});
				if (argName === "disabled" || argName === "loading") covered = true;
				if (argName === "required" || argName === "rules") fieldRequired = true;
			}
			if (directive.name === "if" && LOADING_PATTERN.test(expSource) && state.loadingSite === void 0) state.loadingSite = {
				line: prop.loc.start.line,
				snippet: snippetOf(el)
			};
			if (directive.name === "for") {
				state.hasFor = true;
				state.forSite ??= {
					line: prop.loc.start.line,
					snippet: snippetOf(el)
				};
			}
			if (directive.name === "if" && ERROR_CONDITION.test(expSource)) {
				const texts = [];
				collectVisibleText(el.children, texts);
				if (texts.length > 0 && texts.every((text) => !ACTION_WORD.test(text))) addVueCandidate(ctx, {
					rule: "R-01",
					line: el.loc.start.line,
					snippet: snippetOf(el),
					note: `v-if 错误分支的用户可见文案仅描述失败、无行动指引："${texts[0] ?? ""}"（文案质量需模型复核）`,
					verified_by: "model"
				});
			}
			if (directive.name === "on" && argName !== void 0) {
				if (argName === "click" || argName === "submit" || argName === "dblclick") {
					onClickExp = directive.exp ?? onClickExp;
					if (!inConfirmContext && DESTRUCTIVE_HANDLER.test(expSource)) addVueCandidate(ctx, {
						rule: "R-04",
						line: prop.loc.start.line,
						snippet: snippetOf(prop),
						note: "模板事件处理器直接调用破坏性操作，该元素及其两级祖先/子树内未发现确认交互（Modal/Dialog/Popconfirm）；信号与结论是否同属一条操作路径由模型复核",
						verified_by: "model+ast"
					});
				}
			}
		}
		if (formField) {
			state.formFieldCount += 1;
			if (fieldRequired) state.requiredFieldCount += 1;
			state.firstField ??= {
				line: el.loc.start.line,
				snippet: snippetOf(el)
			};
		}
		if (choiceLike) {
			state.choiceCount += 1;
			state.firstChoice ??= {
				line: el.loc.start.line,
				snippet: snippetOf(el)
			};
		}
		if (buttonLike && onClickExp !== void 0 && handlerLooksAsync(onClickExp) && !covered) addVueCandidate(ctx, {
			rule: "R-07",
			line: el.loc.start.line,
			snippet: snippetOf(el),
			note: "异步提交按钮未见 pending 态绑定（无 disabled/:disabled/:loading），可重复触发",
			verified_by: "model+ast"
		});
		if (/popconfirm/iu.test(el.tag)) {
			const genericTexts = [
				"title",
				"ok-text",
				"okText",
				"confirm-text"
			].map((name) => attrs.get(name)).filter((value) => value !== void 0 && GENERIC_CONFIRM.test(value));
			if (genericTexts.length > 0) addVueCandidate(ctx, {
				rule: "R-03",
				line: el.loc.start.line,
				snippet: snippetOf(el),
				note: `不可逆操作确认文案泛化："${genericTexts[0] ?? ""}"（无对象与后果信息；是否真的不可逆由模型复核）`,
				verified_by: "model"
			});
		}
		return isConfirmEl || confirmInSubtree;
	};
	walkChildren(root.children, null, null);
	if (state.forSite !== void 0 && !LIST_CONTROL_PATTERN.test(state.templateText)) addVueCandidate(ctx, {
		rule: "R-11",
		line: state.forSite.line,
		snippet: state.forSite.snippet,
		note: "v-for 列表未发现分页、虚拟滚动、折叠或显式数量限制；需结合真实数据规模判断影响",
		verified_by: "model+ast"
	});
	if (state.actionCount >= 8 && state.firstAction !== void 0) addVueCandidate(ctx, {
		rule: "R-10",
		line: state.firstAction.line,
		snippet: state.firstAction.snippet,
		note: `同一模板静态包含 ${state.actionCount} 个可操作元素，可能造成首屏功能堆叠；必须用真实页面截图确认`,
		verified_by: "model+ast"
	});
	if (state.actionCount >= 2 && state.headingCount === 0 && state.firstAction !== void 0) addVueCandidate(ctx, {
		rule: "R-13",
		line: state.firstAction.line,
		snippet: state.firstAction.snippet,
		note: "模板包含多个操作入口，但未发现 h1/h2 或等价页面标题；是否难以理解页面用途必须结合首屏截图确认",
		verified_by: "model+ast"
	});
	if ((state.formFieldCount >= 8 || state.requiredFieldCount >= 5) && state.firstField !== void 0) addVueCandidate(ctx, {
		rule: "R-18",
		line: state.firstField.line,
		snippet: state.firstField.snippet,
		note: `同一模板包含 ${state.formFieldCount} 个表单字段，其中 ${state.requiredFieldCount} 个标记为必填；是否过度索取需结合任务目标和页面确认`,
		verified_by: "model+ast"
	});
	if (state.choiceCount >= 10 && state.firstChoice !== void 0 && !/default|selected|recommend|suggest|search|filter|推荐|默认/iu.test(state.templateText)) addVueCandidate(ctx, {
		rule: "R-22",
		line: state.firstChoice.line,
		snippet: state.firstChoice.snippet,
		note: `同一模板包含 ${state.choiceCount} 个同级选项，未发现默认值、推荐项、搜索或分组信号；必须结合页面截图判断认知负担`,
		verified_by: "model+ast"
	});
}
function recordVisualText(ctx, raw, line) {
	const text = raw.replace(/\s+/gu, " ").trim();
	if (!EMOJI_PATTERN.test(text)) return;
	addVueCandidate(ctx, {
		rule: "R-12",
		line,
		snippet: text,
		note: "用户可见内容使用 Emoji；是否与产品定位、图标体系和视觉语言一致需结合真实截图判断",
		verified_by: "model+ast"
	});
}
/** R-02 术语候选（去重、每文件 ≤12 条，与 React 引擎同口径）。 */
function recordTerm(ctx, raw, line) {
	if (ctx.termCount >= 12) return;
	const text = visibleText(raw);
	if (text === void 0 || ctx.termSeen.has(text)) return;
	ctx.termSeen.add(text);
	ctx.termCount += 1;
	addVueCandidate(ctx, {
		rule: "R-02",
		line,
		snippet: text,
		note: "术语候选：是否与其他位置用词同义，由模型判定（条件触发规则，仅无一级 / 二级问题时执行）",
		verified_by: "model"
	});
}
/** R-08：插值直接渲染外部字段；R-02：字符串字面量插值作为术语候选。 */
function handleInterpolation(ctx, state, node) {
	const expression = node.content;
	if (expression.type !== NodeTypes.SIMPLE_EXPRESSION) return;
	const simple = expression;
	const text = simple.content.trim();
	if (simple.isStatic) {
		recordTerm(ctx, simple.content.replace(/^['"]|['"]$/gu, ""), node.loc.start.line);
		return;
	}
	if (!EXTERNAL_FIELD.test(text)) return;
	if (TRUNCATION_PATTERN.test(state.templateText) || TRUNCATION_PATTERN.test(state.styleText)) return;
	addVueCandidate(ctx, {
		rule: "R-08",
		line: node.loc.start.line,
		snippet: snippetOf(node),
		note: "插值直接渲染输入/外部字段，未发现截断或占位处理（truncate/ellipsis/line-clamp）",
		verified_by: "model+ast"
	});
}
/** 模板事件处理器是否异步（含 await 或提交类处理器名）。 */
function handlerLooksAsync(exp) {
	if (exp === void 0) return false;
	const text = exp.loc.source;
	if (/await/u.test(text)) return true;
	const callee = /^\s*([A-Za-z_$][\w$]*)/u.exec(text)?.[1];
	return callee !== void 0 && SUBMIT_HANDLER.test(callee);
}
/** 递归合并两条候选列表（脚本部分可能分多个 block 调用引擎）。 */
function pushCapped(target, perRule, options, budget, candidates) {
	let added = 0;
	for (const candidate of candidates) {
		if (added >= budget) break;
		const count = perRule.get(candidate.rule) ?? 0;
		if (count >= options.maxPerRule) continue;
		perRule.set(candidate.rule, count + 1);
		target.push(candidate);
		added += 1;
	}
	return added;
}
/**
* 从单个 .vue 文件提取候选证据。
* @param file - 相对项目根路径（写入候选的 locator）。
* @param source - 文件文本。
* @param options - 候选数量上限配置。
*/
function extractVueCandidates(file, source, options) {
	let descriptor;
	try {
		descriptor = parse$1(source, { filename: file }).descriptor;
	} catch {
		return [];
	}
	const candidates = [];
	const perRule = /* @__PURE__ */ new Map();
	const scriptBudget = options.maxPerFile;
	let scriptUsed = 0;
	const scriptBlocks = [descriptor.scriptSetup, descriptor.script].filter((block) => block !== null && block.content.trim().length > 0);
	for (const block of scriptBlocks) {
		if (scriptUsed >= scriptBudget) break;
		const offset = contentLineOffset(source, block);
		const lang = block.lang ?? "";
		const kind = /x/iu.test(lang) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
		const extracted = extractCandidates(file, block.content, options, kind);
		for (const candidate of extracted) if (candidate.line !== void 0) candidate.line += offset;
		scriptUsed += pushCapped(candidates, perRule, options, scriptBudget - scriptUsed, extracted);
	}
	const template = descriptor.template;
	if (template !== null && template.content.trim().length > 0) {
		const offset = contentLineOffset(source, template);
		const symbol = file.split("/").at(-1)?.replace(/\.vue$/u, "") ?? "anonymous";
		let root;
		try {
			root = baseParse(template.content, { onError: () => {} });
		} catch {
			root = void 0;
		}
		if (root !== void 0) {
			const ctx = {
				file,
				symbol,
				options,
				perRule,
				budget: options.maxPerFile,
				used: 0,
				candidates: [],
				termSeen: /* @__PURE__ */ new Set(),
				termCount: 0
			};
			const state = {
				templateText: template.content,
				styleText: descriptor.styles.map((style) => style.content).join("\n"),
				hasFor: false,
				forSite: void 0,
				actionCount: 0,
				firstAction: void 0,
				headingCount: 0,
				formFieldCount: 0,
				requiredFieldCount: 0,
				firstField: void 0,
				choiceCount: 0,
				firstChoice: void 0,
				loadingSite: void 0
			};
			walkTemplate(root, ctx, state);
			for (const candidate of ctx.candidates) if (candidate.line !== void 0) candidate.line += offset;
			candidates.push(...ctx.candidates);
			if (state.loadingSite !== void 0 && state.hasFor && !EMPTY_PATTERN.test(state.templateText)) {
				const count = perRule.get("R-05") ?? 0;
				if (count < options.maxPerRule && candidates.length < options.maxPerFile * SFC_BUDGET_FACTOR) {
					perRule.set("R-05", count + 1);
					candidates.push({
						rule: "R-05",
						file,
						symbol,
						line: state.loadingSite.line + offset,
						snippet: state.loadingSite.snippet,
						note: "模板存在 v-if 加载分支与 v-for 渲染，但未发现空数组/空态分支（loading 有、empty 无；两者是否同属一个列表由模型复核）",
						verified_by: "model+ast"
					});
				}
			}
		}
	}
	return candidates;
}
//#endregion
//#region src/scan-tool.ts
/**
* `ux_scan` 工具（spec §6 R3）：源码走查的第一阶段。
*
* 职责边界（模型判断为主、AST 求证为辅）：
* - 校验技术栈（React + TypeScript / React + JavaScript / Vue 3；不支持时
*   明确告知，不给低质量猜测）；
* - 按给定范围收集源文件（范围建议由 R6 流程在调用前完成）；
* - 按技术栈分派解析引擎（React 源码走 TypeScript 编译器 API；Vue SFC 走
*   @vue/compiler-sfc + compiler-dom，script 块复用 TS 引擎），产出带
*   locator 的结构化候选证据；
* - 返回给模型：文件清单 + 候选 + 既有术语表 + 后续步骤指引。
*
* 工具**不做**语义判断、不直接产出 finding：模型读候选、核实代码、按 persona
* 判定后经 `ux_report` 落定。R-09 候选为 AST 快车道结论（verified_by: ast）。
*/
/** 单文件读取上限（防超大文件拖垮扫描）。 */
const MAX_FILE_BYTES = 524288;
/** 候选总数上限（约束工具返回体量）。 */
const MAX_CANDIDATES_TOTAL = 200;
const RULE_NAME_EN = {
	"R-01": "Error message has no next action",
	"R-02": "Inconsistent terminology",
	"R-03": "Generic copy for irreversible action",
	"R-04": "Irreversible action has no confirmation",
	"R-05": "Loading state has no empty state",
	"R-06": "Success path has no error path",
	"R-07": "Submit remains enabled while pending",
	"R-08": "No fallback for long content",
	"R-09": "Missing dark/light theme adaptation",
	"R-10": "Crowded layout or unclear grouping",
	"R-11": "Long list has no browsing controls",
	"R-12": "Decorative elements conflict with visual language",
	"R-13": "Page purpose or primary action is unclear",
	"R-14": "Critical task contains redundant interaction",
	"R-15": "Navigation does not match user tasks",
	"R-16": "Navigation is too deep or lacks location context",
	"R-17": "Long-running operation has no progress feedback",
	"R-18": "Form requests too many or excessive required fields",
	"R-19": "Form validation feedback arrives too late",
	"R-20": "Form progress is lost when leaving",
	"R-21": "Flow has no exit, cancel, or undo path",
	"R-22": "Too many choices without defaults or recommendations",
	"R-23": "Equivalent actions differ across pages",
	"R-24": "Similar components behave inconsistently",
	"R-25": "First-use, offline, or permission states are missing",
	"R-26": "Basic visual usability is insufficient",
	"R-27": "Response time harms the critical task"
};
const CANDIDATE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		rule: {
			type: "string",
			description: "规则 ID：R-01 … R-27"
		},
		file: {
			type: "string",
			description: "相对项目根的文件路径（locator）"
		},
		symbol: {
			type: "string",
			description: "组件 / 符号级定位"
		},
		line: {
			type: "number",
			description: "行号（可选）"
		},
		snippet: {
			type: "string",
			description: "原文片段（供模型核实）"
		},
		note: {
			type: "string",
			description: "AST 结构断言说明"
		},
		verified_by: {
			type: "string",
			description: "model | model+ast | ast"
		}
	}
};
/** 渲染扫描结果（模型面向文本）。 */
function renderScanResult(result) {
	const zh = isChinese(result.language);
	if (!result.supported) return zh ? [
		`【不支持的技术栈】${result.stack}`,
		result.reason ?? "当前版本支持 React（TypeScript / JavaScript）与 Vue 3。",
		"请明确告知用户不支持，不要给出低质量猜测。"
	].join("\n") : [
		`[Unsupported stack] ${result.stack}`,
		"This version supports React (TypeScript/JavaScript) and Vue 3.",
		"Explain the unsupported stack; do not guess at findings."
	].join("\n");
	const lines = [];
	lines.push(zh ? `技术栈：${result.stack}；收集源码/样式文件 ${result.file_count} 个${result.truncated ? "（已达上限，范围请进一步收敛）" : ""}。` : `Stack: ${result.stack}; collected ${result.file_count} source/style files${result.truncated ? " (limit reached; narrow the scope)" : ""}.`);
	lines.push(`${zh ? "产品类型" : "Product type"}: ${result.product_type}; ${zh ? "本类产品重点" : "review focus"}: ${result.review_focus.join(zh ? "、" : ", ")}`);
	lines.push(`${zh ? "基础框架" : "Base framework"}: Nielsen 10 heuristics`);
	lines.push(`${zh ? "检查顺序" : "Review order"}: ${result.review_priority.join(zh ? "；" : "; ")}`);
	const byRule = /* @__PURE__ */ new Map();
	for (const candidate of result.candidates) {
		const list = byRule.get(candidate.rule) ?? [];
		list.push(candidate);
		byRule.set(candidate.rule, list);
	}
	for (const rule of RULES.map((def) => def.id)) {
		const list = byRule.get(rule);
		if (list === void 0 || list.length === 0) continue;
		const ruleName = zh ? RULES.find((def) => def.id === rule)?.name ?? "" : RULE_NAME_EN[rule] ?? "";
		lines.push(`\n## ${rule} ${ruleName} (${list.length})`);
		for (const candidate of list) {
			const where = `${candidate.file}${candidate.line === void 0 ? "" : `:${candidate.line}`}` + (candidate.symbol === void 0 ? "" : `（${candidate.symbol}）`);
			lines.push(zh ? `- [${candidate.verified_by}] ${where}\n  断言: ${candidate.note}\n  片段: ${candidate.snippet}` : `- [${candidate.verified_by}] ${where}\n  Evidence: inspect this candidate against ${ruleName}\n  Snippet: ${candidate.snippet}`);
		}
	}
	if (result.candidates.length === 0) lines.push(zh ? "\n（本轮源码/CSS 扫描未产生候选证据；模型仍可阅读代码发现语义问题。）" : "\n(No source/CSS candidates were produced; inspect the scoped code for semantic issues.)");
	if (result.surface_hints.length > 0) {
		lines.push(zh ? "\n## 页面位置素材" : "\n## Page-location hints");
		for (const hint of result.surface_hints) {
			const parts = [
				hint.routeTitle === void 0 ? void 0 : `路由标题「${hint.routeTitle}」`,
				hint.heading === void 0 ? void 0 : `页面 h1「${hint.heading}」`,
				hint.navText === void 0 ? void 0 : `导航文案「${hint.navText}」`,
				hint.route === void 0 ? void 0 : `路由 ${hint.route}`,
				hint.symbol === void 0 ? void 0 : `组件 ${hint.symbol}`
			].filter((part) => part !== void 0);
			lines.push(`- ${hint.file}：${parts.join("｜") || "（无素材，请据页面内容拟名）"}`);
		}
	}
	if (result.glossary.length > 0) {
		lines.push(`\n## 既有术语表（.ux/glossary.yml，仅需对新增/变更术语做增量判断）`);
		for (const term of result.glossary) lines.push(`- ${term.canonical}：${term.variants.join(" / ") || "（无变体）"}`);
	}
	lines.push(zh ? "\n## 后续步骤" : "\n## Next steps");
	for (const line of result.guidance) lines.push(`- ${line}`);
	return lines.join("\n");
}
/** 注册 `ux_scan` 工具。 */
function uxScanTool(config) {
	return defineTool({
		name: "ux_scan",
		description: [
			"对 React（TypeScript / JavaScript）与 Vue 3 源码做 UX 走查的结构化扫描（第一阶段：AST 求证候选证据，模型判断为主）。",
			"返回文件清单与带 locator 的候选证据，供你读码核实后按当前 persona 判定。",
			"R-09（深色模式）候选由 AST 直接求证（verified_by=ast）可直接采用；其余候选需核实。",
			"不支持的技术栈（Svelte / Vue 2 / 小程序等）会返回 supported=false，需明确告知用户不支持。",
			"扫描完成后阅读可疑代码、判定候选、补记语义问题，最后调用 ux_report 汇总定稿。"
		].join(" "),
		parameters: {
			paths: {
				type: "array",
				items: { type: "string" },
				description: "相对项目根的文件/目录列表（如 [\"src/pages/Order\"]）；缺省扫描 src。范围应由 R6 流程确认后给出。"
			},
			focus: {
				type: "string",
				description: "本次走查的功能/页面/流程描述（辅助判定）"
			},
			persona_id: {
				type: "string",
				description: "当前走查的 persona id；多 persona 时逐个画像调用本工具独立走查"
			},
			language: {
				type: "string",
				description: "输出语言（zh-CN 或 en）；优先跟随当前用户语言，缺省按插件配置和项目 README 推断。"
			},
			product_type: {
				type: "string",
				enum: [
					"consumer",
					"enterprise",
					"ecommerce",
					"content",
					"finance",
					"healthcare",
					"developer-tool",
					"internal-tool",
					"other"
				],
				description: "根据 README、路由和当前业务流程判断的产品类型。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					supported: { type: "boolean" },
					stack: { type: "string" },
					reason: { type: "string" },
					focus: { type: "string" },
					persona_id: { type: "string" },
					language: { type: "string" },
					product_type: { type: "string" },
					review_focus: {
						type: "array",
						items: { type: "string" }
					},
					heuristics: {
						type: "array",
						items: { type: "string" }
					},
					review_priority: {
						type: "array",
						items: { type: "string" }
					},
					files: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string" },
								size: { type: "number" }
							}
						}
					},
					file_count: { type: "number" },
					truncated: { type: "boolean" },
					candidates: {
						type: "array",
						items: CANDIDATE_SCHEMA
					},
					surface_hints: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								file: { type: "string" },
								route: { type: "string" },
								routeTitle: { type: "string" },
								heading: { type: "string" },
								navText: { type: "string" },
								symbol: { type: "string" }
							}
						}
					},
					glossary: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								canonical: { type: "string" },
								variants: {
									type: "array",
									items: { type: "string" }
								},
								note: { type: "string" }
							}
						}
					},
					guidance: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderScanResult(value)
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("ux_scan：需要 agent 上下文（应在 agent loop 中调用）");
			const cwd = agent.session.header.cwd;
			if (cwd === void 0) throw new Error("ux_scan：当前会话没有工作目录（cwd），无法定位项目");
			const language = resolveOutputLanguage(cwd, config.outputLanguage, args.language);
			const productType = normalizeProductType(args.product_type);
			const reviewFocus = [...productReviewFocus(productType, language)];
			const heuristics = [...nielsenGuidance(language)];
			const reviewOrder = [...reviewPriority(language)];
			const stack = detectStack(cwd);
			if (!stack.supported) return {
				supported: false,
				stack: stack.stack,
				reason: stack.reason,
				language,
				product_type: productType,
				review_focus: reviewFocus,
				heuristics,
				review_priority: reviewOrder,
				files: [],
				file_count: 0,
				truncated: false,
				candidates: [],
				surface_hints: [],
				glossary: [],
				guidance: ["告知用户不支持的原因（spec 边界场景 9），不要给出低质量猜测。"]
			};
			const stackKind = stack.kind ?? "react-ts";
			const gathered = gatherFiles(cwd, args.paths ?? [], config.excludePatterns, config.maxScanFiles, stackKind);
			const styles = gatherStyleFiles(cwd, args.paths ?? [], config.excludePatterns, Math.max(1, Math.floor(config.maxScanFiles / 3)));
			const options = {
				maxPerRule: config.maxCandidatesPerRule,
				maxPerFile: config.maxCandidatesPerFile
			};
			const candidates = [];
			const surfaceIndex = createSurfaceIndex();
			for (const file of gathered.files) {
				let source;
				try {
					source = readSourceFile(cwd, file, MAX_FILE_BYTES);
				} catch {
					continue;
				}
				if (stackKind === "vue" && file.path.endsWith(".vue")) collectVueSurfaceHints(surfaceIndex, file.path, source);
				else collectSurfaceHints(surfaceIndex, file.path, source, stackKind === "vue" ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
				if (candidates.length >= MAX_CANDIDATES_TOTAL) continue;
				let extracted;
				if (stackKind === "vue" && file.path.endsWith(".vue")) {
					extracted = extractVueCandidates(file.path, source, options);
					extracted.push(...extractCssCandidates(file.path, source, options));
				} else if (stackKind === "vue") extracted = extractCandidates(file.path, source, options, ts.ScriptKind.TS);
				else extracted = extractCandidates(file.path, source, options, ts.ScriptKind.TSX);
				candidates.push(...extracted.slice(0, MAX_CANDIDATES_TOTAL - candidates.length));
			}
			for (const file of styles.files) {
				if (candidates.length >= MAX_CANDIDATES_TOTAL) break;
				let source;
				try {
					source = readSourceFile(cwd, file, MAX_FILE_BYTES);
				} catch {
					continue;
				}
				const extracted = extractCssCandidates(file.path, source, options);
				candidates.push(...extracted.slice(0, MAX_CANDIDATES_TOTAL - candidates.length));
			}
			const surfaceHints = [...new Set(candidates.map((candidate) => candidate.file))].map((file) => {
				const { candidates: _ordered, ...hint } = surfaceCandidatesFor(surfaceIndex, file);
				return hint;
			});
			const allFiles = [...gathered.files, ...styles.files];
			rememberScope(agent.session.id, allFiles.map((file) => file.path), surfaceIndex);
			const glossary = loadGlossary(cwd).terms;
			return {
				supported: true,
				stack: stack.stack,
				language,
				product_type: productType,
				review_focus: reviewFocus,
				heuristics,
				review_priority: reviewOrder,
				...args.focus === void 0 ? {} : { focus: args.focus },
				...args.persona_id === void 0 ? {} : { persona_id: args.persona_id },
				files: allFiles,
				file_count: allFiles.length,
				truncated: gathered.truncated || styles.truncated,
				candidates,
				surface_hints: surfaceHints,
				glossary,
				guidance: isChinese(language) ? [
					"用 read 工具阅读候选的 file:line 片段核实断言；snippet 已附在候选上。",
					"每条 finding 必须给开发者可理解的 surface（如\"管理员页面\"）：优先用 surface_hints 里的路由标题 / h1 / 导航文案，都没有就据组件名与页面内容拟名；拟不出时用路由路径，不能用文件路径。",
					HUMAN_COPY_RULE,
					`按 ${productType} 产品重点（${reviewFocus.join("、")}）和当前 persona 判定，不套用统一的信息密度或流程标准。`,
					`以 Nielsen 十项原则为基础逐项复核：${heuristics.join("；")}。`,
					`按常见程度检查：${reviewOrder.join("；")}。最终报告仍按实际严重度排序。`,
					"CSS/布局、Emoji、标题缺失候选只是截图检查入口，不能直接定稿。",
					"如果浏览器/截图工具可用且项目能打开，检查相关路由与视口并记录截图/DOM/尺寸引用；否则保持 static。",
					"只有实际按 persona 完成关键任务并记录步骤，才能使用 interactive。",
					"严格使用规则目录中的 minimumEvidence；证据不足时丢弃，不得升级标签。",
					"R-09 候选已由 AST 求证（verified_by=ast），无需再核实颜色本身，直接采用。",
					"每条 finding 必须带 locator（file 必填，尽量带 symbol）；指不到位置的候选直接丢弃。",
					"拿不准的候选宁可丢弃——\"发现问题总数\"不是目标，宁缺毋滥。",
					"本轮无一级 / 二级问题时才执行 R-02 术语检查（条件触发），只对新增/变更术语做增量判断。",
					"多 persona 走查时：换 persona_id 重复本工具独立走查，最后统一调用一次 ux_report 合并定稿。",
					`可选范围建议：${suggestSourceRoots(cwd).join(", ") || "（未发现常规源码目录）"}`
				] : [
					"Read each candidate at file:line and verify the attached source snippet.",
					"Use a developer-readable page/flow name for surface; use route/title/heading hints, never a file path.",
					`Judge candidates for the current persona and ${productType} product focus: ${reviewFocus.join(", ")}.`,
					`Use Nielsen's ten usability heuristics as the base checklist: ${heuristics.join("; ")}.`,
					`Review common issues first: ${reviewOrder.join("; ")}. Keep final report ordering severity-based.`,
					"CSS/layout, Emoji, and missing-heading candidates are inspection leads, not final visual findings.",
					"When browser/screenshot tools and a runnable app are available, inspect the route and viewport and record screenshot/DOM/measurement references; otherwise remain static.",
					"Use interactive only after completing the persona task and recording the steps.",
					"Enforce each rule’s minimumEvidence. Drop findings that do not meet the threshold.",
					"R-09 candidates are AST-verified and can be used as static findings.",
					"Every finding needs a file locator and persona_refs. Prefer precision over finding count.",
					`Suggested roots: ${suggestSourceRoots(cwd).join(", ") || "(none found)"}`
				]
			};
		}
	});
}
//#endregion
//#region src/index.ts
const name = "dsh-user-experience";
/** 依赖的注册表服务：工具注册表、命令注册表、系统提示词。 */
const inject = [
	"tools",
	"commands",
	"systemPrompt"
];
/**
* Host 插件主体。
* @param ctx - 带 tools / commands / systemPrompt 服务的上下文。
* @param config - 校验后的插件配置（含 schema 默认值）。
*/
function apply(ctx, config) {
	ctx.commands.register(createUxCommand(config.outputLanguage));
	ctx.systemPrompt.section({
		name: "ux:personas",
		order: 90,
		text: (context) => renderPersonaSection(context.agent)
	});
	ctx.tools.register(uxScanTool(config));
	ctx.tools.register(uxReportTool(config));
	ctx.tools.register(uxJudgeTool());
	ctx.tools.register(uxPersonasWriteTool(config));
	registerAutoScan(ctx, config);
}
//#endregion
export { Config, apply, inject, name };
