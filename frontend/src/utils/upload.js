/** 合同文件大小上限，与后端 uploads.py 保持一致。 */
export const MAX_CONTRACT_FILE_BYTES = 10 * 1024 * 1024

const SUPPORTED_CONTRACT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt']
export const CONTRACT_FILE_ACCEPT = SUPPORTED_CONTRACT_EXTENSIONS.join(',')

/** 先确认真实附件及大小，再按后端支持的扩展名校验；文件内容仍由后端解析。 */
export function getContractUploadError(file) {
  if (!(file instanceof File)) return '原附件已不可用，请重新选择文件后发送审查请求。'
  if (file.size > MAX_CONTRACT_FILE_BYTES) return '合同文件不能超过 10 MiB，请压缩或拆分后重试。'
  const dot = file.name.lastIndexOf('.')
  const extension = dot > 0 ? file.name.slice(dot).toLowerCase() : ''
  return SUPPORTED_CONTRACT_EXTENSIONS.includes(extension)
    ? ''
    : '不支持的文件格式，仅支持 PDF / DOC / DOCX / TXT。'
}
