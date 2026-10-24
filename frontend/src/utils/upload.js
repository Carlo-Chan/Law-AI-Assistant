/** 合同文件大小上限，与后端 uploads.py 保持一致。 */
export const MAX_CONTRACT_FILE_BYTES = 10 * 1024 * 1024

/** 先确认包含真实附件内容，再检查大小；历史记录中的文件名对象不能用于上传。 */
export function getContractUploadError(file) {
  if (!(file instanceof File)) return '原附件已不可用，请重新选择文件后发送审查请求。'
  return file.size > MAX_CONTRACT_FILE_BYTES ? '合同文件不能超过 10 MiB，请压缩或拆分后重试。' : ''
}
