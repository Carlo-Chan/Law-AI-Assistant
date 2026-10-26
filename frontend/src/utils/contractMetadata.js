/** 从内存消息或持久化消息中读取同一份合同输入，不推测缺失的原文和指令。 */
function contractData(message) {
  let data = message.contractData ?? message.contract_data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      data = null
    }
  }
  return data
}

export function contractSource(message) {
  const source = contractData(message)?.raw_text ?? message.contractRawText
  return typeof source === 'string' ? source : ''
}

export function contractInstruction(message) {
  const instruction = contractData(message)?.instruction
  return typeof instruction === 'string' ? instruction : ''
}

export function contractBlocks(message) {
  return contractData(message)?.document_blocks ?? null
}
