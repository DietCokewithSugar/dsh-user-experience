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
import type { UxMode } from './types';
export declare const LOCAL_RULES_FILE = ".ux/rules.local.yml";
/** R7 自动走查的本地开关。 */
export interface AutoScanPreference {
    /** 是否启用改动触发的自动走查。 */
    enabled?: boolean;
    /** 两次自动走查之间至少间隔多少个回合（防抖）。 */
    debounceTurns?: number;
}
/** `.ux/rules.local.yml` 中本版认识的部分。 */
export interface LocalRules {
    /** 固定运行模式；缺省时走场景自动选择。 */
    mode?: UxMode;
    autoScan?: AutoScanPreference;
}
export declare function localRulesPath(root: string): string;
/**
 * 读取偏好文件；文件缺失、不可解析或键型不对时返回空偏好（不抛错）。
 * @param root - 项目根目录。
 * @returns 本版认识的偏好项。
 */
export declare function loadLocalRules(root: string): LocalRules;
