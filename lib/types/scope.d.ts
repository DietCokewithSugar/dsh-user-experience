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
import { type SurfaceIndex } from './surface';
/** 一次走查累积的扫描范围。 */
export interface ScanScope {
    /** 本次实际扫描到的文件（相对项目根）。 */
    files: Set<string>;
    /** 扫描期收集到的人话位置素材。 */
    surface: SurfaceIndex;
}
/**
 * 累加一次 `ux_scan` 的扫描结果。
 * @param sessionId - 会话 id。
 * @param files - 本次收集到的文件路径。
 * @param surface - 本次收集到的位置素材（就地合并）。
 */
export declare function rememberScope(sessionId: string, files: readonly string[], surface: SurfaceIndex): void;
/**
 * 读取当前累积的范围（不清空）。
 * @param sessionId - 会话 id。
 * @returns 累积范围；没有扫描过时 undefined。
 */
export declare function peekScope(sessionId: string): ScanScope | undefined;
/**
 * 取走并清空当前累积的范围（`ux_report` 定稿时调用）。
 * @param sessionId - 会话 id。
 * @returns 累积范围；没有扫描过时 undefined。
 */
export declare function takeScope(sessionId: string): ScanScope | undefined;
