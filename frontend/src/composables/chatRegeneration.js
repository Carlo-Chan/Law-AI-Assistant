import { hasMessageIdentity, resolveSavedMessage } from './messageIdentity.js'
import { createRegenerationProgress } from './regenerationProgress.js'

export class ChatRegenerationError extends Error {
  constructor(message = '重新生成未完成，原回复已保留；请重新读取会话确认最新结果。') {
    super(message)
    this.name = 'ChatRegenerationError'
  }
}

/** 保存正文只在完整身份回执通过后替换，临时预览和失败内容都不覆盖旧回复。 */
export async function regenerateChatReply({
  convId,
  target,
  messages,
  getConversation,
  stream,
  signal,
  onSteps = () => {},
  onToken = () => {},
}) {
  const index = messages.indexOf(target)
  const user = messages[index - 1]
  if (index < 1 || target.role !== 'assistant' || user?.role !== 'user' || user.file)
    throw new ChatRegenerationError('此回复缺少可用的普通咨询问题，原回复已保留。')
  const original = {
    content: target.content,
    revision: target.revision,
    query: user.content,
    userRevision: user.revision,
  }
  const unchanged = () =>
    messages.includes(target) &&
    messages[messages.indexOf(target) - 1] === user &&
    target.content === original.content &&
    target.revision === original.revision &&
    user.content === original.query &&
    user.revision === original.userRevision
  if (signal?.aborted) return { status: 'aborted' }
  let identity
  try {
    identity = await resolveSavedMessage(convId, target, messages, (id) =>
      getConversation(id, signal),
    )
  } catch {
    if (signal?.aborted) return { status: 'aborted' }
    throw new ChatRegenerationError('暂时无法确认已保存回复的身份，原回复已保留，请重新读取会话。')
  }
  if (signal?.aborted) return { status: 'aborted' }
  if (!unchanged()) throw new ChatRegenerationError()
  const progress = createRegenerationProgress({ onSteps, onToken })
  await stream(convId, identity.id, identity.revision, signal, progress.callbacks)
  const { terminal, failure } = progress
  if (terminal?.aborted || (!terminal && signal?.aborted)) return { status: 'aborted' }
  if (failure) throw new ChatRegenerationError(failure + ' 原回复已保留，可重新读取会话确认。')
  if (
    terminal?.saved !== true ||
    terminal.message_id !== identity.id ||
    !hasMessageIdentity({ id: terminal.message_id, revision: terminal.revision }) ||
    !hasMessageIdentity({ id: terminal.source_message_id, revision: terminal.source_revision }) ||
    (hasMessageIdentity(user) && terminal.source_message_id !== user.id) ||
    typeof terminal.query !== 'string' ||
    !terminal.query.trim() ||
    typeof terminal.chat_reply !== 'string' ||
    !terminal.chat_reply.trim() ||
    !Array.isArray(terminal.thinking_chain) ||
    !unchanged()
  )
    throw new ChatRegenerationError()
  Object.assign(target, {
    id: terminal.message_id,
    revision: terminal.revision,
    content: terminal.chat_reply,
    fullContent: terminal.chat_reply,
    thinkingChain: terminal.thinking_chain,
    thinkingExpanded: false,
  })
  Object.assign(user, {
    id: terminal.source_message_id,
    revision: terminal.source_revision,
    content: terminal.query,
  })
  return { status: 'completed', user }
}
