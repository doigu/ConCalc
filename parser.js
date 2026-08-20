// --- РАЗБОР СТРОКИ (без ES-модулей, без сборки) ---
//
// Глобальные функции. Подключаются вторым importScripts в воркере, после
// vendor/math.min.js (там `math` уже глобальный) — см. main.js. Файл также
// подключается в главном потоке ради константы RESULT_MARKER (нужна
// copyLineResult в main.js); math.config ниже вызывается только если `math`
// определён, поэтому загрузка без mathjs безопасна.
//
// Результат отделяется от исходника собственным маркером RESULT_MARKER, а не
// знаком «=»: у пользователя в тексте соседствуют настоящие выражения и
// заметки вида «итог = ок», «x = 5», и различить их со стороны разбора
// невозможно без ложных срабатываний в обе стороны. Маркер убирает
// неоднозначность как класс: строка без маркера — целиком текст пользователя
// и никогда не вычисляется как выражение; всё после первого маркера в строке
// — наш вывод.

const RESULT_MARKER = ' → ';

if (typeof math !== 'undefined') {
  math.config({ number: 'BigNumber', precision: 64 });
}

// Опции формата результата. Пороги auto-нотации сдвинуты: mathjs по умолчанию
// уходит в e-запись уже с 10^5 (245432 → 2.45432e+5). e-запись остаётся там,
// где обычная запись перестаёт быть честной: при exp >= precision в ней
// появились бы нули вместо неизвестных цифр (123456789012345 при 10 значащих
// дал бы «123456789000000»), при exp < -7 — одни ведущие нули (issue #21).
// Это значения по умолчанию, когда вызывающая сторона не передаёт options.format
// (в частности — все существующие вызовы в tests.html): вывод без формата не
// меняется задачей #10. Настройки диалога (issue #10) едут отдельным полем
// options.format в calculateText/calculateLine и переопределяют только то, что
// в нём указано — см. rawFormatOptions.
const FORMAT_OPTIONS = { precision: 10, lowerExp: -7, upperExp: 10 };

// Часть строки до первого маркера — то, что подаётся на вычисление.
function stripResult(line) {
  const idx = line.indexOf(RESULT_MARKER);
  return idx === -1 ? line : line.slice(0, idx);
}

// Часть строки после первого маркера, или null, если маркера нет.
// Используется в main.js для Ctrl+C — вычислений не требует.
function resultTail(line) {
  const idx = line.indexOf(RESULT_MARKER);
  return idx === -1 ? null : line.slice(idx + RESULT_MARKER.length);
}

// precision/lowerExp/upperExp из переданного format, с откатом на FORMAT_OPTIONS
// для каждого поля по отдельности — decimals/grouping/groupSeparator сюда
// не попадают, это опции math.format, а не постобработки (issue #10).
function rawFormatOptions(format) {
  format = format || {};
  return {
    precision: format.precision != null ? format.precision : FORMAT_OPTIONS.precision,
    lowerExp: format.lowerExp != null ? format.lowerExp : FORMAT_OPTIONS.lowerExp,
    upperExp: format.upperExp != null ? format.upperExp : FORMAT_OPTIONS.upperExp,
  };
}

// «Сырой» формат — то же, что раньше делал formatValue() без аргументов.
// Используется как для вывода (formatOutput ниже достраивает поверх него
// decimals и разряды), так и для сравнения в isSuppressedAssignment и
// migrateLegacyLine, которые ОБЯЗАНЫ не знать про decimals/grouping: иначе
// `x = 245432` при включённых разрядах сравнивался бы с «245 432» и
// ошибочно обрастал бы маркером (issue #10, та же ошибка, что #21 чинил
// для порогов e-записи).
function formatValue(value, format) {
  return math.format(value, rawFormatOptions(format));
}

// Разряды не режутся у e-записи (иначе показатель степени внутри «e+30»
// попал бы под группировку) и у значений, которые format.decimals не умеет
// осмысленно округлить: Unit («5 inch to cm») бросает исключение из
// math.round самостоятельно, но boolean («2>1» → true) round молча
// превращает в 1 — это неверно и требует явной проверки типа.
function isRoundableType(value) {
  const t = math.typeOf(value);
  return t === 'number' || t === 'BigNumber' || t === 'Fraction' ||
    t === 'Array' || t === 'DenseMatrix' || t === 'SparseMatrix';
}

// Ограничивает число знаков после запятой сверху (не дописывает хвостовые
// нули — это МАКСИМУМ, а не фиксированная ширина). raw — уже отформатированная
// «сырая» строка (см. formatValue), нужна только чтобы проверить наличие
// e-записи без повторного парсинга.
function applyDecimals(value, format, raw) {
  if (format.decimals == null) return raw;
  if (/[eE]/.test(raw)) return raw;
  if (!isRoundableType(value)) return raw;
  try {
    return math.format(math.round(value, format.decimals), rawFormatOptions(format));
  } catch (e) {
    return raw;
  }
}

