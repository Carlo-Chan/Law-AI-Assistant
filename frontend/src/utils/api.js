/**
 * 后端 API 封装
 *
 * 重构要点：
 * - 统一委托 readSSEStream 处理咨询、审查与合同重新生成的流式生命周期
 */
import axios from 'axios'
import { readSSEStream } from './sse.js'
import { normalizeContractInstruction } from './contractInstruction.js'

const api = axios.create({
  baseURL: '/api',
  timeout: 180000,
})

/** 法律咨询 */
export async function chat(query, history = []) {
  const { data } = await api.post('/chat', { query, history })
  return data.data
}

/** 合同审查（上传文件） */
export async function analyzeContract(file, instruction = '') {
  instruction = normalizeContractInstruction(instruction)
  const formData = new FormData()
  formData.append('file', file)
  if (instruction) formData.append('instruction', instruction)
  const { data } = await api.post('/analyze_contract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data.data
}

/** 获取会话列表 */
export async function listConversations(signal) {
  const { data } = await api.get('/conversations', { signal })
  return data.data
}

/** 创建新会话 */
export async function createConversation(signal) {
  const { data } = await api.post('/conversations', undefined, { signal })
  return data.data
}

/** 获取会话详情（含消息） */
export async function getConversation(id, signal) {
  const { data } = await api.get(`/conversations/${id}`, { signal })
  return data.data
}

/** 删除会话 */
export async function deleteConversation(id) {
  const { data } = await api.delete(`/conversations/${id}`)
  return data.data
}

/** 保存消息到会话 */
export async function saveMessages(
  convId,
  userContent,
  assistantContent,
  fileName = null,
  contractData = null,
  thinkingChain = null,
) {
  const { data } = await api.post(`/conversations/${convId}/messages`, {
    user_content: userContent,
    assistant_content: assistantContent,
    file_name: fileName,
    contract_data: contractData,
    thinking_chain: thinkingChain,
  })
  return data.data
}

/** 按稳定身份删除一条消息，不重建其余历史记录。 */
export async function deleteSavedMessage(convId, messageId, revision, preserveEmpty = false) {
  const { data } = await api.delete(
    `/conversations/${encodeURIComponent(convId)}/messages/${messageId}`,
    {
      data: { expected_revision: revision, preserve_empty_conversation: preserveEmpty },
    },
  )
  return data.data
}

/** 只保存目标用户消息的正文，其他问答和附件不受影响。 */
export async function editSavedMessage(convId, messageId, revision, content) {
  const { data } = await api.patch(
    `/conversations/${encodeURIComponent(convId)}/messages/${messageId}`,
    {
      expected_revision: revision,
      content,
    },
  )
  return data.data
}

/** 更新会话标题 */
export async function updateConvTitle(convId, title, signal) {
  await api.post(`/conversations/${convId}/title`, { title }, { signal })
}

/** 保留旧重建接口的兼容封装，当前页面消息操作不再调用。 */
export async function rebuildMessages(convId, messages) {
  await api.post(`/conversations/${convId}/rebuild`, { messages })
}

/** 法律咨询流式接口 */
export async function chatStream(query, history, signal, callbacks) {
  return readSSEStream(
    '/api/chat/stream',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, history }),
    },
    signal,
    callbacks,
  )
}

/** 合同审查流式接口 */
export async function analyzeContractStream(file, signal, callbacks, instruction = '') {
  instruction = normalizeContractInstruction(instruction)
  const formData = new FormData()
  formData.append('file', file)
  if (instruction) formData.append('instruction', instruction)
  return readSSEStream(
    '/api/analyze_contract/stream',
    {
      method: 'POST',
      body: formData,
    },
    signal,
    callbacks,
  )
}

/** 原文重跑仅提交目标身份和版本，不重新上传附件或追加消息。 */
export async function regenerateContractStream(convId, messageId, revision, signal, callbacks) {
  return readSSEStream(
    `/api/conversations/${encodeURIComponent(convId)}/messages/${messageId}/regenerate_contract/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: revision }),
    },
    signal,
    callbacks,
  )
}

/** 普通咨询重跑由服务端读取历史并保存，只提交目标身份及预期版本。 */
export async function regenerateChatStream(convId, messageId, revision, signal, callbacks) {
  return readSSEStream(
    `/api/conversations/${encodeURIComponent(convId)}/messages/${messageId}/regenerate_chat/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: revision }),
    },
    signal,
    callbacks,
  )
}
