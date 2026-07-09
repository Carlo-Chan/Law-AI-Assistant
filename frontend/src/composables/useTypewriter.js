/**
 * 打字机队列 composable
 *
 * 管理 LLM 回复的逐字输出效果。每条消息维护独立的定时器队列，
 * 避免多条消息的输出互相干扰。
 */

const typewriters = new WeakMap()

/**
 * 将文本片段追加到打字机队列，逐字输出到消息对象
 *
 * @param {object} msg  消息对象（需要是 Vue 响应式 Proxy）
 * @param {string} chunk  待输出的文本片段
 * @param {function} isActiveFn  判断当前对话是否处于活跃状态的函数
 * @param {function} scrollToBottom  滚动到底部的函数
 */
export function appendToTypewriter(msg, chunk, isActiveFn, scrollToBottom) {
  if (msg.content === '<span class="loading-dots">…</span>') {
    msg.content = ''
  }
  if (typeof msg.fullContent !== 'string') {
    msg.fullContent = msg.content || ''
  }
  msg.fullContent += chunk

  let tw = typewriters.get(msg)
  if (!tw) {
    tw = { queue: '', timer: null }
    typewriters.set(msg, tw)
  }
  tw.queue += chunk

  if (!tw.timer) {
    tw.timer = setInterval(() => {
      if (tw.queue.length > 0) {
        let chars = 1
        if (tw.queue.length > 200) chars = 10
        else if (tw.queue.length > 50) chars = 4
        else if (tw.queue.length > 20) chars = 2

        msg.content += tw.queue.slice(0, chars)
        tw.queue = tw.queue.slice(chars)

        if (isActiveFn && isActiveFn()) {
          scrollToBottom()
        }
      } else {
        clearInterval(tw.timer)
        tw.timer = null
      }
    }, 30)
  }
}

/**
 * 立即清空打字机队列，将所有未输出的内容一次性输出
 *
 * @param {object} msg  消息对象
 */
export function flushTypewriter(msg) {
  const tw = typewriters.get(msg)
  if (tw) {
    if (tw.timer) clearInterval(tw.timer)
    if (typeof msg.fullContent === 'string') {
      msg.content = msg.fullContent
    }
    typewriters.delete(msg)
  }
}
