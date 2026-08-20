// --- КОД MATH WORKER (BLOB) ---
// Воркер создаётся из blob: URL, у которого непрозрачный путь — относительная
// ссылка внутри importScripts может разрешиться ненадёжно. Поэтому вычисляем
// абсолютные URL vendor-копии mathjs и parser.js здесь, в главном потоке, и
// подставляем их в код воркера уже готовыми.
const MATHJS_URL = new URL('vendor/math.min.js', location.href).href;
const PARSER_URL = new URL('parser.js', location.href).href;
const WORKER_CODE = `
  importScripts(${JSON.stringify(MATHJS_URL)});
  importScripts(${JSON.stringify(PARSER_URL)});
  self.postMessage({ type: 'ready' });

  self.onmessage = function(e) {
    const { id, text, migrate, initial, format, calcPrecision } = e.data;
    try {
      // Точность самих вычислений (issue #10) — отдельная опция от точности
      // вывода (format.precision): применяется до calculateText, чтобы
      // сама эта строка тоже считалась новой точностью, если пользователь
      // её только что поменял.
      if (calcPrecision) math.config({ number: 'BigNumber', precision: calcPrecision });
      const results = calculateText(text, { migrate: migrate, initial: initial, format: format });
      self.postMessage({ type: 'result', id: id, results: results });
    } catch (error) {
      // Исключение в самом вычислении (например, math.format упал на
      // экзотическом значении) — не зависание, воркер жив. Без этого
      // main-поток молча ждёт до CALCULATION_TIMEOUT и диагностирует это
      // как зависание: лишний перезапуск, лишний повтор, неверный тултип.
      self.postMessage({ type: 'error', id: id, message: String((error && error.message) || error) });
    }
  };
`;

// --- СОСТОЯНИЕ ВОРКЕРА ---
let worker = null;
let workerReady = false; // true между получением { type: 'ready' } и следующим initWorker()
let workerErrorShown = false; // не спамить тултипом об ошибке — не чаще раза на экземпляр воркера
let currentRequestId = 0;
let currentRequestText = null; // текст, отправленный в последнем запросе — applyWorkerResults сверяет ответ с ним, а не с editor.value
let currentRequestFlags = null; // { migrate, initial } для последнего запроса

// Запрос, ждущий готового воркера: либо воркер ещё грузится (нет ready),
// либо только что перезапущен ради единственного повтора зависшего
// вычисления. Хранится только последний — каждое новое нажатие клавиши
// обесценивает предыдущий запрос.
let pendingRequest = null;

// Таймер загрузки воркера (importScripts mathjs + parser.js) — заведомо
// медленная, но легитимная фаза, её нельзя обрывать таймаутом вычисления.
// Отдельный от CALCULATION_TIMEOUT таймер, с большим запасом: холодный
// старт на 200 КБ/с — около 3.2 с (см. AGENTS.md, Simulating a slow
// network), 15 с не могут сработать на просто медленной сети.
let workerLoadTimeout = null;
const WORKER_LOAD_TIMEOUT = 15000;

// Таймер собственно вычисления — взводится только на уже готовом воркере
// (см. postRequest), поэтому никогда не покрывает загрузку.
let calcTimeout = null;
const CALCULATION_TIMEOUT = 1000;

// Ключ последнего запроса, которому уже дали один повтор после таймаута
// вычисления. Если тот же запрос (текст + флаги) зависнет снова — сдаёмся,
// это предохранитель от бесконечного цикла перезапусков. Сбрасывается
// любым результатом, полученным вовремя (см. onmessage), поэтому следующая
// правка текста — или тот же запрос, отправленный заново после успеха, —
// снова получает право на повтор.
let retriedRequestKey = null;
function requestKey(req) { return req.migrate + '|' + req.initial + '|' + req.text; }

// Липкий флаг миграции старого формата (« = ») на маркер (« → »). Включается
// на старте, если сохранённый текст не пуст, и остаётся включённым в каждом
// запросе, пока не будет применён ответ, посчитанный с migrate:true —
// разовая привязка к id стартового запроса срывалась бы, если пользователь
// начнёт печатать раньше ответа воркера (запрос устареет и будет отброшен)
// или если стартовый пересчёт упрётся в CALCULATION_TIMEOUT (перезапуск
// воркера не повторяет запрос).
let pendingMigration = false;

