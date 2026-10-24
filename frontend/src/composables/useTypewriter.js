/** 每个页面实例独立管理逐字任务；释放动画不取消网络请求或改变保存语义。 */
export function createTypewriterScope() {
  const typewriters = new Map()
  let disposed = false

  /** 停止指定消息的动画，并补齐已经收到但尚未展示的文字。 */
  function flushTypewriter(msg) {
    const task = typewriters.get(msg)
    if (!task) return
    if (task.timer !== null) clearInterval(task.timer)
    typewriters.delete(msg)
    if (typeof msg.fullContent === 'string') msg.content = msg.fullContent
  }

  /** 活跃消息逐字显示；后台或组件卸载后的片段直接补齐，不重建定时器。 */
  function appendToTypewriter(msg, chunk, isActiveFn, scrollToBottom) {
    if (!chunk) return
    if (msg.content === '<span class="loading-dots">…</span>') msg.content = ''
    if (typeof msg.fullContent !== 'string') msg.fullContent = msg.content || ''
    msg.fullContent += chunk
    if (disposed || (isActiveFn && !isActiveFn())) {
      flushTypewriter(msg)
      msg.content = msg.fullContent
      return
    }

    let task = typewriters.get(msg)
    if (!task) {
      task = { queue: '', timer: null }
      typewriters.set(msg, task)
    }
    task.queue += chunk
    if (task.timer !== null) return
    task.timer = setInterval(() => {
      // 已取消的旧回调不能改写同一消息后来新建的队列。
      if (typewriters.get(msg) !== task) return
      if (disposed || (isActiveFn && !isActiveFn())) {
        flushTypewriter(msg)
        return
      }
      let chars = 1
      if (task.queue.length > 200) chars = 10
      else if (task.queue.length > 50) chars = 4
      else if (task.queue.length > 20) chars = 2
      msg.content += task.queue.slice(0, chars)
      task.queue = task.queue.slice(chars)
      if (!task.queue.length) flushTypewriter(msg)
      if (isActiveFn?.()) scrollToBottom?.()
    }, 30)
  }

  /** 只释放本页面的待显示任务，重复卸载也不会影响其他页面实例。 */
  function dispose() {
    disposed = true
    for (const msg of typewriters.keys()) flushTypewriter(msg)
  }

  return { appendToTypewriter, flushTypewriter, dispose }
}
