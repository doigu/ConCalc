// --- ССЫЛКИ НА ЭЛЕМЕНТЫ DOM ---
const editor = document.getElementById('editor');
const updateBtn = document.getElementById('update-btn');

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ UI ---
function scrollCaretIntoView() {
  const style = getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight);
  const text = editor.value;
  const caretPos = editor.selectionStart;
  const lines = text.split('\n');
  const caretLine = text.slice(0, caretPos).split('\n').length - 1;
  const caretY = caretLine * lineHeight;
  const viewTop = editor.scrollTop;
  const viewBottom = viewTop + editor.clientHeight;

  if (caretY < viewTop) editor.scrollTop = caretY;
  else if (caretY + lineHeight > viewBottom) {
    if (caretLine === lines.length - 1) editor.scrollTop = editor.scrollHeight;
    else editor.scrollTop = caretY + lineHeight - editor.clientHeight;
  }
}

function showTooltip(text, duration = TOOLTIP_DEFAULT_DURATION) {
  const tooltip = document.createElement('div');
  tooltip.textContent = text;
  tooltip.style.cssText = `
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    background-color: rgba(0, 0, 0, 0.6); color: #fff; padding: 10px 20px;
    border-radius: 4px; z-index: 1000; pointer-events: none;
  `;
  document.body.appendChild(tooltip);
  setTimeout(() => tooltip.remove(), duration);
}

function lineIndexAtCaret(lines, caretPos) {
    let cum = 0;
    for (let i = 0; i < lines.length; i++) {
        if (cum + lines[i].length >= caretPos) return i;
        cum += lines[i].length + 1;
    }
    return lines.length - 1;
}

// Абсолютное смещение каретки → пара (номер строки, столбец в строке).
// Нужна при применении результатов расчёта: строки выше каретки могут
// изменить длину, и абсолютное смещение перестаёт указывать в то же место
// (issue #6).
function caretToLineCol(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  const col = offset - (before.lastIndexOf('\n') + 1);
  return { line: line, col: col };
}

// Обратное преобразование по массиву строк нового текста. Номер строки и
// столбец ограничиваются размерами нового текста: строка могла укоротиться.
function lineColToCaret(lines, line, col) {
  const idx = Math.max(0, Math.min(line, lines.length - 1));
  let pos = 0;
  for (let i = 0; i < idx; i++) pos += lines[i].length + 1;
  return pos + Math.max(0, Math.min(col, lines[idx].length));
}
