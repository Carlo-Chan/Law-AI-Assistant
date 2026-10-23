/** 合同文件大小上限，与后端 uploads.py 保持一致。 */
export const MAX_CONTRACT_FILE_BYTES = 10 * 1024 * 1024

/** 仅校验大小，不改变现有文件格式与草稿处理方式。 */
export function getContractUploadError(file) {
  return file.size > MAX_CONTRACT_FILE_BYTES ? '合同文件不能超过 10 MiB，请压缩或拆分后重试。' : ''
}
