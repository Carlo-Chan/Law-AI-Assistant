/**
 * 后端 API 封装
 */
import axios from 'axios'

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
export async function analyzeContract(file) {
  const formData = new FormData()
  formData.append('file', file)
  const { data } = await api.post('/analyze_contract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data.data
}

/** 获取会话列表 */
export async function listConversations() {
  const { data } = await api.get('/conversations')
  return data.data
}

/** 创建新会话 */
export async function createConversation() {
  const { data } = await api.post('/conversations')
  return data.data
}

/** 获取会话详情（含消息） */
export async function getConversation(id) {
  const { data } = await api.get(`/conversations/${id}`)
  return data.data
}

/** 删除会话 */
export async function deleteConversation(id) {
  const { data } = await api.delete(`/conversations/${id}`)
  return data.data
}
/** 保存消息到会话 */
export async function saveMessages(convId, userContent, assistantContent, fileName = null, contractData = null) {
  await api.post(`/conversations/${convId}/messages`, {
    user_content: userContent,
    assistant_content: assistantContent,
    file_name: fileName,
    contract_data: contractData,
  })
}

/** 更新会话标题 */
export async function updateConvTitle(convId, title) {
  await api.post(`/conversations/${convId}/title`, { title })
}

