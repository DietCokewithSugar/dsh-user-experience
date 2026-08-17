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
import ts from 'typescript';
/** 一个文件里提取到的人话位置素材。 */
export interface SurfaceHint {
    /** 相对项目根的文件路径（素材归属，不是给人看的位置名）。 */
    file: string;
    /** 路由路径，如 `/admin/users`。 */
    route?: string;
    /** 路由配置里的标题（`title` / `meta.title`）。 */
    routeTitle?: string;
    /** 页面根组件内的 h1 文本。 */
    heading?: string;
    /** 导航 / 面包屑中指向该路由的链接文案。 */
    navText?: string;
    /** 组件 / 符号名（模型拟名时的素材）。 */
    symbol?: string;
}
/** 路由表条目：路径 + 标题 + 指向的组件线索。 */
interface RouteEntry {
    route: string;
    title?: string;
    /** 元素/组件标识符名，如 `UserTable`。 */
    component?: string;
    /** 懒加载 import 的模块说明符，如 `./pages/Admin/UserTable`。 */
    module?: string;
}
/** 导航链接：目标路由 + 链接文案。 */
interface NavLink {
    route: string;
    text: string;
}
/** 一次扫描收集到的全项目素材。 */
export interface SurfaceIndex {
    routes: RouteEntry[];
    navLinks: NavLink[];
    /** 文件 → 该文件内的 h1 文本。 */
    headings: Map<string, string>;
    /** 文件 → 主要导出的组件名。 */
    symbols: Map<string, string>;
}
/** 新建一份空索引。 */
export declare function createSurfaceIndex(): SurfaceIndex;
/**
 * 从一个 TS / TSX 源文件收集素材，合并进索引。
 * @param index - 累积索引（就地写入）。
 * @param file - 相对项目根的文件路径。
 * @param source - 源码文本。
 * @param scriptKind - 解析用的脚本种类。
 */
export declare function collectSurfaceHints(index: SurfaceIndex, file: string, source: string, scriptKind?: ts.ScriptKind): void;
/**
 * 从一个 Vue SFC 收集素材：模板里的 h1 与 router-link 文案。
 * @param index - 累积索引（就地写入）。
 * @param file - 相对项目根的 .vue 路径。
 * @param source - SFC 源码。
 */
export declare function collectVueSurfaceHints(index: SurfaceIndex, file: string, source: string): void;
/**
 * 一个文件的位置名候选。
 *
 * 各来源**分字段返回而不是只给一个有序数组**：数组只说得清优先级，说不清
 * "这个名字是从哪来的"，按位置读取就会把 h1 当成路由标题。
 */
export interface SurfaceCandidate {
    file: string;
    /** 来源一：路由配置的 title / meta.title。 */
    routeTitle?: string;
    /** 来源二：页面根组件内的 h1 文本。 */
    heading?: string;
    /** 来源三：导航 / 面包屑中指向该路由的链接文案。 */
    navText?: string;
    /** 关联到的路由路径（兜底用，绝不用文件路径兜底）。 */
    route?: string;
    /** 组件 / 符号名（模型拟名时的素材）。 */
    symbol?: string;
    /** 上面三项按优先级去重后的候选名列表。 */
    candidates: string[];
}
/**
 * 为一个文件计算人话位置名候选（spec §3.4 的优先级顺序）。
 * @param index - 扫描期累积的素材索引。
 * @param file - 相对项目根的文件路径。
 * @returns 候选名（可能为空）与关联路由。
 */
export declare function surfaceCandidatesFor(index: SurfaceIndex, file: string): SurfaceCandidate;
/** 看起来像文件路径 / 代码标识而非人话页面名。 */
export declare function looksLikeFilePath(value: string): boolean;
/**
 * 定稿时的 surface 净化与兜底：
 * 模型给的名字像文件路径 → 换成路由路径 → 再不行退到组件名。
 * **任何情况下都不会返回文件路径**（spec §8 验收）。
 * @param proposed - 模型给出的位置名（可能缺失或不合格）。
 * @param fallback - 兜底素材：路由路径与组件名。
 * @returns 可直接上界面的人话位置名。
 */
export declare function sanitizeSurface(proposed: string | undefined, fallback: {
    route?: string;
    symbol?: string;
}): string;
export {};
