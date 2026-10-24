/** 只测量当前消息容器，尺寸和内容变化不依赖用户再滚动一次。 */
export function createMessageScroll({
  onChange,
  Resize = globalThis.ResizeObserver,
  Mutation = globalThis.MutationObserver,
  requestFrame = globalThis.requestAnimationFrame,
  cancelFrame = globalThis.cancelAnimationFrame,
}) {
  let container = null
  let resize = null
  let mutation = null
  let frame = null
  let version = 0
  let disposed = false
  const rows = new Set()

  function sync() {
    const visible =
      !disposed &&
      container &&
      container.clientHeight > 0 &&
      container.scrollHeight - container.scrollTop - container.clientHeight > 100
    onChange(!!visible)
  }

  function schedule() {
    if (disposed || !container || frame !== null) return
    if (!requestFrame) {
      sync()
      return
    }
    const owner = version
    frame = requestFrame(() => {
      if (owner !== version || disposed) return
      frame = null
      sync()
    })
  }

  function observeRows() {
    if (!resize) return
    const current = new Set(container.children)
    for (const row of rows) {
      if (current.has(row)) continue
      resize.unobserve(row)
      rows.delete(row)
    }
    for (const row of current) {
      if (rows.has(row)) continue
      resize.observe(row)
      rows.add(row)
    }
  }

  function disconnect() {
    version++
    if (frame !== null) cancelFrame?.(frame)
    frame = null
    resize?.disconnect()
    mutation?.disconnect()
    resize = null
    mutation = null
    rows.clear()
  }

  function connect(element) {
    disconnect()
    container = disposed ? null : element
    if (container?.nodeType === 1) {
      const owner = version
      if (Resize) {
        resize = new Resize(() => {
          if (owner === version) schedule()
        })
        resize.observe(container)
        observeRows()
      }
      if (Mutation) {
        mutation = new Mutation(() => {
          if (owner !== version) return
          observeRows()
          schedule()
        })
        mutation.observe(container, { childList: true })
      }
    }
    sync()
  }

  function toBottom() {
    if (!disposed && container) container.scrollTop = container.scrollHeight
    sync()
  }

  function dispose() {
    disposed = true
    disconnect()
    container = null
    sync()
  }

  return { connect, sync, toBottom, dispose }
}
