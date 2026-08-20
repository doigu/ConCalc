// --- ИНИЦИАЛИЗАЦИЯ ИНТЕРФЕЙСА ---
editor.placeholder = PLACEHOLDER_TEXT;

// --- РЕГИСТРАЦИЯ SERVICE WORKER ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`service-worker.js?v=${APP_VERSION}`)
    .then(() => console.log(`Service Worker v${APP_VERSION} registered`))
    .catch(err => console.log('SW registration skipped (file:// protocol)'));
}

// --- ЗАПУСК ПРОВЕРКИ ОБНОВЛЕНИЯ ---
checkForUpdate();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > UPDATE_CHECK_INTERVAL) {
    checkForUpdate();
  }
});

// --- ИНИЦИАЛИЗАЦИЯ ---
const savedText = loadStoredText();
editor.value = savedText;
saveHistory(editor.value, editor.selectionStart, true);
pendingMigration = savedText !== '';
pendingInitial = savedText !== '';
initWorker();
if (savedText !== '') {
  triggerCalculation();
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
// Снимок до и после программной правки (issue #26). commitCurrentState перед
// правкой фиксирует незакрытую единицу набора, только если она есть
// (editDirty) — не безусловный force, иначе холостой шаг дублировал бы
// вершину стека, когда фиксировать нечего (например, документ уже пуст).
// saveHistory после правки — тоже БЕЗ force: раз вершина стека актуальна
// (commitCurrentState её обновил или она уже была актуальна), обычный дедуп
// сам решает, отличается ли результат правки, и убрал бы холостой шаг, если
// бы какой-то operation() не менял текст (сейчас такого вызова нет, но
// дешевле оставить дедуп работать сам, чем полагаться на то, что он не
// понадобится).
//
// operation(lines, idx) правит массив строк и возвращает, куда встанет
// каретка: { line, edge }, где edge — 'start' или 'end'. Возврат undefined
// означает прежнее поведение: конец строки idx (issue #6).
function handleLineOp(operation) {
    commitCurrentState();
    const lines = editor.value.split('\n');
    const idx = lineIndexAtCaret(lines, editor.selectionStart);

    const target = operation(lines, idx) || { line: idx, edge: 'end' };
    if (lines.length === 0) lines.push(''); // вырезали единственную строку документа

    editor.value = lines.join('\n');
    const line = Math.max(0, Math.min(target.line, lines.length - 1));
    let pos = 0;
    for (let i = 0; i < line; i++) pos += lines[i].length + 1;
    if (target.edge !== 'start') pos += lines[line].length;
    editor.selectionStart = editor.selectionEnd = pos;

    // Строчная операция рвёт цикл Ctrl+C (issue #6) — иначе после Ctrl+D или
    // Ctrl+X по совпадению номера строки следующий Ctrl+C мог бы продолжить
    // цикл на уже другом содержимом.
    lastCopyLine = null;
    lastCopyMode = null;

    scrollCaretIntoView();
    triggerCalculation();
    saveHistory(editor.value, editor.selectionStart);
    persistText(editor.value);
}

function clearEditor() {
    commitCurrentState(); // см. пояснение в handleLineOp (issue #26)
    editor.value = "";
    editor.dispatchEvent(new Event('input'));
    editor.focus();
    saveHistory(editor.value, 0);
}

// --- РАСКЛАДКА ГОРЯЧИХ КЛАВИШ (issue #6) ---
// Единственное место, где объявлены сочетания; из поля help собирается раздел
// горячих клавиш в тексте помощи (см. ниже), поэтому справка не может
// разойтись с фактическими привязками. Сравнение идёт по event.code —
// привязка не зависит от раскладки, Ctrl+Я работает как Ctrl+Z.
//
// action возвращает false, если событие нужно оставить браузеру (Ctrl+C и
// Ctrl+X при непустом выделении — там работает нативное копирование и
// вырезание). Любой другой возврат означает, что действие выполнено, и
// событие гасится preventDefault. Действия — стрелочные функции: helpBtn
// объявляется ниже по файлу как const, и прямая ссылка на него здесь упала бы
// на временной мёртвой зоне, а стрелка вычисляет его только в момент нажатия.
const KEYMAP = [
  { code: 'KeyC', ctrl: true, shift: false, help: 'Ctrl+C копирует результат строки, повторно подряд на той же строке — исходник; без результата — всю строку.', action: () => {
      if (editor.selectionStart !== editor.selectionEnd) return false; // нативное копирование
      copyLineResult();
    } },
  { code: 'KeyX', ctrl: true, shift: false, help: 'Ctrl+X вырезает строку.', action: () => {
      if (editor.selectionStart !== editor.selectionEnd) return false; // нативное вырезание
      cutCurrentLine();
    } },
  { code: 'KeyX', ctrl: true, shift: true, help: 'Ctrl+Shift+X вырезает весь текст, кнопка C очищает без буфера.', action: () => cutAll() },
  { code: 'KeyD', ctrl: true, shift: false, help: 'Ctrl+D дублирует строку.', action: () => {
      handleLineOp((lines, idx) => { lines.splice(idx + 1, 0, lines[idx]); return { line: idx + 1, edge: 'end' }; });
    } },
  { code: 'Enter', ctrl: true, shift: false, help: 'Ctrl+Enter вставляет строку ниже, Ctrl+Shift+Enter — выше.', action: () => {
      handleLineOp((lines, idx) => { lines.splice(idx + 1, 0, ""); return { line: idx + 1, edge: 'start' }; });
    } },
  { code: 'Enter', ctrl: true, shift: true, help: null, action: () => {
      handleLineOp((lines, idx) => { lines.splice(idx, 0, ""); return { line: idx, edge: 'start' }; });
    } },
  { code: 'KeyS', ctrl: true, shift: false, help: 'Ctrl+S сохраняет всё в файл.', action: () => saveToFile() },
  { code: 'KeyZ', ctrl: true, shift: false, help: 'Ctrl+Z отменяет, Ctrl+Y или Ctrl+Shift+Z повторяют.', action: () => undo() },
  { code: 'KeyY', ctrl: true, shift: false, help: null, action: () => redo() },
  { code: 'KeyZ', ctrl: true, shift: true, help: null, action: () => redo() },
  { code: 'KeyH', ctrl: true, shift: false, help: 'Ctrl+H выводит помощь.', action: () => helpBtn.click() },
  { code: 'Comma', ctrl: true, shift: false, help: 'Ctrl+, открывает и закрывает настройки.', action: () => toggleSettingsDialog() },
  { code: 'KeyG', ctrl: true, shift: false, help: 'Ctrl+G переключает разделение разрядов.', action: () => toggleGrouping() },
];

// Ctrl+Shift+0…9 — число знаков после запятой (issue #10). Ctrl+0…9 без
// Shift не назначены: заняты Chrome (переключение вкладок 1…8, последняя
// вкладка — 9, сброс масштаба — 0), preventDefault их не отменяет.
//
// Ctrl+Shift+0 у автора не доходит до страницы — его перехватывает что-то
// за пределами вкладки (типично для Windows: Ctrl+Shift+<цифра> назначается
// переключению раскладки в дополнительных параметрах клавиатуры). Сама
// привязка исправна — принудительная доставка события через CDP отрабатывает
// все десять цифр, — поэтому запись остаётся: на машине без такого перехвата
// она работает. Замена для нуля — Ctrl+Shift+Backquote (клавиша слева от
// «1», продолжает ряд 1…9 влево): перехват касается только самих цифр, на
// соседнюю клавишу того же ряда он не распространяется. Цифровой блок
// (Numpad0…9 → Digit0…9 в обработчике keydown) заменой не служит —
// у автора его нет, — но нормализация всё равно верна и оставлена.
for (let digit = 0; digit <= 9; digit++) {
  KEYMAP.push({
    code: 'Digit' + digit, ctrl: true, shift: true,
    help: digit === 0
      ? 'Ctrl+Shift+0…9 задают число знаков после запятой; ноль — также Ctrl+Shift+` (клавиша слева от «1»), если Ctrl+Shift+0 перехвачен раскладкой.'
      : null,
    action: () => setDecimals(digit),
  });
}
KEYMAP.push({ code: 'Backquote', ctrl: true, shift: true, help: null, action: () => setDecimals(0) });

// Список клавиш в помощи собирается из таблицы: вручную он расходился с
// фактическими привязками (issue #6).
const HELP_TEXT = HELP_INTRO + '\n' +
  KEYMAP.filter(b => b.help).map(b => '- ' + b.help).join('\n') + '\n';

// --- ОБРАБОТЧИКИ СОБЫТИЙ ---
// Enter без Ctrl больше не перехватывается: строка разбивается по каретке
// нативно, как в любом текстовом поле (issue #6). История и сохранение идут
// уже существующим путём через beforeinput/input — перевод строки
// классифицируется в describeEdit как op 'other' и рвёт единицу отмены сам.
editor.addEventListener('keydown', (event) => {
  // AltGr браузер отдаёт как ctrlKey + altKey: без этой проверки набор
  // символа на такой раскладке запускал бы команду. Meta — по той же причине.
  if (event.altKey || event.metaKey) return;
  // Клавиши цифрового блока — те же, что в основном ряду: Enter, и цифры
  // Numpad0…9 → Digit0…9 (issue #10). Цифровой блок здесь не только ради
  // удобства: Ctrl+Shift+0 основного ряда у автора не доходит до страницы
  // (перехватывается за пределами вкладки — сам код обработки исправен,
  // проверено принудительной доставкой события через CDP), и Ctrl+Shift+
  // Numpad0 даёт этому значению рабочую альтернативу.
  let code = event.code === 'NumpadEnter' ? 'Enter' : event.code;
  if (/^Numpad[0-9]$/.test(code)) code = 'Digit' + code.slice(-1);
  const binding = KEYMAP.find(b =>
    b.code === code && !!b.ctrl === event.ctrlKey && !!b.shift === event.shiftKey);
  if (!binding) return;
  if (binding.action() !== false) event.preventDefault();
});

// Описание правки для группировки истории (issue #20). Посимвольный набор и
// посимвольное удаление продолжают единицу, всё остальное (вставка,
// перетаскивание, IME, удаление выделения, Ctrl+Backspace, перевод строки)
// получает op 'other' и единицу рвёт.
function describeEdit(event) {
  const start = editor.selectionStart;
  const other = { op: 'other', cls: null, caret: start };
  if (start !== editor.selectionEnd) return other; // удаление выделения — своя единица

  if (event.inputType === 'insertText') {
    const data = event.data;
    // Больше одного символа за раз — не набор с клавиатуры (автоподстановка,
    // диктовка): классы символов внутри могут быть разными, единицу не тянем.
    if (typeof data !== 'string' || data.length !== 1 || data === '\n') return other;
    return { op: 'insert', cls: charClass(data), caret: start };
  }

  if (event.inputType === 'deleteContentBackward') {
    if (start === 0) return other;
    const ch = editor.value[start - 1];
    if (ch === '\n') return other; // склейка строк — отдельный шаг отмены
    return { op: 'deleteBack', cls: charClass(ch), caret: start };
  }

  if (event.inputType === 'deleteContentForward') {
    if (start >= editor.value.length) return other;
    const ch = editor.value[start];
    if (ch === '\n') return other;
    return { op: 'deleteForward', cls: charClass(ch), caret: start };
  }

  return other;
}

// Решение, принятое в beforeinput, для следующего события input. Обнуляется
// при потреблении: input без него — правка не из ввода (синтетическое событие
// из clearEditor и т. п.), такая единицу не продолжает.
let pendingEdit = null;

// Обрамление выделения скобками (issue #11): стандартное поведение VS Code,
// Sublime и JetBrains — набор открывающей скобки при непустом выделении
// обрамляет его, а не заменяет. Отдельного сочетания не назначается (решено
// при разборе #6) — перехват идёт прямо на символ '(' до describeEdit, с
// немедленным выходом, чтобы не путать классификацию обычного набора символа.
editor.addEventListener('beforeinput', (event) => {
  if (event.inputType === 'insertText' && event.data === '(' &&
      editor.selectionStart !== editor.selectionEnd) {
    event.preventDefault();
    commitCurrentState(); // см. пояснение в handleLineOp (issue #26)
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = editor.value.slice(start, end);
    editor.value = editor.value.slice(0, start) + '(' + selected + ')' + editor.value.slice(end);
    // Выделение остаётся на прежнем тексте, теперь внутри скобок — обрамление
    // можно повторить или сразу продолжить правку.
    editor.selectionStart = start + 1;
    editor.selectionEnd = start + 1 + selected.length;
    lastCopyLine = null; // правка текста рвёт цикл Ctrl+C (issue #6)
    lastCopyMode = null;
    triggerCalculation();
    saveHistory(editor.value, editor.selectionStart);
    persistText(editor.value);
    return;
  }

  const edit = describeEdit(event);
  if (isEditGroupBoundary(editGroup, edit)) {
    // Снимок состояния ДО правки — это и есть шаг, к которому вернёт Ctrl+Z.
    saveHistory(editor.value, editor.selectionStart);
  }
  pendingEdit = edit;
});

editor.addEventListener('input', () => {
  if (isUndoingRedoing) return;
  editGroup = pendingEdit && pendingEdit.op !== 'other'
    ? { op: pendingEdit.op, cls: pendingEdit.cls, caret: editor.selectionStart }
    : null;
  pendingEdit = null;
  editDirty = true;
  // Правка текста рвёт цикл Ctrl+C (issue #6), см. copyLineResult.
  lastCopyLine = null;
  lastCopyMode = null;
  persistText(editor.value);
  triggerCalculation();
});

editor.addEventListener('paste', (event) => {
  event.preventDefault();
  commitCurrentState(); // см. пояснение в handleLineOp (issue #26)
  // Нормализуем переводы строк к \n, которым пользуется весь остальной код
  // (split('\n') в parser.js и main.js) — не вырезаем их вовсе, иначе
  // многострочная вставка схлопывается в одну строку (issue #5).
  const pasted = (event.clipboardData || window.clipboardData).getData('text/plain').replace(/\r\n|\r/g, '\n');
  const start = editor.selectionStart;
  editor.value = editor.value.slice(0, start) + pasted + editor.value.slice(editor.selectionEnd);
  editor.selectionStart = editor.selectionEnd = start + pasted.length;
  lastCopyLine = null; // правка текста рвёт цикл Ctrl+C (issue #6)
  lastCopyMode = null;
  triggerCalculation();
  saveHistory(editor.value, editor.selectionStart);
  persistText(editor.value);
});

function saveToFile() {
  if (window.showSaveFilePicker) {
    (async () => {
      try {
        const h = await window.showSaveFilePicker({types:[{description:'Text', accept:{'text/plain':['.txt']}}]});
        const w = await h.createWritable(); await w.write(editor.value); await w.close();
      } catch(e){}
    })();
  } else {
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([editor.value], {type:'text/plain'}));
    a.href = url;
    a.download = prompt("Имя файла", "doc.txt") || "doc.txt";
    a.click();
    // Отложенный revoke: браузер должен успеть поставить скачивание в
    // очередь по этому URL до его освобождения (issue #7).
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// Ни один путь записи в буфер не должен молчать: отказ в доступе (нет
// secure context, нет фокуса, запрет пользователя) раньше давал unhandled
// rejection и никакой обратной связи (issue #6).
function copyToClipboard(text, message) {
  navigator.clipboard.writeText(text)
    .then(() => showTooltip(message))
    .catch(() => showTooltip('Буфер обмена недоступен'));
}

// Цикл Ctrl+C на строке с результатом (issue #6): первое нажатие подряд на
// строке — результат, второе — исходник (текст до маркера), третье — снова
// результат. Ctrl+Shift+C как отдельное сочетание для «исходник без
// результатов» отклонён на стадии 0.1 (конфликтует с «Инспектировать
// элемент» Chrome, preventDefault на странице его не отменяет) — цикл принят
// автором взамен. Состояние — пара (номер строки, что скопировано последним);
// не совпадает при переходе на другую строку и явно сбрасывается любой
// текстовой правкой (см. handleLineOp и обработчик input).
let lastCopyLine = null;
let lastCopyMode = null; // 'result' | 'source'

function copyLineResult() {
  const lines = editor.value.split('\n');
  const idx = lineIndexAtCaret(lines, editor.selectionStart);
  const line = lines[idx];
  const tail = resultTail(line);

  if (tail === null || tail.trim() === '') {
    lastCopyLine = null;
    lastCopyMode = null;
    if (line.trim() === '') { showTooltip('Строка пуста'); return; }
    copyToClipboard(line, 'Скопирована строка');
    return;
  }

  const mode = (lastCopyLine === idx && lastCopyMode === 'result') ? 'source' : 'result';
  lastCopyLine = idx;
  lastCopyMode = mode;
  if (mode === 'result') {
    copyToClipboard(tail.trim(), 'Скопирован результат');
  } else {
    copyToClipboard(stripResult(line).trim(), 'Скопирован исходник');
  }
}

// Ctrl+X без выделения — вырезать строку под кареткой (issue #6).
function cutCurrentLine() {
  const lines = editor.value.split('\n');
  const idx = lineIndexAtCaret(lines, editor.selectionStart);
  if (lines.length === 1 && lines[0] === '') { showTooltip('Строка пуста'); return; }
  // Перевод строки уходит в буфер вместе со строкой: вставка должна
  // возвращать строку, а не склеивать её с соседней.
  copyToClipboard(lines[idx] + '\n', 'Вырезана строка');
  handleLineOp((ls, i) => {
    ls.splice(i, 1);
    return i < ls.length ? { line: i, edge: 'start' } : { line: ls.length - 1, edge: 'end' };
  });
}

// Ctrl+Shift+X — вырезать весь текст в буфер (issue #6).
function cutAll() {
  if (editor.value === '') { showTooltip('Документ пуст'); return; }
  copyToClipboard(editor.value, 'Вырезано всё');
  clearEditor();
}

// КНОПКИ ИНТЕРФЕЙСА
document.getElementById('clear-btn').onclick = clearEditor;

const helpBtn = document.getElementById('help-btn');
helpBtn.onclick = () => {
  commitCurrentState(); // см. пояснение в handleLineOp (issue #26)
  if (editor.value && !editor.value.endsWith('\n')) editor.value += '\n\n';

  editor.value += HELP_TEXT;

  editor.selectionStart = editor.selectionEnd = editor.value.length;
  lastCopyLine = null; // правка текста рвёт цикл Ctrl+C (issue #6)
  lastCopyMode = null;
  triggerCalculation();
  saveHistory(editor.value, editor.selectionStart);
  editor.focus();
};

editor.focus();
