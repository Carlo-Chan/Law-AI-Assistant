import { contractSource, contractInstruction } from './contractRegeneration.js'

export function hasMessageIdentity(message) {
  return Number.isInteger(message?.id) && message.id > 0 && /^[0-9a-f]{64}$/.test(message.revision)
}

/** 仅采用本次保存接口的完整身份回执，不按当前页面或相同正文猜测身份。 */
export function assignSavedMessageIdentities(request, result) {
  const identities = result?.messages
  if (
    !Array.isArray(identities) ||
    identities.length !== 2 ||
    identities[0]?.role !== 'user' ||
    identities[1]?.role !== 'assistant' ||
    identities[0].id === identities[1].id ||
    !identities.every(hasMessageIdentity)
  )
    return false
  Object.assign(request.userMessage, { id: identities[0].id, revision: identities[0].revision })
  Object.assign(request.assistant, { id: identities[1].id, revision: identities[1].revision })
  return true
}

export function messageSnapshot(message) {
  return {
    role: message.role,
    content: message.content,
    fileName: message.file?.name || message.file_name || null,
    source: contractSource(message),
    instruction: contractInstruction(message),
  }
}

/** 兼容旧保存回执：只有整段已保存顺序和内容一致，才允许定位尚无 ID 的消息。 */
export async function resolveSavedMessage(convId, target, messages, getConversation) {
  if (hasMessageIdentity(target)) return { id: target.id, revision: target.revision }
  const snapshot = messages.map(messageSnapshot)
  const index = messages.indexOf(target)
  const saved = await getConversation(convId)
  if (
    index < 0 ||
    messages.indexOf(target) !== index ||
    JSON.stringify(messages.map(messageSnapshot)) !== JSON.stringify(snapshot) ||
    !Array.isArray(saved?.messages) ||
    saved.messages.length !== snapshot.length ||
    !saved.messages.every(
      (message, position) =>
        JSON.stringify(messageSnapshot(message)) === JSON.stringify(snapshot[position]),
    ) ||
    !hasMessageIdentity(saved.messages[index])
  )
    throw new Error('无法确认消息的保存身份，请刷新会话后重试；本次未删除内容。')
  return { id: saved.messages[index].id, revision: saved.messages[index].revision }
}
