/** 结构只引用原文的 UTF-16 范围；异常结构回退到完整文本，不拼接外部 HTML。 */
export function validDocumentBlocks(raw, blocks) {
  let remaining = 10000
  let gridBudget = 100000
  const integer = Number.isSafeInteger
  const gap = (start, end) => /^[\n\t]*$/.test(raw.slice(start, end))
  const bounds = (node, start, end) =>
    node &&
    integer(node.start) &&
    integer(node.end) &&
    node.start >= start &&
    node.end >= node.start &&
    node.end <= end &&
    !splitsSurrogate(node.start) &&
    !splitsSurrogate(node.end)
  const splitsSurrogate = (offset) =>
    offset > 0 &&
    offset < raw.length &&
    /[\uD800-\uDBFF]/.test(raw[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(raw[offset])

  function visit(items, start, end, depth) {
    if (!Array.isArray(items) || depth > 16) return false
    let cursor = start
    for (const block of items) {
      if (--remaining < 0 || !bounds(block, cursor, end) || !gap(cursor, block.start)) return false
      if (block.type === 'paragraph') {
        if (block.end === block.start) return false
      } else if (block.type === 'table') {
        if (
          !integer(block.columns) ||
          block.columns < 1 ||
          block.columns > 256 ||
          !Array.isArray(block.rows) ||
          block.rows.length < 1 ||
          block.rows.length > 1000
        )
          return false
        gridBudget -= block.columns * block.rows.length
        if (gridBudget < 0) return false
        const occupied = Array(block.columns).fill(0)
        let position = block.start
        for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex++) {
          const row = block.rows[rowIndex]
          if (!Array.isArray(row)) return false
          let column = 0
          for (const cell of row) {
            if (
              --remaining < 0 ||
              !bounds(cell, position, block.end) ||
              !gap(position, cell.start) ||
              !integer(cell.column) ||
              cell.column < column ||
              !integer(cell.colspan) ||
              cell.colspan < 1 ||
              !integer(cell.rowspan) ||
              cell.rowspan < 1 ||
              cell.column + cell.colspan > block.columns ||
              rowIndex + cell.rowspan > block.rows.length
            )
              return false
            for (let index = cell.column; index < cell.column + cell.colspan; index++) {
              if (occupied[index] > rowIndex) return false
              occupied[index] = rowIndex + cell.rowspan
            }
            if (!visit(cell.blocks, cell.start, cell.end, depth + 1)) return false
            column = cell.column + cell.colspan
            position = cell.end
          }
        }
        if (!gap(position, block.end)) return false
      } else return false
      cursor = block.end
    }
    return gap(cursor, end)
  }
  return typeof raw === 'string' && visit(blocks, 0, raw.length, 0)
}

/** 每个文本叶子单独渲染高亮片段，不能让 mark 标签跨越单元格的 HTML 边界。 */
export function renderContractDocument(raw, blocks, renderRange) {
  if (!validDocumentBlocks(raw, blocks)) return null
  function render(items) {
    return items
      .map((block) => {
        if (block.type === 'paragraph')
          return `<div class="contract-paragraph">${renderRange(block.start, block.end)}</div>`
        const occupied = Array(block.columns).fill(0)
        const rows = block.rows.map((row, rowIndex) => {
          const parts = []
          let next = 0
          for (let column = 0; column < block.columns;) {
            if (occupied[column] > rowIndex) {
              column++
              continue
            }
            const cell = row[next]
            if (cell?.column === column) {
              parts.push(
                `<td colspan="${cell.colspan}" rowspan="${cell.rowspan}">${render(cell.blocks)}</td>`,
              )
              for (let index = column; index < column + cell.colspan; index++)
                occupied[index] = rowIndex + cell.rowspan
              column += cell.colspan
              next++
            } else {
              parts.push('<td></td>')
              column++
            }
          }
          return `<tr>${parts.join('')}</tr>`
        })
        return `<div class="contract-table-wrap"><table class="contract-table"><tbody>${rows.join('')}</tbody></table></div>`
      })
      .join('')
  }
  return render(blocks)
}
