export const SSE_IDLE_TIMEOUT_MS = 180_000
export const SSE_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const HTTP_ERROR_MAX_BODY_BYTES = 64 * 1024
const DECODE_CHUNK_BYTES = 16 * 1024

export class StreamCallbackError extends Error {
  constructor() {
    super('回复处理未完成，请保留页面内容并刷新会话确认。')
    this.name = 'StreamCallbackError'
  }
}

class StreamProtocolError extends Error {}
class StreamInterrupted extends Error {}
class StreamLimitError extends Error {}

const fields = {
  thinking: ['label'],
  thinking_reasoning: ['content'],
  thinking_reasoning_token: ['content'],
  tool_result_chunk: ['tool', 'content'],
  tool_result_end: ['tool'],
  tool_result: ['tool', 'output'],
  token: ['content'],
  done: [],
  error: ['message'],
}

/** 应用 SSE 协议：首次终止后停止读取，并等待对应回调完成，不能将本地保存失败当作断网。 */
export async function readSSEStream(
  url,
  options,
  signal,
  callbacks = {},
  {
    idleTimeoutMs = SSE_IDLE_TIMEOUT_MS,
    maxFrameBytes = SSE_MAX_FRAME_BYTES,
    maxErrorBodyBytes = HTTP_ERROR_MAX_BODY_BYTES,
  } = {},
) {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0)
    throw new RangeError('单个 SSE 事件大小上限必须为正整数。')
  if (!Number.isSafeInteger(maxErrorBodyBytes) || maxErrorBodyBytes <= 0)
    throw new RangeError('HTTP 错误响应体大小上限必须为正整数。')
  const transport = new AbortController()
  let reader
  let body
  let terminal = null
  let interruption = null
  let timer
  let cancelTask
  let rejectInterruption
  const interrupted = new Promise((_resolve, reject) => {
    rejectInterruption = reject
  })
  // 取消可能发生在等待本地回调期间，此时暂时没有读取任务接管拒绝。
  interrupted.catch(() => {})
  function interrupt(kind) {
    if (interruption || terminal) return
    interruption = kind
    rejectInterruption(new StreamInterrupted())
    transport.abort()
  }
  const onAbort = () => interrupt('aborted')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  async function waitIO(operation) {
    if (interruption) throw new StreamInterrupted()
    // 只计算等待响应头或下一批字节的空闲时间，不计入本地回调和数据库保存耗时。
    if (idleTimeoutMs > 0) timer = setTimeout(() => interrupt('timeout'), idleTimeoutMs)
    try {
      return await Promise.race([operation(), interrupted])
    } finally {
      clearTimeout(timer)
    }
  }

  function stopTransport() {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    transport.abort()
    if (!cancelTask) {
      cancelTask = Promise.resolve()
        .then(() => (reader ? reader.cancel() : body && !body.locked ? body.cancel() : undefined))
        .catch((error) => {
          console.warn('释放响应流失败，异常类型：', error.name)
        })
    }
  }

  async function invoke(callback, ...args) {
    try {
      return await callback?.(...args)
    } catch {
      throw new StreamCallbackError()
    }
  }

  async function finish(status, payload, details) {
    if (terminal) return
    terminal = status
    stopTransport()
    if (status === 'error') await invoke(callbacks.onError, payload, details)
    else await invoke(callbacks.onDone, payload)
  }

  let buffer = ''
  let data = []
  let frameBytes = 0
  let skipLF = false
  const encoder = new TextEncoder()

  function append(text) {
    // 按行内容累计 UTF-8 字节，包含注释和未知字段，不能靠心跳绕过未结束事件的限制。
    const size = encoder.encode(text).byteLength
    if (frameBytes + size > maxFrameBytes) throw new StreamLimitError()
    frameBytes += size
    buffer += text
  }

  async function dispatch() {
    if (interruption && !terminal) throw new StreamInterrupted()
    if (!data.length || terminal) return
    let event
    try {
      event = JSON.parse(data.join('\n'))
    } catch {
      throw new StreamProtocolError()
    }
    data = []
    if (
      !event ||
      Array.isArray(event) ||
      typeof event.type !== 'string' ||
      !Object.hasOwn(fields, event.type) ||
      fields[event.type].some((field) => typeof event[field] !== 'string') ||
      (event.type === 'error' && !event.message.trim()) ||
      (event.type === 'tool_result_chunk' &&
        event.first !== undefined &&
        typeof event.first !== 'boolean')
    ) {
      throw new StreamProtocolError()
    }
    switch (event.type) {
      case 'done':
        await finish('completed', event)
        break
      case 'error':
        await finish('error', event.message, { kind: 'server', code: event.code })
        break
      case 'thinking':
        await invoke(callbacks.onThinking, event.label)
        break
      case 'thinking_reasoning':
        await invoke(callbacks.onReasoning, event.content)
        break
      case 'thinking_reasoning_token':
        await invoke(callbacks.onReasoningToken, event.content)
        break
      case 'tool_result_chunk':
        await invoke(callbacks.onToolChunk, event.tool, event.content, event.first)
        break
      case 'tool_result':
        await invoke(callbacks.onToolResult, event.tool, event.output)
        break
      case 'token':
        await invoke(callbacks.onToken, event.content)
        break
    }
  }

  async function line(text) {
    if (text === '') {
      await dispatch()
      return
    }
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    let value = colon < 0 ? '' : text.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
  }

  async function feed(text, final = false) {
    let start = 0
    if (skipLF && text.length) {
      if (text[0] === '\n') start = 1
      skipLF = false
    }
    // 仅扫描本批新文本，不反复扫描已累计的长行；CRLF 跨分包时仍只算一次换行。
    for (let index = start; index < text.length && !terminal; index++) {
      if (interruption) throw new StreamInterrupted()
      if (text[index] !== '\r' && text[index] !== '\n') continue
      append(text.slice(start, index))
      const textLine = buffer
      buffer = ''
      if (textLine === '') frameBytes = 0
      if (text[index] === '\r') {
        if (text[index + 1] === '\n') index++
        else if (index === text.length - 1) skipLF = true
      }
      start = index + 1
      await line(textLine)
    }
    if (!terminal) append(text.slice(start))
    if (final && !terminal) {
      if (buffer) await line(buffer)
      buffer = ''
      await dispatch()
    }
  }

  // 错误响应单独限长，逐包复用空闲计时和读锁清理，不整包解析未知大小的网关错误页。
  async function readHttpError() {
    if (!body) return null
    reader = body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    let bytes = 0
    while (true) {
      const { done, value } = await waitIO(() => reader.read())
      if (interruption) throw new StreamInterrupted()
      if (done) return JSON.parse(text + decoder.decode())
      if (value.byteLength > maxErrorBodyBytes - bytes)
        throw new RangeError('HTTP 错误响应体超出读取上限')
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  }

  try {
    const response = await waitIO(() => fetch(url, { ...options, signal: transport.signal }))
    body = response.body
    if (!response.ok) {
      let message = `请求失败（HTTP ${response.status}）`
      try {
        const error = await readHttpError()
        if (typeof error?.detail === 'string' && error.detail.trim()) message = error.detail
      } catch (error) {
        if (error instanceof StreamInterrupted || interruption) throw error
        console.warn('读取请求错误响应失败，异常类型：', error.name)
      }
      await finish('error', message, { kind: 'http', status: response.status })
    } else {
      if (
        !body ||
        response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
          'text/event-stream'
      ) {
        throw new StreamProtocolError()
      }
      reader = body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      while (!terminal) {
        const { done, value } = await waitIO(() => reader.read())
        if (interruption) throw new StreamInterrupted()
        // 网络分包可能包含许多合法事件，分段解码而不是把整个分包误当作一个事件限长。
        for (
          let offset = 0;
          offset < (done ? 1 : value.byteLength) && !terminal;
          offset += DECODE_CHUNK_BYTES
        ) {
          let text
          try {
            text = done
              ? decoder.decode()
              : decoder.decode(value.subarray(offset, offset + DECODE_CHUNK_BYTES), {
                  stream: true,
                })
          } catch {
            throw new StreamProtocolError()
          }
          await feed(text, done)
        }
        if (done) {
          if (!terminal)
            await finish('error', '回复传输未完整结束，已接收内容暂保留，请稍后重试。', {
              kind: 'protocol',
            })
          break
        }
      }
    }
  } catch (error) {
    // 终止回调失败时直接交给调用方处理，不能再次触发错误保存或伪装为网络失败。
    if (terminal) throw error
    if (error instanceof StreamCallbackError) {
      await finish('error', error.message, { kind: 'processing' })
    } else if (error instanceof StreamLimitError) {
      await finish('error', '单次回复数据过大，已停止接收，请刷新会话核实结果。', {
        kind: 'limit',
      })
    } else if (error instanceof StreamProtocolError) {
      await finish('error', '回复数据格式异常，已接收内容暂保留，请稍后重试。', {
        kind: 'protocol',
      })
    } else if (interruption === 'timeout') {
      await finish('error', '等待回复数据超时，已接收内容暂保留，请稍后重试。', { kind: 'timeout' })
    } else if (interruption === 'aborted' || error.name === 'AbortError') {
      await finish('aborted', { aborted: true })
    } else {
      await finish('error', '网络连接中断，请检查网络后重试。', { kind: 'network' })
    }
  } finally {
    stopTransport()
    await cancelTask
    reader?.releaseLock()
  }
  return { status: terminal }
}
