import { createRegenerationProgress } from './regenerationProgress.js'
import { hasMessageIdentity, resolveSavedMessage } from './messageIdentity.js'
import { contractSource, contractInstruction, contractBlocks } from '../utils/contractMetadata.js'

/** 合同重跑只在收到保存确认后更新目标对象，不操作当前页面的草稿或消息数组。 */
export class ContractRegenerationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ContractRegenerationError'
  }
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
  const instruction = contractInstruction(target)
  const blocks = contractBlocks(target)
  const blockSnapshot = JSON.stringify(blocks)
  if (!source.trim()) {
    throw new ContractRegenerationError('此记录未保存合同原文，请重新上传原文件；原报告已保留。')
  }
  const index = messages.indexOf(target)
  const content = target.content
  const originalIdentity = { id: target.id, revision: target.revision }
  if (index < 0 || target.role !== 'assistant') {
    throw new ContractRegenerationError('目标报告已移除，请刷新会话后重试。')
  }
  let identity = originalIdentity
  if (signal?.aborted) return { status: 'aborted' }
  if (!hasMessageIdentity(identity)) {
    try {
      // 与编辑、删除及普通重跑共用核实边界，不能为合同另按相同正文猜测身份。
      identity = await resolveSavedMessage(convId, target, messages, (id) =>
        getConversation(id, signal),
      )
    } catch {
      if (signal?.aborted) return { status: 'aborted' }
      throw new ContractRegenerationError('无法确认目标合同报告，请刷新会话后重试。')
    }
  }
  if (signal?.aborted) return { status: 'aborted' }
  const unchanged = () =>
    messages.includes(target) &&
    target.id === originalIdentity.id &&
    target.revision === originalIdentity.revision &&
    target.content === content &&
    contractSource(target) === source &&
    contractInstruction(target) === instruction &&
    JSON.stringify(contractBlocks(target)) === blockSnapshot
  if (!unchanged()) throw new ContractRegenerationError('页面中的原报告已变更，请刷新后重试。')

  const progress = createRegenerationProgress({ onSteps })
  await stream(convId, identity.id, identity.revision, signal, progress.callbacks)
  const { terminal, failure } = progress
  if (terminal?.aborted || (!terminal && signal?.aborted)) return { status: 'aborted' }
  if (failure) {
    throw new ContractRegenerationError(failure + ' 页面暂保留原报告，可刷新会话确认最新结果。')
  }
  if (
    terminal?.saved !== true ||
    terminal.message_id !== identity.id ||
    !hasMessageIdentity({
      id: terminal.message_id,
      revision: terminal.revision,
    }) ||
    terminal.raw_text !== source ||
    (terminal.instruction ?? '') !== instruction ||
    JSON.stringify(terminal.document_blocks ?? null) !== blockSnapshot ||
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
    ...(instruction ? { instruction } : {}),
    ...(blocks !== null ? { document_blocks: blocks } : {}),
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