// Тот же липкий приём для правила T-002 (защита стартового пересчёта от
// стирания существующего хвоста, см. parser.js). Раньше initial означало
// «это буквально первый вызов triggerCalculation» и потреблялось при
// СБОРКЕ запроса — но с очередью до ready этот самый первый запрос может
// простоять в pendingRequest всю загрузку воркера и быть вытеснен более
// поздним (уже не initial) запросом, если пользователь успеет нажать
// клавишу. Тогда T-002 не сработает вовсе за всю сессию. Поэтому — сброс
// только применённым ответом, симметрично pendingMigration.
let pendingInitial = false;

// --- УПРАВЛЕНИЕ ВОРКЕРОМ ---
// Два независимых таймера, у каждого один авторитетный источник — иначе
// устаревший таймер вычисления может сработать и убить свежий воркер
// посреди загрузки, воспроизведя тот же livelock другим путём (issue #2):
//   - workerLoadTimeout: взводится здесь, снимается по { type: 'ready' };
//   - calcTimeout: взводится только в postRequest (на уже готовом воркере),
//     снимается при получении результата с совпадающим id.
// initWorker обязан снять оба перед созданием нового воркера.
function initWorker() {
  if (worker) worker.terminate();
  if (workerLoadTimeout) { clearTimeout(workerLoadTimeout); workerLoadTimeout = null; }
  if (calcTimeout) { clearTimeout(calcTimeout); calcTimeout = null; }

  workerReady = false;
  workerErrorShown = false;

  const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  const thisWorker = new Worker(workerUrl);
  // new Worker() читает содержимое blob синхронно — revoke сразу после
  // конструктора безопасен и не даёт URL копиться при каждом перезапуске
  // воркера (issue #7).
  URL.revokeObjectURL(workerUrl);
  worker = thisWorker;

  workerLoadTimeout = setTimeout(() => {
    if (worker !== thisWorker) return;
    workerLoadTimeout = null;
    console.error('Worker load timeout: vendor/math.min.js или parser.js недоступны.');
    notifyWorkerError();
  }, WORKER_LOAD_TIMEOUT);

  thisWorker.onmessage = function(e) {
    // Сообщение от уже заменённого воркера — умирающий инстанс мог успеть
    // прислать что-то после того, как initWorker() создал следующий.
    if (worker !== thisWorker) return;
    const data = e.data;

    if (data.type === 'ready') {
      if (workerLoadTimeout) { clearTimeout(workerLoadTimeout); workerLoadTimeout = null; }
      workerReady = true;
      if (pendingRequest) {
        const req = pendingRequest;
        pendingRequest = null;
        postRequest(req);
      }
      return;
    }

    if (data.type === 'result') {
      if (data.id !== currentRequestId) return;
      if (calcTimeout) { clearTimeout(calcTimeout); calcTimeout = null; }
      retriedRequestKey = null; // ответ пришёл вовремя — предохранитель повтора снят
      applyWorkerResults(data.results, currentRequestText, currentRequestFlags);
      return;
    }

    if (data.type === 'error') {
      // Исключение внутри вычисления — воркер жив, это не зависание.
      // retriedRequestKey намеренно не трогаем: если тот же текст позже
      // всё же зависнет (другая причина), право на повтор должно остаться.
      if (data.id !== currentRequestId) return;
      if (calcTimeout) { clearTimeout(calcTimeout); calcTimeout = null; }
      console.error('Worker calculation error:', data.message);
      notifyWorkerError();
    }
  };

  thisWorker.onerror = (err) => {
    if (worker !== thisWorker) return;
    if (workerLoadTimeout) { clearTimeout(workerLoadTimeout); workerLoadTimeout = null; }
    if (calcTimeout) { clearTimeout(calcTimeout); calcTimeout = null; }
    console.error('Worker Error:', err);
    notifyWorkerError();
  };
}

