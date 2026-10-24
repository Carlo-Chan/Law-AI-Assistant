/** 和后端保持相同的 Unicode 字符上限；不截断用户的审查重点。 */
export const MAX_CONTRACT_INSTRUCTION_CHARS = 4000

export function normalizeContractInstruction(instruction = '') {
  if (typeof instruction !== 'string') throw new TypeError('附加审查指令必须是文字。')
  const normalized = instruction.replace(/\r\n?/g, '\n').trim()
  if ([...normalized].length > MAX_CONTRACT_INSTRUCTION_CHARS) {
    throw new RangeError('附加审查指令不能超过 4000 字，请缩短后重试。')
  }
  return normalized
}
