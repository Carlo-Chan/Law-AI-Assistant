import { ref } from 'vue'

/** 只接收指定区域的文件拖放，并在整个页面阻止文件打开或导航。 */
export function createFileDrop({ isEnabled, onFile, onWarning, onBlocked }) {
  const active = ref(false)
  let target = null
  let ownerDocument = null
  let depth = 0
  let disposed = false

  function hasFiles(event) {
    const transfer = event.dataTransfer
    return (
      Array.from(transfer?.types || []).includes('Files') ||
      Array.from(transfer?.items || []).some((item) => item.kind === 'file') ||
      transfer?.files?.length > 0
    )
  }

  function contains(event) {
    return !!event.target && !!target?.contains(event.target)
  }

  function reset() {
    depth = 0
    active.value = false
  }

  function dragEnter(event) {
    if (!hasFiles(event)) return
    event.preventDefault()
    if (!contains(event) || !isEnabled()) return reset()
    depth += 1
    active.value = true
  }

  function dragOver(event) {
    if (!hasFiles(event)) return reset()
    event.preventDefault()
    const allowed = contains(event) && isEnabled()
    if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
    if (allowed) active.value = true
    else reset()
  }

  function dragLeave(event) {
    if (contains(event)) {
      depth = Math.max(0, depth - 1)
      if (depth === 0) reset()
    } else if (!event.relatedTarget) reset()
  }

  function drop(event) {
    reset()
    if (!hasFiles(event)) return
    event.preventDefault()
    if (!contains(event)) return
    if (!isEnabled()) return onBlocked()
    const transfer = event.dataTransfer
    try {
      const items = Array.from(transfer.items || [])
      if (items.some((item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)) {
        onWarning('暂不支持文件夹，请拖入单个合同文件。')
        return
      }
      const files = Array.from(transfer.files || [])
      if (files.length !== 1) {
        onWarning(
          files.length > 1
            ? '一次只能添加一个合同文件，请重新拖入。'
            : '未读取到文件，请重新拖入或点击添加附件。',
        )
        return
      }
      onFile(files[0])
    } catch {
      onWarning('未读取到文件，请重新拖入或点击添加附件。')
    }
  }

  function keyDown(event) {
    if (event.key === 'Escape') reset()
  }

  const listeners = { dragenter: dragEnter, dragover: dragOver, dragleave: dragLeave, drop }

  /** 更换挂载区域或卸载时成对撤销监听，不遗留阻止导航的全局处理器。 */
  function connect(element) {
    if (disposed || element === target) return
    if (ownerDocument) {
      for (const [name, handler] of Object.entries(listeners))
        ownerDocument.removeEventListener(name, handler, true)
      ownerDocument.removeEventListener('keydown', keyDown)
      ownerDocument.removeEventListener('visibilitychange', reset)
      ownerDocument.defaultView?.removeEventListener('blur', reset)
    }
    reset()
    target = element
    ownerDocument = element?.ownerDocument || null
    if (!ownerDocument) return
    for (const [name, handler] of Object.entries(listeners))
      ownerDocument.addEventListener(name, handler, true)
    ownerDocument.addEventListener('keydown', keyDown)
    ownerDocument.addEventListener('visibilitychange', reset)
    ownerDocument.defaultView?.addEventListener('blur', reset)
  }

  function dispose() {
    connect(null)
    disposed = true
  }

  return { active, connect, reset, dispose }
}