function notifyWorkerError() {
  if (workerErrorShown) return;
  workerErrorShown = true;
  showTooltip('Ошибка вычисления — подробности в консоли');
}

// Собирает запрос из текущего состояния редактора. Не отправляет его —
// решение «отправить сразу» или «встать в очередь до ready» принимает
// вызывающая сторона (triggerCalculation/onCalculationTimeout). format и
// calcPrecision — настройки диалога (issue #10, settings.js): не липкие,
// в отличие от migrate/initial, едут в каждом запросе как есть, поэтому
// изменение настройки посреди набора подхватывается следующим же запросом.
function buildRequest() {
  return {
    text: editor.value,
    migrate: pendingMigration,
    initial: pendingInitial,
    format: currentSettings,
    calcPrecision: currentSettings.calcPrecision,
  };
}

// Единственное место, где назначается currentRequestId и взводится
// calcTimeout — то есть единственное место, где таймер вычисления вообще
// может начаться. Вызывается только на готовом воркере.
function postRequest(req) {
  currentRequestId++;
  const thisRequestId = currentRequestId;
  currentRequestText = req.text;
  currentRequestFlags = { migrate: req.migrate, initial: req.initial };

  if (calcTimeout) clearTimeout(calcTimeout);
  calcTimeout = setTimeout(() => onCalculationTimeout(req), CALCULATION_TIMEOUT);

  worker.postMessage({
    id: thisRequestId, text: req.text, migrate: req.migrate, initial: req.initial,
    format: req.format, calcPrecision: req.calcPrecision,
  });
}

function onCalculationTimeout(req) {
  console.warn('Calculation timeout. Restarting Worker.');
  const key = requestKey(req);
  const shouldRetry = retriedRequestKey !== key;
  initWorker(); // сбрасывает workerReady — запрос уйдёт по следующему ready, не сейчас
  if (shouldRetry) {
    retriedRequestKey = key;
    pendingRequest = req; // единственный повтор
  } else {
    pendingRequest = null; // тот же запрос уже завис дважды — сдаёмся, не зацикливаемся
    showTooltip('Не удалось вычислить — попробуйте изменить выражение');
  }
}

function triggerCalculation() {
  if (isUndoingRedoing) return;
  const req = buildRequest();
  if (workerReady) {
    postRequest(req);
  } else {
    pendingRequest = req; // ждёт ready — это и есть разделение фаз загрузки и вычисления
  }
}

function applyWorkerResults(newLines, requestText, flags) {
  // Сверяем не editor.value как таковой, а ответ построчно с текстом, на
  // котором он был посчитан (requestText): пока воркер считал, пользователь
  // мог продолжить печатать. Строка применяется только если она не успела
  // измениться с момента отправки запроса — иначе дождёмся следующего
  // пересчёта по актуальному тексту. Логика T-002 (не стирать хвост при
  // начальном пересчёте) теперь целиком в parser.js — здесь только применение.
  const requestLines = requestText.split('\n');
  const currentLines = editor.value.split('\n');
  if (currentLines.length !== newLines.length) return;

  let hasChanges = false;
  const resultLines = [];

  for (let i = 0; i < currentLines.length; i++) {
    const currentLine = currentLines[i];
    const newLine = newLines[i];
    if (currentLine === requestLines[i] && newLine !== currentLine) {
      hasChanges = true;
      resultLines.push(newLine);
    } else {
      resultLines.push(currentLine);
    }
  }

  if (hasChanges) {
    // Каретка переносится по паре (строка, столбец), а не по абсолютному
    // смещению: строки выше каретки могли дорасти на результат, и старое
    // смещение указало бы внутрь чужого текста (issue #6).
    const startPos = caretToLineCol(editor.value, editor.selectionStart);
    const endPos = caretToLineCol(editor.value, editor.selectionEnd);
    editor.value = resultLines.join('\n');
    editor.selectionStart = lineColToCaret(resultLines, startPos.line, startPos.col);
    editor.selectionEnd = lineColToCaret(resultLines, endPos.line, endPos.col);
    scrollCaretIntoView();
    persistText(editor.value);
  }

  if (flags.migrate) pendingMigration = false;
  if (flags.initial) pendingInitial = false;
}
