/** 同类读取只保留最后一次；取消子读取不能反向中止所属生成请求。 */
export function createLatestRead() {
  let current = null
  let disposed = false

  function release(request) {
    request?.unlink?.()
    if (request) request.unlink = null
  }

  function cancel(key) {
    if (key !== undefined && current?.key !== key) return false
    const previous = current
    current = null
    release(previous)
    previous?.controller.abort()
    return !!previous
  }

  function begin({ signal: parentSignal, key } = {}) {
    if (disposed || parentSignal?.aborted) return null
    cancel()
    const controller = new AbortController()
    const request = { key, controller, signal: controller.signal, unlink: null }
    if (parentSignal) {
      const onAbort = () => {
        controller.abort()
        release(request)
      }
      parentSignal.addEventListener('abort', onAbort, { once: true })
      request.unlink = () => parentSignal.removeEventListener('abort', onAbort)
    }
    current = request
    return request
  }

  const isCurrent = (request) =>
    !!request && !disposed && current === request && !request.signal.aborted

  function finish(request) {
    release(request)
    if (current === request) current = null
  }

  function dispose() {
    disposed = true
    cancel()
  }

  return { begin, isCurrent, finish, cancel, dispose }
}
