import { ref, reactive } from 'vue'

export class TitleSaveError extends Error {
  constructor() {
    super('重命名未获确认，页面暂保留原标题和编辑草稿；请先保留草稿，再刷新核实。')
    this.name = 'TitleSaveError'
  }
}

/** 只提交一次；回执不明时核实目标标题，不自动重试写入或猜测已保存。 */
export async function saveConversationTitle({
  id,
  title,
  expected,
  patch,
  getConversation,
  isCancelled = () => false,
}) {
  if (isCancelled()) return { status: 'cancelled' }
  try {
    const result = await patch(id, title, expected)
    if (isCancelled()) return { status: 'cancelled' }
    if (result?.saved === true && result.conversation_id === id && result.title === title)
      return { status: 'saved', title }
  } catch {
    if (isCancelled()) return { status: 'cancelled' }
  }
  let latest
  try {
    latest = await getConversation(id)
  } catch {
    if (isCancelled()) return { status: 'cancelled' }
    throw new TitleSaveError()
  }
  if (isCancelled()) return { status: 'cancelled' }
  if (latest?.id !== id || typeof latest.title !== 'string') throw new TitleSaveError()
  if (latest.title === title) return { status: 'saved', title }
  if (latest.title !== expected) return { status: 'conflict', title: latest.title }
  throw new TitleSaveError()
}

/** 每项独立保留编辑快照和保存任务，旧任务不能关闭新编辑器或借用其草稿。 */
export function createConversationRenaming({
  find,
  patch,
  getConversation,
  apply,
  warn,
  confirm,
  unavailable,
}) {
  const active = ref(null)
  const drafts = new Map()
  const pending = new Set()
  let nextKey = 0
  let disposed = false
  const cancelled = (session) => disposed || session.invalidated || unavailable(session.id)

  function close(session) {
    if (drafts.get(session.id) === session) drafts.delete(session.id)
    if (active.value === session) active.value = null
  }

  function start(id) {
    if (disposed || unavailable(id)) return null
    const conversation = find(id)
    if (!conversation) return null
    if (active.value && active.value.id !== id) save(active.value.id, active.value.key)
    let session = drafts.get(id)
    if (!session) {
      session = reactive({
        id,
        key: ++nextKey,
        text: conversation.title,
        base: conversation.title,
        saving: false,
        task: null,
        conflict: false,
        cancelled: false,
      })
      drafts.set(id, session)
    }
    active.value = session
    return session
  }

  async function run(session, title) {
    try {
      if (session.conflict) {
        const ok = await confirm(
          '标题已在其他位置修改。\n\n最新标题：' + session.base + '\n\n是否用你的编辑覆盖？',
          { okText: '覆盖保存', cancelText: '返回编辑' },
        )
        if (!ok || cancelled(session) || session.cancelled) return
      }
      const result = await saveConversationTitle({
        id: session.id,
        title,
        expected: session.base,
        patch,
        getConversation: (id) => {
          session.verification = new AbortController()
          return getConversation(id, session.verification.signal)
        },
        isCancelled: () => cancelled(session),
      })
      if (cancelled(session) || result.status === 'cancelled') return
      apply(session.id, result.title)
      session.base = result.title
      session.conflict = result.status === 'conflict'
      if (session.cancelled) return
      if (session.conflict) warn('标题已在其他位置修改，编辑草稿已保留；再次保存可确认是否覆盖。')
      else if (session.text.trim() === title) close(session)
    } catch (error) {
      if (!cancelled(session) && !session.cancelled) {
        console.warn('保存对话标题未获确认，异常类型：', error.name)
        warn(error instanceof TitleSaveError ? error.message : new TitleSaveError().message)
      }
    } finally {
      session.verification = null
      session.saving = false
      session.task = null
      pending.delete(session)
    }
  }

  function save(id, key) {
    const session = drafts.get(id)
    if (
      !session ||
      disposed ||
      unavailable(id) ||
      (key !== undefined && String(session.key) !== String(key))
    )
      return Promise.resolve()
    if (session.saving) return session.task
    const title = session.text.trim()
    if (!title || (!session.conflict && title === session.base)) {
      close(session)
      return Promise.resolve()
    }
    session.saving = true
    pending.add(session)
    session.task = run(session, title)
    return session.task
  }

  function cancel(key) {
    const session = active.value
    if (!session || (key !== undefined && String(session.key) !== String(key))) return
    session.cancelled = true
    close(session)
  }

  function forget(id) {
    for (const session of new Set([...drafts.values(), ...pending])) {
      if (session.id !== id) continue
      session.invalidated = true
      session.cancelled = true
      session.verification?.abort()
      close(session)
    }
  }

  function dispose() {
    disposed = true
    for (const session of new Set([...drafts.values(), ...pending])) forget(session.id)
  }

  return { active, start, save, cancel, forget, dispose }
}
