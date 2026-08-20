// --- МЕНЕДЖЕР ИСТОРИИ ---
let historyStack = [];
let historyIndex = -1;
let isUndoingRedoing = false;

// --- ЕДИНИЦЫ ОТМЕНЫ (issue #20) ---
// Шаг отмены — смысловая единица ввода (слово или число, прогон знаков,
// прогон пробелов), а не отрезок набора между паузами: раньше снимок писался
// ПОСЛЕ ввода по таймеру HISTORY_SAVE_DELAY, и границу шага задавала пауза.
// Теперь снимок пишется ПЕРЕД правкой, открывающей новую единицу, поэтому
// текущая (ещё не закрытая) единица в стеке не лежит — её фиксирует
// commitCurrentState при первом же undo/redo.
let editGroup = null; // открытая единица: { op, cls, caret }; null — единицы нет
let editDirty = false; // текст изменился после последнего снимка

// Класс символа для группировки. Цифры и буквы в одном классе намеренно:
// `12`, `x2`, `1.5` — одна единица ввода. Точка входит в «слово» ради
// десятичной записи.
function charClass(ch) {
  if (ch === ' ' || ch === '\t') return 'space';
  if (/[\p{L}\p{N}_.]/u.test(ch)) return 'word';
  return 'symbol';
}

// Чистая функция (покрыта тестами в tests.html): начинает ли правка новую
// единицу отмены. group — открытая единица или null; edit — { op, cls, caret },
// где caret — позиция каретки ПЕРЕД правкой, cls — класс вставляемого или
// удаляемого символа, а op 'other' означает непосимвольную правку (вставка,
// перетаскивание, IME, удаление выделения) и всегда рвёт единицу.
function isEditGroupBoundary(group, edit) {
  if (!group) return true;
  if (edit.op === 'other' || edit.cls === null) return true;
  if (edit.op !== group.op) return true; // набор ↔ удаление
  if (edit.cls !== group.cls) return true; // число → знак → слово
  // Правка не вплотную к предыдущей — каретку перенесли (клик, стрелки).
  // Сравнение строгое: лишний шаг отмены безвреден, а склейка правок в разных
  // местах документа — нет.
  if (edit.caret !== group.caret) return true;
  return false;
}

// Текущее состояние может опережать вершину стека: снимок делается перед
// правкой, поэтому начатая единица ещё не зафиксирована. Без этого один Ctrl+Z
// уходил бы на два шага назад, а набранное терялось бы без возможности redo.
// Хвост redo обрезается здесь явно: saveHistory выходит по дедупу ДО обрезки,
// поэтому отменённая ветка иначе возвращалась бы по Ctrl+Y.
function commitCurrentState() {
  if (!editDirty) return;
  if (historyIndex < historyStack.length - 1) {
    historyStack = historyStack.slice(0, historyIndex + 1);
  }
  saveHistory(editor.value, editor.selectionStart);
}

function saveHistory(text, caret, force = false) {
  if (isUndoingRedoing) return;
  // Любой снимок закрывает текущую единицу: следующая правка начинает новую.
  editGroup = null;
  editDirty = false;
  if (!force && historyStack.length > 0 && historyIndex >= 0) {
    if (historyStack[historyIndex].text === text) return;
  }
  if (historyIndex < historyStack.length - 1) {
    historyStack = historyStack.slice(0, historyIndex + 1);
  }
  historyStack.push({ text: text, caret: caret });
  historyIndex++;
  if (historyStack.length > MAX_HISTORY_SIZE) {
    historyStack.shift();
    historyIndex--;
  }
}

function undo() {
  commitCurrentState();
  if (historyIndex > 0) {
    historyIndex--;
    restoreState();
  }
}

function redo() {
  commitCurrentState();
  if (historyIndex < historyStack.length - 1) {
    historyIndex++;
    restoreState();
  }
}

function restoreState() {
  const state = historyStack[historyIndex];
  if (!state) return;
  isUndoingRedoing = true;
  // Восстановленное состояние не продолжает прежнюю единицу: первое нажатие
  // после отмены обязано открыть новую и записать снимок.
  editGroup = null;
  editDirty = false;
  editor.value = state.text;
  editor.selectionStart = editor.selectionEnd = state.caret;
  persistText(state.text);
  scrollCaretIntoView();
  // Снимаем флаг ДО пересчёта: triggerCalculation() первой строкой выходит,
  // если isUndoingRedoing ещё true, — иначе вызов ниже мёртвый и устаревший
  // результат остаётся в строке до следующего нажатия клавиши (issue #2).
  isUndoingRedoing = false;
  triggerCalculation();
}