// Разделение разрядов пробелом или апострофом в целой части каждого
// числового литерала строки. Не трогает: показатель e-записи
// (отрицательный просмотр вперёд ловит хвост e±NN), дробную часть и цифры,
// примыкающие к букве/точке слева (0b1010, доли после «.»).
function groupDigits(str, sep) {
  return str.replace(/(?<![\w.])(\d+)(?![\d]*[.\d]*[eE])/g, function (m) {
    return m.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  });
}

// Полный формат вывода для строки результата (issue #10): сырой формат →
// ограничение знаков после запятой → разделение разрядов. Порядок важен —
// группировка должна идти по уже округлённой строке.
function formatOutput(value, format) {
  format = format || {};
  let out = formatValue(value, format);
  out = applyDecimals(value, format, out);
  if (format.grouping) out = groupDigits(out, format.groupSeparator || ' ');
  return out;
}

// Разделители разрядов, которые распознаются при обратной вставке скопированного
// результата: обычный пробел, NBSP, узкий неразрывный пробел, апостроф —
// ровно то, что предлагает диалог настроек как groupSeparator (issue #10).
// Подчёркивание намеренно не входит: это разделитель числовых литералов в
// языках программирования («1_234_567»), а не типографский разделитель
// разрядов — GROUP_SEPARATOR_OPTIONS его тоже не предлагает. Запятая и точка
// тоже не входят: они уже заняты десятичным разделителем и разделителем
// аргументов/элементов, добавление их сюда дало бы тихий неверный результат
// при вставке чужого «245,432».
function stripDigitSeparators(source) {
  return source.replace(/(?<=\d)[   '](?=\d)/g, '');
}

// Пытается вычислить source как есть; при неудаче пробует по очереди: без
// разделителей разрядов между цифрами (issue #10 — раньше это делало сплошное
// вырезание пробелов, снятое в #1 как ломающее `10 mod 3`/`5 inch to cm`;
// здесь правило узкое — только между двумя цифрами), с нормализованной
// десятичной запятой, и оба исправления вместе. Порядок важен: `max(1,2)` и
// `[1,2,3]` валидны дословно (запятая — разделитель аргументов/элементов) и
// не должны трогаться нормализацией; `1,5+2,5` невалидно дословно и нуждается
// в ней; `10 mod 3`/`5 inch to cm` не содержат «цифра-разделитель-цифра» и
// строка вырезания их не меняет. Возвращает { ok, value, evaluated } —
// evaluated это ровно та строка, на которой вычисление удалось; дальнейший
// разбор (isSuppressedAssignment) обязан идти по ней же, иначе после
// успешного evaluate на изменённой строке повторный math.parse исходной
// может бросить исключение.
function tryEvaluate(source, scope) {
  try {
    return { ok: true, value: math.evaluate(source, scope), evaluated: source };
  } catch (e) {
    const attempts = [];
    const stripped = stripDigitSeparators(source);
    if (stripped !== source) attempts.push(stripped);
    const normalized = source.replace(/(\d),(\d)/g, '$1.$2');
    if (normalized !== source) attempts.push(normalized);
    if (stripped !== source) {
      const strippedNormalized = stripped.replace(/(\d),(\d)/g, '$1.$2');
      if (strippedNormalized !== stripped) attempts.push(strippedNormalized);
    }
    for (let i = 0; i < attempts.length; i++) {
      try {
        return { ok: true, value: math.evaluate(attempts[i], scope), evaluated: attempts[i] };
      } catch (e2) {
        // пробуем следующий вариант
      }
    }
    return { ok: false };
  }
}

// Хвост похож на наш формат результата (число, отрицательное число, массив,
// булево, NaN/Infinity) — тогда его можно списать как устаревший при
// неудачном пересчёте. Свободный текст после маркера (пользователь мог сам
// набрать « → » как часть заметки) под это не подходит и не трогается —
// то же самое правило, что защищает заметки со знаком «=».
function looksLikeOurResult(tail) {
  return /^-?(\d|Infinity|NaN|true|false|\[)/.test(tail.trim());
}

// `x = 5` и `f(x) = x^2` — присваивание переменной и объявление функции,
// а не выражение с результатом; строка не должна обрастать своим же
// маркером. evaluatedSource — та же строка, что реально вычислилась
// (см. tryEvaluate), value — её результат. format — options.format из
// calculateText (issue #10): сравнение идёт по «сырому» формату
// (precision/lowerExp/upperExp), decimals/grouping здесь не участвуют —
// иначе `x = 245432` при включённых разрядах сравнивалось бы с «245 432»
// и ошибочно получало бы маркер.
function isSuppressedAssignment(evaluatedSource, value, format) {
  let node;
  try {
    node = math.parse(evaluatedSource);
  } catch (e) {
    return false;
  }
  if (node.type === 'FunctionAssignmentNode') return true;
  if (node.type === 'AssignmentNode') {
    let formatted;
    try {
      formatted = formatValue(value, format);
    } catch (e) {
      return false;
    }
    // `x = 5`: правая часть уже сама по себе — результат, дописывать нечего.
    // `a = 2+2`: правая часть — выражение, результат «4» ей не равен,
    // маркер добавляется как обычно. toString(rawFormatOptions(format))
    // обязателен: без опций Node.toString() печатает дефолтными порогами
    // mathjs (upperExp: 5), которые formatValue больше не использует — без
    // этого `x = 245432` ошибочно получил бы маркер (issue #21).
    return node.value.toString(rawFormatOptions(format)) === formatted;
  }
  return false;
}

// Одна строка → новая строка. scope — общий для всего текста, мутируется
// присваиваниями (`x = 5` делает `x` видимым в следующих вызовах на том же
// scope). options.initial — это первый пересчёт сохранённого текста
// (правило T-002): существующий хвost после маркера не стирается никогда,
// даже если новое вычисление не удалось. Вне initial устаревший результат
// сбрасывается как обычно. options.format — настройки диалога (issue #10),
// см. formatOutput/rawFormatOptions; по умолчанию (undefined) — сегодняшнее
// поведение без decimals/grouping.
function calculateLine(line, scope, options) {
  options = options || {};
  const format = options.format || {};
  const source = stripResult(line);
  if (source.trim() === '') return source;

  const evalResult = tryEvaluate(source, scope);
  if (evalResult.ok) {
    if (isSuppressedAssignment(evalResult.evaluated, evalResult.value, format)) {
      return source;
    }
    return source + RESULT_MARKER + formatOutput(evalResult.value, format);
  }

  const markerIdx = line.indexOf(RESULT_MARKER);
  if (markerIdx === -1) return line; // маркера нет — целиком текст пользователя, не трогаем

  if (options.initial) return line; // T-002: начальный пересчёт хвост не стирает

  const tail = line.slice(markerIdx + RESULT_MARKER.length);
  return looksLikeOurResult(tail) ? source : line;
}

// Разовая миграция строки старого формата («expr = result», без маркера)
// на маркер. Срабатывает только если левая часть вычисляется и даёт РОВНО
// тот хвост, что уже записан — так `итог = ок`, `итого за март = 5`,
// `x = 5` никогда не мигрируют (левая часть либо не вычисляется, либо это
// не тот случай). Строки, уже содержащие маркер, не трогаются. format —
// см. calculateLine; сравнение с уже записанным хвостом идёт по «сырому»
// формату, как и в isSuppressedAssignment.
function migrateLegacyLine(line, scope, format) {
  if (line.indexOf(RESULT_MARKER) !== -1) return line;
  const sepIdx = line.indexOf(' = ');
  if (sepIdx === -1) return line;

  // Строка сама по себе — валидное присваивание/объявление функции
  // (`x = 5`, `f(x) = x^2`) — не трогаем её независимо от scope. Без этой
  // проверки миграция ошибочно опиралась на то, вычисляется ли левая часть
  // САМА ПО СЕБЕ как отдельное выражение: если переменная уже была определена
  // ранее в тексте (например, второй строкой «x = 5»), «x» вычисляется
  // (берётся из scope) и строка ошибочно превращалась бы в «x → 5», теряя
  // присваивание.
  try {
    const node = math.parse(line);
    if (node.type === 'AssignmentNode' || node.type === 'FunctionAssignmentNode') return line;
  } catch (e) {
    // не присваивание (или вообще не валидное выражение целиком) — продолжаем миграцию как раньше
  }

  const expr = line.slice(0, sepIdx);
  const existingTail = line.slice(sepIdx + 3);
  if (expr.trim() === '') return line;

  const evalResult = tryEvaluate(expr, scope);
  if (!evalResult.ok) return line;

  const formatted = formatValue(evalResult.value, format);
  if (formatted !== existingTail) return line;

  return expr + RESULT_MARKER + formatted;
}

// Весь текст → массив строк (формат ответа воркера не меняется).
// options.migrate — прогонять миграцию старого формата перед вычислением.
// options.initial — см. calculateLine; относится к самому пересчёту, а не
// к миграции (это разные флаги: миграция может быть липкой и повторяться
// на нескольких запросах подряд, initial — только у первого запроса).
// options.format — настройки диалога (issue #10), едут в каждом запросе
// (не липкие, в отличие от migrate/initial) и применяются и к миграции,
// и к самому вычислению.
function calculateText(text, options) {
  options = options || {};
  const scope = {};
  const format = options.format || {};
  return text.split('\n').map(function (line) {
    const working = options.migrate ? migrateLegacyLine(line, scope, format) : line;
    return calculateLine(working, scope, { initial: options.initial, format: format });
  });
}
