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
/**
 * 判断一段描述是否是"代码腔"（在讲代码而不是讲用户遭遇）。
 * @param text - 待检文本。
 * @returns 命中的特征说明；不是代码腔时返回 undefined。
 */
export declare function codeSpeakReason(text: string): string | undefined;
/** 写进提示词的正反例对照（spec §3.5 的表格）。 */
export declare const HUMAN_COPY_RULE: string;
