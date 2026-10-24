import { reactive } from 'vue'

export const LOADING_DOTS = '<span class="loading-dots">…</span>'

/** 每次发送持有独立的消息数组、历史快照和控制器，不在异步回调中读取当前页面。 */
export function createConversationRequests({
  currentKey,
  messages,
  thinkingSteps,
  loadingIds,
  controllers,
  cache,
}) {
  const isActive = (request) => currentKey() === request.key

  function publish(request) {
    cache.value = {
      ...cache.value,
      [request.key]: { messages: request.messages, thinkingSteps: [...request.steps] },
    }
    if (isActive(request)) thinkingSteps.value = [...request.steps]
  }

  function begin(convId, userMessage) {
    const key = currentKey()
    if (!key || loadingIds.value.has(key)) return null
    loadingIds.value.add(key)
    const ownedMessages = messages.value
    const request = {
      key,
      convId,
      userMessage: reactive(userMessage),
      messages: ownedMessages,
      history: ownedMessages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: message.content })),
      assistant: reactive({
        role: 'assistant',
        content: LOADING_DOTS,
        thinkingChain: [],
        thinkingExpanded: false,
      }),
      steps: [],
      controller: new AbortController(),
    }
    controllers.value[key] = request.controller
    ownedMessages.push(request.userMessage, request.assistant)
    publish(request)
    return request
  }

  function bind(request, convId) {
    const active = isActive(request)
    const previousKey = request.key
    loadingIds.value.delete(previousKey)
    delete controllers.value[previousKey]
    const remaining = { ...cache.value }
    delete remaining[previousKey]
    cache.value = remaining
    request.convId = convId
    request.key = convId
    loadingIds.value.add(convId)
    controllers.value[convId] = request.controller
    publish(request)
    return active
  }

  function finish(request) {
    if (controllers.value[request.key] !== request.controller) return
    loadingIds.value.delete(request.key)
    delete controllers.value[request.key]
    // 未确认保存的回复继续留在所属会话缓存，切换页面也能找回并复制。
    if (request.messages.some((message) => message.saveFailed)) {
      publish(request)
      return
    }
    const remaining = { ...cache.value }
    delete remaining[request.key]
    cache.value = remaining
  }

  function discard(request) {
    if (controllers.value[request.key] !== request.controller) return
    for (const message of [request.userMessage, request.assistant]) {
      const index = request.messages.indexOf(message)
      if (index >= 0) request.messages.splice(index, 1)
    }
    request.steps.length = 0
    publish(request)
  }

  return { begin, bind, publish, finish, discard, isActive }
}
