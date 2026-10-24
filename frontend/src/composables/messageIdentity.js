import { contractSource, contractInstruction } from '../utils/contractMetadata.js'

function hasMessageId(message) {
  return Number.isInteger(message?.id) && message.id > 0
}

export function hasMessageIdentity(message) {
  return hasMessageId(message) && /^[0-9a-f]{64}$/.test(message.revision)
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
    // 只有用户消息持久化附件名，助手消息的 file 只是报告展示所用的镜像。
    fileName: message.role === 'user' ? message.file?.name || message.file_name || null : null,
    source: contractSource(message),
    instruction: contractInstruction(message),
  }
}

function identitySnapshot(message) {
  return { id: message.id, revision: message.revision }
}

/** 保存身份未获确认时，只有整段已保存顺序和内容一致，才允许定位尚无 ID 的消息。 */
export async function resolveSavedMessage(convId, target, messages, getConversation) {
  if (hasMessageIdentity(target)) return { id: target.id, revision: target.revision }
  const snapshot = messages.map(messageSnapshot)
  const identities = messages.map(identitySnapshot)
  const index = messages.indexOf(target)
  const saved = await getConversation(convId)
  if (
    index < 0 ||
    messages.indexOf(target) !== index ||
    JSON.stringify(messages.map(messageSnapshot)) !== JSON.stringify(snapshot) ||
    JSON.stringify(messages.map(identitySnapshot)) !== JSON.stringify(identities) ||
    saved?.id !== convId ||
    !Array.isArray(saved?.messages) ||
    saved.messages.length !== snapshot.length ||
    !saved.messages.every(
      (message, position) =>
        hasMessageIdentity(message) &&
        ['user', 'assistant'].includes(message.role) &&
        JSON.stringify(messageSnapshot(message)) === JSON.stringify(snapshot[position]) &&
        (!hasMessageId(identities[position]) || message.id === identities[position].id) &&
        (!hasMessageIdentity(identities[position]) ||
          message.revision === identities[position].revision),
    ) ||
    new Set(saved.messages.map((message) => message.id)).size !== saved.messages.length
  )
    throw new Error('无法确认消息的保存身份，请重新读取会话后重试；本次未修改内容。')
  return { id: saved.messages[index].id, revision: saved.messages[index].revision }
}
