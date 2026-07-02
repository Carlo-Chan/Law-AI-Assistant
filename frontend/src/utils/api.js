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
export async function saveMessages(convId, userContent, assistantContent, fileName = null, contractData = null, thinkingChain = null) {
  await api.post(`/conversations/${convId}/messages`, {
    user_content: userContent,
    assistant_content: assistantContent,
    file_name: fileName,
    contract_data: contractData,
    thinking_chain: thinkingChain,
  })
}

/** 更新会话标题 */
export async function updateConvTitle(convId, title) {
  await api.post(`/conversations/${convId}/title`, { title })
}
/** 保存问候语 */
export async function saveGreeting(convId, content) {
  await api.post(`/conversations/${convId}/greeting`, { content })
}



export async function chatStream(query, history, { onThinking, onToolResult, onToken, onDone, onError }) {
  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, history }),
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() || ""
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const evt = JSON.parse(line.slice(6))
            switch (evt.type) {
              case "thinking": onThinking?.(evt.label); break
              case "tool_result": onToolResult?.(evt.tool, evt.output); break
              case "token": onToken?.(evt.content); break
              case "done": onDone?.(evt); break
              case "error": onError?.(evt.message); break
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    onError?.(e.message || "Network error")
  }
}

export async function analyzeContractStream(file, { onThinking, onToolResult, onToken, onDone, onError }) {
  try {
    const formData = new FormData()
    formData.append("file", file)
    const res = await fetch("/api/analyze_contract/stream", {
      method: "POST",
      body: formData,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() || ""
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const evt = JSON.parse(line.slice(6))
            switch (evt.type) {
              case "thinking": onThinking?.(evt.label); break
              case "tool_result": onToolResult?.(evt.tool, evt.output); break
              case "token": onToken?.(evt.content); break
              case "done": onDone?.(evt); break
              case "error": onError?.(evt.message); break
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    onError?.(e.message || "Network error")
  }
}
