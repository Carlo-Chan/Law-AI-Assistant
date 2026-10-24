/**
 * 消息导出工具函数
 *
 * 将前端消息对象数组转换为后端 API 所需的格式，
 * 保留旧重建接口的消息格式转换，当前页面的删除、编辑和重生成均使用定点接口。
 */

/**
 * 将消息数组转换为可发送给后端的格式
 *
 * @param {array} messages  前端消息对象数组
 * @returns {array} 后端格式的消息数组
 */
export function toExportable(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role,
      content: m.content,
      file_name: m.file?.name || null,
      contract_data: m.contractData || null,
      thinking_chain: m.thinkingChain || null,
    }))
}
