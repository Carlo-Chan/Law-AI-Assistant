/** 合同重跑只在收到保存确认后更新目标对象，不操作当前页面的草稿或消息数组。 */
export class ContractRegenerationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ContractRegenerationError'
  }
}

export function contractSource(message) {
  let data = message.contractData ?? message.contract_data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      data = null
    }
  }
  const source = data?.raw_text ?? message.contractRawText
  return typeof source === 'string' ? source : ''
}

function hasIdentity(message) {
  return Number.isInteger(message.id) && message.id > 0 && /^[0-9a-f]{64}$/.test(message.revision)
}

/** 新生成的消息尚无 ID 时，只允许按完整一致的消息顺序对齐，不能猜测相同报告。 */
function resolveTarget(snapshot, index, savedMessages) {
  if (
    !Array.isArray(savedMessages) ||
    savedMessages.length !== snapshot.length ||
    !snapshot.every(
      (message, position) =>
        message.role === savedMessages[position].role &&
        message.content === savedMessages[position].content,
    )
  ) {
    throw new ContractRegenerationError('报告尚未保存或记录已变更，请稍后刷新会话后重试。')
  }
  const target = savedMessages[index]
  if (!target || !hasIdentity(target) || contractSource(target) !== snapshot[index].source) {
    throw new ContractRegenerationError('无法确认目标合同报告，请刷新会话后重试。')
  }
  return target
}

export async function regenerateContractReport({
  convId,
  target,
  messages,
  getConversation,
  stream,
  signal,
  onSteps = () => {},
}) {
  const source = contractSource(target)
  if (!source.trim()) {
    throw new ContractRegenerationError('此记录未保存合同原文，请重新上传原文件；原报告已保留。')
  }
  const snapshot = messages.map((message) => ({
    role: message.role,
    content: message.content,
    source: contractSource(message),
  }))
  const index = messages.indexOf(target)
  const content = target.content
  if (index < 0 || target.role !== 'assistant') {
    throw new ContractRegenerationError('目标报告已移除，请刷新会话后重试。')
  }
  let identity = { id: target.id, revision: target.revision }
  if (signal?.aborted) return { status: 'aborted' }
  if (!hasIdentity(identity)) {
    let saved
    try {
      saved = await getConversation(convId, signal)
    } catch {
      if (signal?.aborted) return { status: 'aborted' }
      throw new ContractRegenerationError('暂时无法读取已保存的报告，请稍后重试。')
    }
    identity = resolveTarget(snapshot, index, saved.messages)
  }
  if (signal?.aborted) return { status: 'aborted' }
  const unchanged = () => target.content === content && contractSource(target) === source
  if (!unchanged()) throw new ContractRegenerationError('页面中的原报告已变更，请刷新后重试。')

  const steps = []
  let terminal = null
  let failure = ''
  await stream(convId, identity.id, identity.revision, signal, {
    onThinking(label) {
      steps.push({ type: 'tool', label })
      onSteps([...steps])
    },
    onReasoning(text) {
      if (steps.at(-1)?.type === 'reasoning') steps.at(-1).label = text
      else steps.push({ type: 'reasoning', label: text })
      onSteps([...steps])
    },
    onReasoningToken(text) {
      if (steps.at(-1)?.type !== 'reasoning') steps.push({ type: 'reasoning', label: '' })
      steps.at(-1).label += text
      onSteps([...steps])
    },
    onToolChunk(tool, text, first) {
      if (first) steps.push({ type: 'done', label: tool + ' 完成', snippet: text })
      else if (steps.at(-1)?.type === 'done') steps.at(-1).snippet += text
      onSteps([...steps])
    },
    onToolResult(tool, output) {
      steps.push({ type: 'done', label: tool + ' 完成', snippet: output })
      onSteps([...steps])
    },
    onDone(event) {
      if (!terminal && !failure) terminal = event
    },
    onError(message) {
      if (!terminal && !failure) failure = typeof message === 'string' ? message : '重新审查失败。'
    },
  })
  if (terminal?.aborted || (!terminal && signal?.aborted)) return { status: 'aborted' }
  if (failure) {
    throw new ContractRegenerationError(failure + ' 页面暂保留原报告，可刷新会话确认最新结果。')
  }
  if (
    terminal?.saved !== true ||
    terminal.message_id !== identity.id ||
    !hasIdentity({
      id: terminal.message_id,
      revision: terminal.revision,
    }) ||
    terminal.raw_text !== source ||
    typeof terminal.chat_reply !== 'string' ||
    !terminal.chat_reply.trim() ||
    !Array.isArray(terminal.risk_points) ||
    !Array.isArray(terminal.thinking_chain)
  ) {
    throw new ContractRegenerationError(
      '未收到完整保存确认，页面暂保留原报告；请刷新会话确认最新结果。',
    )
  }
  if (!unchanged()) {
    throw new ContractRegenerationError(
      '页面中的报告已变更，本次未覆盖页面内容；请刷新确认服务器结果。',
    )
  }
  const data = {
    raw_text: source,
    chat_reply: terminal.chat_reply,
    risk_points: terminal.risk_points,
  }
  Object.assign(target, {
    id: terminal.message_id,
    revision: terminal.revision,
    content: terminal.chat_reply,
    fullContent: terminal.chat_reply,
    contractData: data,
    contractRawText: source,
    contractRiskPoints: terminal.risk_points,
    thinkingChain: terminal.thinking_chain,
    thinkingExpanded: false,
  })
  return { status: 'completed' }
}
