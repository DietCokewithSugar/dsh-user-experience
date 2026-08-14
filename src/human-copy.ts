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
 * 风险表里写得很明白——**写不出人话的 finding 宁可不报**。
 *
 * 校验刻意保守：只认"一眼就是代码"的特征（文件路径、反引号包裹的标识符、
 * 函数调用形态、代码术语）。宁可漏掉几条夹带术语的描述，也不能把正常中文
 * 描述误杀——误杀等于让插件不敢报。
 */

/** 反引号包裹的内容（模型引用代码时的典型写法）。 */
const BACKTICK = /`[^`]+`/u

/** 函数调用形态：`handleDelete(`、`toast.error(`。 */
const CALL_FORM = /[A-Za-z_$][\w$]*\s*\(\s*\)|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/u

/** 文件路径 / 扩展名。 */
const FILE_PATH = /\.(?:tsx?|jsx?|vue|css|scss)\b|(?:^|\s)(?:src|components|pages|views)\//u

/**
 * 代码腔术语：出现即判定为"在讲代码"。
 * 只收那些在中文产品描述里几乎不会自然出现的词。
 */
const CODE_TERM = /\b(?:catch|try|await|async|props?|state|hook|useState|useEffect|componentDidMount|render|toast|dispatch|reducer|selector|className|v-if|v-for|setState|throw|promise|callback|api\s*调用|分支)\b/iu

/** 结构性代码描述的中文说法（"缺少 xxx 分支""没有调用 xxx"）。 */
const CODE_PHRASE = /(?:缺少|没有|未)\s*(?:调用|实现|声明|绑定|定义)|分支(?:中|里)?(?:没有|缺)|函数(?:中|里)/u

/**
 * 判断一段描述是否是"代码腔"（在讲代码而不是讲用户遭遇）。
 * @param text - 待检文本。
 * @returns 命中的特征说明；不是代码腔时返回 undefined。
 */
export function codeSpeakReason(text: string): string | undefined {
  const value = text.trim()
  if (value.length === 0) return '描述为空'
  if (FILE_PATH.test(value)) return '描述里出现文件路径'
  if (BACKTICK.test(value)) return '描述里用反引号引用了代码符号'
  if (CALL_FORM.test(value)) return '描述里出现函数调用形态'
  if (CODE_TERM.test(value)) return '描述里出现代码术语'
  if (CODE_PHRASE.test(value)) return '描述在讲"代码里缺什么"而不是"用户会遇到什么"'
  return undefined
}

/** 写进提示词的正反例对照（spec §3.5 的表格）。 */
export const HUMAN_COPY_RULE = [
  'human.description 必须写"用户会遇到什么"，不写"代码里缺什么"：',
  '  ❌「handleDelete 的 catch 分支中没有调用 toast」→ ✅「删除失败时界面没有任何提示，用户以为删成功了」',
  '  ❌「缺少 empty state 分支」→ ✅「列表为空时页面一片空白，看不出是没数据还是加载失败」',
  '写不出人话描述的 finding 宁可不报——定稿时带代码腔的描述会被丢弃。',
].join('\n')
