const empty = (draft) => !draft.text && !draft.file
const same = (first, second) => first.text === second.text && first.file === second.file

/** 失败草稿仅保存在内存；已有更新内容时排队，不拼接文字或替换附件。 */
export function createDraftRecovery({ read, write, canRestore = () => true }) {
  const pending = []

  function recover(owner, draft) {
    const snapshot = { text: draft.text, file: draft.file }
    if (canRestore(owner)) {
      const current = read(owner)
      if (empty(current)) {
        write(owner, snapshot)
        return 'restored'
      }
      if (same(current, snapshot)) return 'restored'
    }
    pending.push({ owner, draft: snapshot })
    return 'queued'
  }

  function resume(owner) {
    if (!canRestore(owner)) return false
    const index = pending.findIndex((entry) => entry.owner === owner)
    if (index < 0) return false
    const current = read(owner)
    const entry = pending[index]
    if (!empty(current) && !same(current, entry.draft)) return false
    if (empty(current)) write(owner, entry.draft)
    pending.splice(index, 1)
    return true
  }

  /** 会话确认删除后释放其待恢复草稿，不触及其他会话。 */
  function forget(owner) {
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index].owner === owner) pending.splice(index, 1)
    }
  }

  return { recover, resume, forget }
}
