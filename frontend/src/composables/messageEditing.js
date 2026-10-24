import { hasMessageIdentity } from './messageIdentity.js'

export class MessageEditError extends Error {
  constructor() {
    super('修改未获确认，原消息及编辑文字已保留。请稍后再试，不要重复覆盖。')
    this.name = 'MessageEditError'
  }
}

/** 按 Unicode 字符求一个保守的改动范围，多处改动之间也视为同一范围。 */
function changedRange(original, modified) {
  let start = 0
  while (start < original.length && start < modified.length && original[start] === modified[start])
    start++
  let end = original.length
  let modifiedEnd = modified.length
  while (end > start && modifiedEnd > start && original[end - 1] === modified[modifiedEnd - 1]) {
    end--
    modifiedEnd--
  }
  return { start, end, replacement: modified.slice(start, modifiedEnd) }
}

/** 只自动合并可证明互不相交的修改，边界插入和范围重叠交由用户确认。 */
export function mergeMessageEdits(base, local, remote) {
  if (local === remote || remote === base) return local
  if (local === base) return remote
  const original = Array.from(base)
  const first = changedRange(original, Array.from(local))
  const second = changedRange(original, Array.from(remote))
  const ordered = [first, second].sort((left, right) => left.start - right.start)
  const [left, right] = ordered
  if (
    left.end > right.start ||
    (left.end === right.start && (left.start === left.end || right.start === right.end))
  )
    return null
  return original
    .slice(0, left.start)
    .concat(
      left.replacement,
      original.slice(left.end, right.start),
      right.replacement,
      original.slice(right.end),
    )
    .join('')
}

function confirmed(result, identity, content) {
  return (
    result?.saved === true &&
    result.message_id === identity.id &&
    hasMessageIdentity({ id: result.message_id, revision: result.revision }) &&
    result.content === content
  )
}

/** 冲突只核实目标消息，最多安全重试一次，不刷新页面或猜测其他身份。 */
export async function saveUserMessageEdit({
  convId,
  identity,
  baseContent,
  content,
  patch,
  getConversation,
  isCancelled = () => false,
}) {
  let expected = identity
  let desired = content
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isCancelled()) return { status: 'cancelled' }
    let conflict = false
    try {
      const result = await patch(convId, expected.id, expected.revision, desired)
      if (confirmed(result, expected, desired)) return { status: 'saved', ...result }
    } catch (error) {
      conflict = error.response?.status === 409 && error.response?.data?.code === 'message_changed'
    }
    if (isCancelled()) return { status: 'cancelled' }
    let latest
    try {
      const saved = await getConversation(convId)
      const matches = saved?.messages?.filter((message) => message.id === identity.id)
      if (saved?.id === convId && matches?.length === 1) latest = matches[0]
    } catch {
      throw new MessageEditError()
    }
    if (isCancelled()) return { status: 'cancelled' }
    if (!hasMessageIdentity(latest) || latest.role !== 'user' || typeof latest.content !== 'string')
      throw new MessageEditError()
    if (latest.content === desired) {
      return {
        status: 'saved',
        saved: true,
        message_id: latest.id,
        revision: latest.revision,
        content: latest.content,
      }
    }
    if (!conflict) throw new MessageEditError()
    const merged = mergeMessageEdits(baseContent, content, latest.content)
    if (merged === latest.content) {
      return {
        status: 'saved',
        saved: true,
        message_id: latest.id,
        revision: latest.revision,
        content: latest.content,
      }
    }
    if (merged === null || attempt === 1) return { status: 'conflict', latest }
    expected = { id: latest.id, revision: latest.revision }
    desired = merged
  }
}
