/**
 * 后端 API 封装
 *
 * 重构要点：
 * - 抽取 _readSSEStream 公共函数，消除 chatStream / analyzeContractStream 的重复 SSE 读取逻辑
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
export async function saveMessages(
  convId,
  userContent,
  assistantContent,
  fileName = null,
  contractData = null,
  thinkingChain = null,
) {
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

/** 重建会话消息（用于删除单条消息后同步） */
export async function rebuildMessages(convId, messages) {
  await api.post(`/conversations/${convId}/rebuild`, { messages })
}

/**
 * 公共 SSE 流式读取函数
 *
 * 向指定 URL 发送请求，读取 SSE 响应流，按事件类型分发到对应回调。
 * 支持 AbortSignal 中断生成。
 *
 * @param {string} url  SSE 端点 URL
 * @param {RequestInit} fetchOptions  fetch 请求选项（method/body/headers）
 * @param {AbortSignal} signal  中断信号
 * @param {object} callbacks  事件回调集合
 */
async function _readSSEStream(
  url,
  fetchOptions,
  signal,
  {
    onThinking,
    onReasoning,
    onReasoningToken,
    onToolChunk,
    onToolResult,
    onToken,
    onDone,
    onError,
  },
) {
  try {
    const res = await fetch(url, { ...fetchOptions, signal })
    if (!res.ok) {
      let message = `请求失败（HTTP ${res.status}）`
      try {
        const error = await res.json()
        if (typeof error.detail === 'string') message = error.detail
      } catch (error) {
        console.warn('读取请求错误响应失败，异常类型：', error.name)
      }
      onError?.(message)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const evt = JSON.parse(line.slice(6))
            switch (evt.type) {
              case 'thinking':
                onThinking?.(evt.label)
                break
              case 'thinking_reasoning':
                onReasoning?.(evt.content)
                break
              case 'thinking_reasoning_token':
                await onReasoningToken?.(evt.content)
                break
              case 'tool_result_chunk':
                onToolChunk?.(evt.tool, evt.content, evt.first)
                break
              case 'tool_result_end':
                break
              case 'tool_result':
                onToolResult?.(evt.tool, evt.output)
                break
              case 'token':
                await onToken?.(evt.content)
                break
              case 'done':
                onDone?.(evt)
                break
              case 'error':
                onError?.(evt.message)
                break
            }
          } catch (error) {
            console.warn('处理流式事件失败，异常类型：', error.name)
          }
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      onDone?.({ aborted: true })
    } else {
      onError?.('网络连接中断，请检查网络后重试。')
    }
  }
}

/** 法律咨询流式接口 */
export async function chatStream(query, history, signal, callbacks) {
  return _readSSEStream(
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
export async function analyzeContractStream(file, signal, callbacks) {
  const formData = new FormData()
  formData.append('file', file)
  return _readSSEStream(
    '/api/analyze_contract/stream',
    {
      method: 'POST',
      body: formData,
    },
    signal,
    callbacks,
  )
}
