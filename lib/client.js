window.__ModuleLoader__.load({
	id: "dsh-user-experience",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/types.ts
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
		/**
		* 把技术块渲染成结构化 YAML —— 卡片"一键复制"的内容，直接可粘给 AI
		* （v0.1.1 spec §3.3 / §8）。Host 与 Client 共用同一函数，避免两处漂移。
		* @param finding - 已定稿的 finding。
		* @returns 可直接粘贴的 YAML 文本（不含尾随换行）。
		*/
		function technicalYaml(finding) {
			const { technical: tech } = finding;
			const locator = [`file: ${tech.locator.file}`];
			if (tech.locator.symbol !== void 0) locator.push(`symbol: ${tech.locator.symbol}`);
			if (tech.locator.line !== void 0) locator.push(`line: ${String(tech.locator.line)}`);
			return [
				`id: ${finding.id}`,
				`fingerprint: ${finding.fingerprint}`,
				`surface: ${finding.surface}`,
				`headline: ${finding.human.headline}`,
				"technical:",
				`  locator: { ${locator.join(", ")} }`,
				`  rule: ${tech.rule}`,
				`  category: ${tech.category}`,
				`  verified_by: ${tech.verified_by}`,
				`  evidence_level: ${tech.evidence_level}`,
				`  evidence_refs: [${tech.evidence_refs.join(", ")}]`,
				`  persona_refs: [${tech.persona_refs.join(", ")}]`,
				`  severity: { impact: ${tech.severity.impact}, impact_confidence: ${tech.severity.impact_confidence}, reach: ${tech.severity.reach}, level: ${tech.severity.level} }`,
				`  rationale: ${tech.rationale}`,
				`  suggestion: ${tech.suggestion}`,
				`status: ${finding.status}`
			].join("\n");
		}
		/**
		* 为已确认的问题生成可直接交给编码 AI 的任务 Prompt。
		*
		* Prompt 只描述已经观察到的现象、用户影响与验收目标，不携带 suggestion /
		* rationale，避免插件基于局部代码替 AI 预设实现方案。locator 只是帮助 AI
		* 开始调查的线索；Prompt 会明确要求先补齐完整项目上下文。
		*/
		function deliveryPrompt(finding, language = "zh-CN") {
			const locator = `${finding.technical.locator.file}` + (finding.technical.locator.line === void 0 ? "" : `:${String(finding.technical.locator.line)}`) + (finding.technical.locator.symbol === void 0 ? "" : `（${finding.technical.locator.symbol}）`);
			if (language === "en") return [
				"Please address the confirmed user-experience issue below.",
				"",
				`Observed behavior: ${finding.human.headline}`,
				`What users experience: ${finding.human.description}`,
				`Scenario: ${finding.surface}`,
				`Initial location clue: ${locator}`,
				"",
				"Requirements:",
				"1. Read the complete business flow, components, state management, and upstream/downstream calls for this scenario before changing code.",
				"2. The location above comes from only the portion of the codebase visible to the plugin. Treat it as a starting point, not complete project context.",
				"3. Determine the root cause and implementation from the project architecture; do not treat this description as a prescribed code change.",
				"4. If the issue involves UI copy, you may edit the copy directly. Make what happened, its impact, and the next available action clear to users.",
				`5. Verify that the behavior no longer occurs in "${finding.surface}" and that related normal, error, and edge-case flows have not regressed.`
			].join("\n");
			return [
				"请处理下面这个已经确认的用户体验问题。",
				"",
				`观察到的现象：${finding.human.headline}`,
				`用户实际遇到的情况：${finding.human.description}`,
				`发生场景：${finding.surface}`,
				`初步定位线索：${locator}`,
				"",
				"工作要求：",
				"1. 先阅读该场景关联的完整业务流程、组件、状态管理和上下游调用，再开始修改。",
				"2. 上述定位只来自插件能够读取到的部分代码，是调查起点，不代表完整项目上下文。",
				"3. 请根据项目现有架构自行判断根因和实现方式，不要把这段描述当成具体代码修改方案。",
				"4. 如果问题涉及界面文案，可以直接修改文案；修改后应让用户清楚知道发生了什么、有什么影响以及下一步能做什么。",
				`5. 完成后验证：在「${finding.surface}」中不再出现上述现象，并且相关正常、异常和边界流程没有回归。`
			].join("\n");
		}
		//#endregion
		//#region src/client/report-view.ts
		/**
		* UX 走查报告卡片渲染器（spec §R4 确认闭环；v0.1.1 §3.3 卡片重构）。
		*
		* **卡片默认呈现只回答人关心的三件事**：哪个页面、出了什么事、严不严重。
		*
		* ```
		* ┌────────────────────────────────────────────┐
		* │ [一级问题]  管理员页面                       │
		* │ 删除用户后没有任何提示                       │
		* │                                            │
		* │ 管理员点击删除后界面没有任何变化，无法判断    │
		* │ 操作是否成功，很可能重复点击导致误删多条记录。 │
		* │                                            │
		* │  [ 确认存在 ]  [ 不是问题 ]   ▸ 技术细节     │
		* └────────────────────────────────────────────┘
		* ```
		*
		* 文件路径、规则 ID、P0~P3 都在折叠区里——它们是给 AI 看的，展开后可一键
		* 复制成结构化 YAML。用户确认问题成立后，卡片还会提供一份现象导向的任务
		* Prompt：要求编码 AI 先补齐完整项目上下文，不预设具体代码改法。review 模式下
		* 卡片底部还有批量确认条：勾选多条一并提交，用户不需要知道任何 ID。
		*
		* 纯 React.createElement（无 JSX）；样式内联，不触碰全局主题与 DOM。
		*/
		const SEVERITY_ORDER = {
			P0: 0,
			P1: 1,
			P2: 2,
			P3: 3
		};
		/** 严重度徽标配色（中性化，深浅色模式下均可读）。 */
		const LEVEL_STYLE = {
			P0: {
				background: "rgba(229, 83, 75, 0.14)",
				color: "#e5534b",
				border: "1px solid rgba(229, 83, 75, 0.45)"
			},
			P1: {
				background: "rgba(233, 148, 40, 0.14)",
				color: "#d98b23",
				border: "1px solid rgba(233, 148, 40, 0.45)"
			},
			P2: {
				background: "rgba(84, 145, 219, 0.14)",
				color: "#5489db",
				border: "1px solid rgba(84, 145, 219, 0.45)"
			},
			P3: {
				background: "rgba(128, 128, 128, 0.12)",
				color: "#909090",
				border: "1px solid rgba(128, 128, 128, 0.35)"
			}
		};
		const CARD = {
			border: "1px solid rgba(128, 128, 128, 0.35)",
			borderRadius: 8,
			padding: "12px 14px",
			margin: "8px 0",
			maxWidth: 720,
			fontSize: 13,
			lineHeight: 1.55
		};
		const TITLE = {
			fontSize: 14,
			fontWeight: 600,
			margin: 0
		};
		const META = {
			color: "rgba(128, 128, 128, 0.9)",
			fontSize: 12,
			margin: "2px 0 10px"
		};
		const FINDING = {
			borderTop: "1px solid rgba(128, 128, 128, 0.22)",
			padding: "10px 0"
		};
		const HEAD = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			flexWrap: "wrap"
		};
		const BADGE = {
			borderRadius: 999,
			padding: "0 8px",
			fontSize: 11,
			fontWeight: 600,
			whiteSpace: "nowrap"
		};
		const SURFACE = {
			fontSize: 13,
			fontWeight: 600
		};
		const HEADLINE = {
			margin: "6px 0 2px",
			fontSize: 14,
			fontWeight: 600
		};
		const DESCRIPTION = {
			margin: "4px 0 0",
			color: "inherit",
			whiteSpace: "pre-wrap"
		};
		const ACTIONS = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			marginTop: 10,
			flexWrap: "wrap"
		};
		const BUTTON_BASE = {
			borderRadius: 6,
			border: "1px solid rgba(128, 128, 128, 0.45)",
			background: "transparent",
			padding: "3px 12px",
			fontSize: 12,
			cursor: "pointer"
		};
		const CONFIRM_BUTTON = {
			...BUTTON_BASE,
			color: "#3f9d63",
			borderColor: "rgba(63, 157, 99, 0.55)"
		};
		const REJECT_BUTTON = {
			...BUTTON_BASE,
			color: "#d06b64",
			borderColor: "rgba(208, 107, 100, 0.55)"
		};
		const LINK_BUTTON = {
			border: "none",
			background: "transparent",
			color: "rgba(128, 128, 128, 1)",
			fontSize: 12,
			cursor: "pointer",
			padding: "3px 4px"
		};
		const TECHNICAL = {
			marginTop: 8,
			padding: "8px 10px",
			borderRadius: 6,
			border: "1px dashed rgba(128, 128, 128, 0.4)",
			background: "rgba(128, 128, 128, 0.06)"
		};
		const CODE = {
			margin: 0,
			fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
			fontSize: 11.5,
			lineHeight: 1.5,
			whiteSpace: "pre-wrap",
			wordBreak: "break-word"
		};
		const STATUS_BADGE = {
			confirmed_explicit: {
				color: "#3f9d63",
				fontWeight: 600,
				fontSize: 12
			},
			confirmed_implicit: {
				color: "#3f9d63",
				fontWeight: 600,
				fontSize: 12
			},
			rejected: {
				color: "#d06b64",
				fontWeight: 600,
				fontSize: 12
			},
			stale: {
				color: "rgba(128, 128, 128, 0.9)",
				fontWeight: 600,
				fontSize: 12
			}
		};
		const COPY = {
			"zh-CN": {
				confirmed: "确认存在",
				rejected: "不是问题",
				status: {
					confirmed_explicit: "✓ 已确认存在",
					confirmed_implicit: "✓ 已改掉（下次走查中消失）",
					rejected: "✗ 不是问题",
					stale: "— 本次未覆盖，无法判定"
				},
				select: "选择",
				prompt: "复制给 AI 的任务 Prompt",
				promptCopied: "已复制，可交给 AI",
				copyFailed: "复制失败，请重试",
				detailsOpen: "▾ 技术细节",
				detailsClosed: "▸ 技术细节",
				techCopied: "已复制，可直接粘给 AI",
				manualCopy: "复制失败，请手动选中上方文本",
				copyTech: "复制技术细节",
				report: "UX 走查",
				allJudged: "已全部判定",
				total: "共",
				pending: "条待你判断",
				judged: "已判定",
				selected: "已选",
				selectMany: "勾选多条可一并提交",
				confirmSelected: "确认选中",
				rejectSelected: "选中的不是问题",
				ignoreMinor: "三级以下全部忽略",
				submitFailed: "判定提交失败",
				footer: "也可以直接描述要确认或排除的问题，不需要填写内部编号。"
			},
			en: {
				confirmed: "Confirm",
				rejected: "Not an issue",
				status: {
					confirmed_explicit: "✓ Confirmed",
					confirmed_implicit: "✓ Improved (gone after re-scan)",
					rejected: "✗ Not an issue",
					stale: "— Not covered by this scan"
				},
				select: "Select",
				prompt: "Copy task Prompt for AI",
				promptCopied: "Copied for AI",
				copyFailed: "Copy failed; try again",
				detailsOpen: "▾ Technical details",
				detailsClosed: "▸ Technical details",
				techCopied: "Copied for AI",
				manualCopy: "Copy failed; select the text above",
				copyTech: "Copy technical details",
				report: "UX walkthrough",
				allJudged: "all reviewed",
				total: "Total",
				pending: "awaiting review",
				judged: "reviewed",
				selected: "Selected",
				selectMany: "Select findings to submit together",
				confirmSelected: "Confirm selected",
				rejectSelected: "Reject selected",
				ignoreMinor: "Ignore level three/four",
				submitFailed: "Could not save verdict",
				footer: "You can also describe which findings to confirm or reject; no internal IDs are required."
			}
		};
		const BULK = {
			borderTop: "1px solid rgba(128, 128, 128, 0.22)",
			paddingTop: 10,
			marginTop: 8,
			display: "flex",
			alignItems: "center",
			gap: 8,
			flexWrap: "wrap"
		};
		const FOOTER = {
			borderTop: "1px solid rgba(128, 128, 128, 0.22)",
			paddingTop: 8,
			marginTop: 8,
			color: "rgba(128, 128, 128, 0.9)",
			fontSize: 12
		};
		const ERROR = {
			color: "#d06b64",
			fontSize: 12,
			marginTop: 6
		};
		/** 复制到剪贴板；剪贴板不可用时退回选中文本框让用户手动复制。 */
		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch {
				return false;
			}
		}
		function FindingRow({ finding, busy, selectable, selected, copy, onToggle, onJudge }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const [copied, setCopied] = (0, react.useState)("idle");
			const [promptCopied, setPromptCopied] = (0, react.useState)("idle");
			const levelStyle = LEVEL_STYLE[finding.level] ?? {};
			const pending = finding.status === "pending";
			const confirmedByUser = finding.status === "confirmed_explicit";
			return (0, react.createElement)("div", { style: FINDING }, (0, react.createElement)("div", { style: HEAD }, selectable && pending ? (0, react.createElement)("input", {
				type: "checkbox",
				checked: selected,
				disabled: busy,
				onChange: () => onToggle(finding.id),
				"aria-label": `${copy.select}: ${finding.headline}`
			}) : null, (0, react.createElement)("span", { style: {
				...BADGE,
				...levelStyle
			} }, finding.severityLabel), (0, react.createElement)("span", { style: SURFACE }, finding.surface), pending ? null : (0, react.createElement)("span", { style: STATUS_BADGE[finding.status] ?? {} }, copy.status[finding.status] ?? finding.status)), (0, react.createElement)("p", { style: HEADLINE }, finding.headline), finding.description.length === 0 ? null : (0, react.createElement)("p", { style: DESCRIPTION }, finding.description), (0, react.createElement)("div", { style: ACTIONS }, pending ? (0, react.createElement)("button", {
				type: "button",
				style: CONFIRM_BUTTON,
				disabled: busy,
				onClick: () => onJudge([finding.id], "confirmed")
			}, copy.confirmed) : null, pending ? (0, react.createElement)("button", {
				type: "button",
				style: REJECT_BUTTON,
				disabled: busy,
				onClick: () => onJudge([finding.id], "rejected")
			}, copy.rejected) : null, confirmedByUser ? (0, react.createElement)("button", {
				type: "button",
				style: CONFIRM_BUTTON,
				onClick: () => {
					copyText(finding.deliveryPrompt).then((ok) => setPromptCopied(ok ? "ok" : "fail"));
				}
			}, promptCopied === "ok" ? copy.promptCopied : promptCopied === "fail" ? copy.copyFailed : copy.prompt) : null, (0, react.createElement)("button", {
				type: "button",
				style: LINK_BUTTON,
				onClick: () => setExpanded(!expanded),
				"aria-expanded": expanded
			}, expanded ? copy.detailsOpen : copy.detailsClosed)), expanded ? (0, react.createElement)("div", { style: TECHNICAL }, (0, react.createElement)("pre", { style: CODE }, finding.technicalYaml), (0, react.createElement)("button", {
				type: "button",
				style: {
					...LINK_BUTTON,
					paddingLeft: 0
				},
				onClick: () => {
					copyText(finding.technicalYaml).then((ok) => setCopied(ok ? "ok" : "fail"));
				}
			}, copied === "ok" ? copy.techCopied : copied === "fail" ? copy.manualCopy : copy.copyTech)) : null);
		}
		/** 报告卡片组件：人话在前，技术细节折叠，review 模式提供批量确认。 */
		function UxReportNodeView({ node, judge }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [selected, setSelected] = (0, react.useState)([]);
			const data = node.data;
			const copy = data.language === "en" ? COPY.en : COPY["zh-CN"];
			const sorted = [...data.findings].sort((left, right) => (SEVERITY_ORDER[left.level] ?? 9) - (SEVERITY_ORDER[right.level] ?? 9));
			const pendingFindings = sorted.filter((finding) => finding.status === "pending");
			const judged = data.findings.length - pendingFindings.length;
			const selectable = data.mode === "review" && pendingFindings.length > 1;
			const submit = (findingIds, verdict) => {
				if (findingIds.length === 0) return;
				setBusy(true);
				setError(null);
				judge(data.reportId, findingIds, verdict).then((failure) => {
					if (failure !== null) setError(failure);
					else setSelected([]);
				}).catch((reason) => {
					setError(reason instanceof Error ? reason.message : String(reason));
				}).finally(() => setBusy(false));
			};
			const toggle = (id) => {
				setSelected(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
			};
			const minorPending = pendingFindings.filter((finding) => finding.level === "P2" || finding.level === "P3").map((finding) => finding.id);
			return (0, react.createElement)("div", { style: CARD }, (0, react.createElement)("p", { style: TITLE }, `${copy.report}: ${data.title}`), (0, react.createElement)("p", { style: META }, pendingFindings.length === 0 ? `${copy.total} ${data.findings.length}, ${copy.allJudged}` : `${copy.total} ${data.findings.length}, ${pendingFindings.length} ${copy.pending}${judged > 0 ? ` (${copy.judged} ${judged})` : ""}`), ...sorted.map((finding) => (0, react.createElement)(FindingRow, {
				key: finding.id,
				finding,
				busy,
				selectable,
				selected: selected.includes(finding.id),
				copy,
				onToggle: toggle,
				onJudge: submit
			})), selectable ? (0, react.createElement)("div", { style: BULK }, (0, react.createElement)("span", { style: {
				fontSize: 12,
				color: "rgba(128,128,128,0.9)"
			} }, selected.length === 0 ? `${copy.selectMany}:` : `${copy.selected} ${selected.length}:`), (0, react.createElement)("button", {
				type: "button",
				style: CONFIRM_BUTTON,
				disabled: busy || selected.length === 0,
				onClick: () => submit(selected, "confirmed")
			}, copy.confirmSelected), (0, react.createElement)("button", {
				type: "button",
				style: REJECT_BUTTON,
				disabled: busy || selected.length === 0,
				onClick: () => submit(selected, "rejected")
			}, copy.rejectSelected), minorPending.length === 0 ? null : (0, react.createElement)("button", {
				type: "button",
				style: LINK_BUTTON,
				disabled: busy,
				onClick: () => submit(minorPending, "rejected")
			}, `${copy.ignoreMinor} (${minorPending.length})`)) : null, error === null ? null : (0, react.createElement)("p", { style: ERROR }, `${copy.submitFailed}: ${error}`), (0, react.createElement)("p", { style: FOOTER }, copy.footer));
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* 把任意版本的事件载荷归一成当前结构。
		*
		* v0.1 的日志里 finding 是扁平的（evidence / severity 在顶层，没有 human /
		* surface / fingerprint），历史会话重放时必须还能渲染——归一后 surface 退到
		* 组件名，headline 退到依据原文，**仍然不会显示文件路径**。
		* @param raw - 事件里的一条 finding（可能是旧形状）。
		* @returns 当前结构的 finding。
		*/
		function normalizeFinding(raw) {
			if ("human" in raw && "technical" in raw) return {
				...raw,
				technical: {
					...raw.technical,
					evidence_refs: raw.technical.evidence_refs ?? []
				}
			};
			const legacy = raw;
			const level = legacy.severity?.level ?? "P3";
			const locator = legacy.evidence?.locator ?? { file: "" };
			const rationale = legacy.evidence?.rationale ?? "";
			const status = legacy.status === "confirmed" ? "confirmed_explicit" : legacy.status === "rejected" ? "rejected" : "pending";
			return {
				id: legacy.id,
				fingerprint: "",
				surface: locator.symbol ?? "（历史报告，未记录页面名）",
				human: {
					headline: rationale.length > 0 ? rationale : "（历史报告，未记录问题描述）",
					description: legacy.suggestion ?? "",
					severity_label: severityLabel(level)
				},
				technical: {
					locator: {
						file: locator.file ?? "",
						...locator.symbol === void 0 ? {} : { symbol: locator.symbol },
						...locator.line === void 0 ? {} : { line: locator.line }
					},
					rule: legacy.rule ?? "",
					category: legacy.category ?? "state-coverage",
					verified_by: legacy.evidence?.verified_by ?? "model",
					evidence_level: "static",
					evidence_refs: [],
					persona_refs: legacy.persona_refs ?? [],
					severity: {
						impact: legacy.severity?.impact ?? "low",
						impact_confidence: "medium",
						reach: legacy.severity?.reach ?? "narrow",
						level
					},
					rationale,
					suggestion: legacy.suggestion ?? ""
				},
				status
			};
		}
		function locationOf(context) {
			return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
		}
		function viewData(state) {
			return {
				reportId: state.reportId,
				title: state.title,
				mode: state.mode,
				language: state.language,
				productType: state.productType,
				findings: state.findings.map((finding) => ({
					id: finding.id,
					surface: finding.surface,
					severityLabel: finding.human.severity_label,
					headline: finding.human.headline,
					description: finding.human.description,
					level: finding.technical.severity.level,
					technicalYaml: technicalYaml(finding),
					deliveryPrompt: deliveryPrompt(finding, state.language),
					status: finding.status
				}))
			};
		}
		/** 报告状态机定义（导出供测试与复用；注册见 apply）。 */
		const uxReportDefinition = {
			kind: "ux-report",
			target: "chat",
			match: (event) => {
				if (event.type === "ux/report") return {
					id: event.data.reportId,
					role: "start"
				};
				if (event.type === "ux/finding-status") return {
					id: event.data.reportId,
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "ux/report") throw new Error("ux-report requires ux/report");
				return {
					reportId: match.event.data.reportId,
					title: match.event.data.title,
					mode: match.event.data.mode ?? "review",
					language: match.event.data.language ?? "zh-CN",
					productType: match.event.data.productType ?? "other",
					findings: match.event.data.findings.map(normalizeFinding)
				};
			},
			update: (context, match) => {
				if (match.event.type !== "ux/finding-status") return context.state;
				const { findingId, status } = match.event.data;
				return {
					...context.state,
					findings: context.state.findings.map((finding) => finding.id === findingId ? {
						...finding,
						status
					} : finding)
				};
			},
			publication: () => "immediate",
			buildViewNode: (context) => {
				if (context.state === void 0) return null;
				return {
					key: context.key,
					kind: "ux-report",
					id: context.id,
					target: "chat",
					anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
					location: locationOf(context),
					visibility: "visible",
					data: viewData(context.state)
				};
			}
		};
		const inject = [
			"conversationEvents",
			"slots",
			"remote",
			"remote.commands"
		];
		/** Client 插件主体。 */
		function apply(ctx) {
			ctx.conversationEvents.register(uxReportDefinition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "ux-report",
				inject: (sessionId) => ({ judge: async (reportId, findingIds, verdict) => {
					if (findingIds.length === 0) return null;
					const result = await ctx.remote.commands.execute(sessionId, `/ux judge ${reportId} ${findingIds.join(",")} ${verdict}`);
					if (!result.ok) return `${result.error.message} (${result.error.code})`;
					if (result.value === void 0) return "判定通道不可用";
					return null;
				} })
			}, UxReportNodeView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.normalizeFinding = normalizeFinding;
		exports.uxReportDefinition = uxReportDefinition;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map