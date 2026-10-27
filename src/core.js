/* 纯函数层：日期/数值解析、区间口径、分桶聚合、记录归一化。
 * 不接触 DOM 与全局状态，可直接被 node 导入做单元测试。
 * 构建脚本会把 export 剥掉并与 main.js 拼回单文件。
 */

  /* 纯函数层的常量：不依赖 DOM 与页面状态 */
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const UNKNOWN_MODEL_NAME = "未知模型";

  // 预设档位的「天数」口径。平台两处前端都用 start = 今天 − N 取区间
  // （实测 7 天档给 8 个自然日、30 天档给 31 个），多算了一天。
  const ALIGN_RANGE_TO_LABEL = true;
  const RANGE_LABEL_DAYS = { today: 1, "3d": 3, "7d": 7, "30d": 30 };
  // 补数页数安全阀
  const HYDRATE_PAGE_LIMIT = 200;

  /* 个人版「今天」档 → 「近3天」：与企业版的 3d 档对齐。
   * 个人版只有 今天 / 7天 / 30天 三档，企业版有 3d。平台不改，脚本补：
   * ① 档位按钮文案换成「近3天」；② 请求体的 startTime 前移 2 天（平台区间只由
   * startTime / endTime 决定，见 README §三的取证），于是表格与图表一起变成 3 天。
   * 只改文案不改请求，按钮写「近3天」而表格只有 1 天，自相矛盾 —— 所以必须成对做。
   * 设为 1 或更小即彻底关闭（恢复平台原生「今天」档）。
   */
  const PERSONAL_TODAY_DAYS = 3;
  const PERSONAL_TODAY_LABEL = "近3天";
  const PERSONAL_TODAY_RANGE_KEY = "3d";

  const NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const DATETIME_TEXT_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}/;
  const NUMERIC_TEXT_RE = /^[\d,]+(?:\.\d+)?$/;

  function parseNumber(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : NaN;
    }
    if (value == null) {
      return NaN;
    }
    const text = String(value).replace(/[^\d.-]/g, "");
    // 空串、占位符不能当 0：Number("") === 0 会把「没数据」算成「消耗 0」，
    // 也会让空白行混进记录池。
    if (!text || !/\d/.test(text)) {
      return NaN;
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function parseDateTime(value) {
    if (!value && value !== 0) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.getTime();
    }
    if (typeof value === "number") {
      return value > 1e12 ? value : value * 1000;
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }
    if (/^\d{10,13}$/.test(text)) {
      const numeric = Number(text);
      return text.length === 13 ? numeric : numeric * 1000;
    }
    const match = text.match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
    );
    if (match) {
      const time = Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4] || 0) - 8,
        Number(match[5] || 0),
        Number(match[6] || 0)
      );
      return Number.isNaN(time) ? null : time;
    }
    const fallback = new Date(text.replace(/\//g, "-").replace(" ", "T"));
    return Number.isNaN(fallback.getTime()) ? null : fallback.getTime();
  }

  function normalizeDateOnly(value) {
    if (!value) {
      return "";
    }
    const match = String(value).trim().match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!match) {
      return "";
    }
    return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  }

  function normalizeDateTime(value) {
    const time = parseDateTime(value);
    if (!time) {
      return "";
    }
    // 输出按北京时间（UTC+8）还原，保证与页面显示一致
    const date = new Date(time + 8 * HOUR_MS);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
      date.getUTCDate()
    )} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }

  function parseDateOnly(value) {
    const normalized = normalizeDateOnly(value);
    if (!normalized) {
      return null;
    }
    const [year, month, day] = normalized.split("-").map(Number);
    const time = Date.UTC(year, month - 1, day);
    return Number.isNaN(time) ? null : time;
  }

  function startOfDay(value) {
    const date = new Date(value + 8 * HOUR_MS);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - 8 * HOUR_MS;
  }

  function endOfDay(value) {
    return startOfDay(value) + DAY_MS - 1;
  }

  function startOfHour(value) {
    return Math.floor((value + 8 * HOUR_MS) / HOUR_MS) * HOUR_MS - 8 * HOUR_MS;
  }

  function formatDateOnly(timestamp) {
    const date = new Date(timestamp + 8 * HOUR_MS);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function formatAxisLabel(timestamp, unit, index) {
    const date = new Date(timestamp + 8 * HOUR_MS);
    const monthDay = `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    if (unit === "hour") {
      const hour = pad(date.getUTCHours());
      return date.getUTCHours() === 0 || index === 0 ? `${monthDay} ${hour}:00` : `${hour}:00`;
    }
    return monthDay;
  }

  function formatTooltipLabel(timestamp, unit) {
    const date = new Date(timestamp + 8 * HOUR_MS);
    const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    return unit === "hour" ? `${day} ${pad(date.getUTCHours())}:00` : day;
  }

  function formatAxisValue(value) {
    if (value >= 1000) {
      const fixed = value >= 10000 ? 0 : 1;
      return `${Number((value / 1000).toFixed(fixed))}K`;
    }
    if (value >= 10) {
      return Number(value.toFixed(0)).toString();
    }
    if (value >= 1) {
      return Number(value.toFixed(1)).toString();
    }
    return Number(value.toFixed(2)).toString();
  }

  function formatRangeSummary(uiState, unit) {
    if (!uiState.startDate || !uiState.endDate) {
      return "未识别范围";
    }
    return `${uiState.startDate} ~ ${uiState.endDate} · ${
      unit === "hour" ? "按小时" : "按天"
    }聚合`;
  }

  function formatCredit(value) {
    return NUMBER_FORMATTER.format(Number(value) || 0);
  }

  function formatPercent(value) {
    const number = Number(value) || 0;
    return `${(number * 100).toFixed(number * 100 >= 10 ? 0 : 1)}%`;
  }

  function getLabelStep(bucketCount, plotWidth, unit) {
    const minSpacing = unit === "hour" ? 62 : 48;
    return Math.max(1, Math.ceil((bucketCount * minSpacing) / Math.max(plotWidth, 1)));
  }

  function getNiceScale(maxValue) {
    if (!maxValue || maxValue <= 0) {
      return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
    }
    const roughStep = maxValue / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const residual = roughStep / magnitude;
    let niceResidual = 1;
    if (residual > 5) {
      niceResidual = 10;
    } else if (residual > 2) {
      niceResidual = 5;
    } else if (residual > 1) {
      niceResidual = 2;
    }
    const step = niceResidual * magnitude;
    const max = Math.ceil(maxValue / step) * step;
    const ticks = [];
    for (let tick = 0; tick <= max + step * 0.001; tick += step) {
      ticks.push(Number(tick.toFixed(10)));
    }
    return { max, ticks };
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function makeStableId(prefix, raw) {
    const hash = hashText(`${prefix}:${raw}`);
    return `${prefix}-${(hash >>> 0).toString(16)}`;
  }

  function determineUnit(rangeKey, startDate, endDate) {
    if (rangeKey === "3d" || rangeKey === "today") {
      return "hour";
    }
    if (rangeKey === "7d" || rangeKey === "30d") {
      return "day";
    }
    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);
    if (!start || !end) {
      return "day";
    }
    const diffDays = Math.floor((startOfDay(end) - startOfDay(start)) / DAY_MS) + 1;
    return diffDays <= 3 ? "hour" : "day";
  }

  function alignRangeToLabel(uiState, nowMs) {
    if (!ALIGN_RANGE_TO_LABEL || !uiState) {
      return uiState;
    }
    const days = RANGE_LABEL_DAYS[uiState.rangeKey];
    if (!days || !uiState.startDate || !uiState.endDate) {
      return uiState;
    }
    const start = parseDateOnly(uiState.startDate);
    const end = parseDateOnly(uiState.endDate);
    if (!start || !end) {
      return uiState;
    }

    const span = Math.round((startOfDay(end) - startOfDay(start)) / DAY_MS) + 1;
    const endsToday = startOfDay(end) === startOfDay(nowMs == null ? Date.now() : nowMs);
    if (span !== days + 1 || !endsToday) {
      return uiState;
    }

    const alignedStart = startOfDay(end) - (days - 1) * DAY_MS;
    return {
      ...uiState,
      startDate: formatDateOnly(alignedStart),
      unit: determineUnit(uiState.rangeKey, formatDateOnly(alignedStart), uiState.endDate),
      rangeAdjusted: {
        labelDays: days,
        platformDays: span,
        droppedDate: uiState.startDate,
      },
    };
  }

  function describeRangeAdjustment(uiState) {
    const info = uiState && uiState.rangeAdjusted;
    if (!info) {
      return "";
    }
    return `平台${info.labelDays}天档实为${info.platformDays}天，已按${info.labelDays}天截取`;
  }

  /** 校准质量说明：只要有一天明细覆盖不足就提示（整天全降级时更要提示） */
  function describeCalibration(stats) {
    if (!stats || !stats.days || !stats.degraded) {
      return "";
    }
    return `明细覆盖不足，${stats.degraded} 天按汇总直取`;
  }

  /**
   * 个人版「今天」档在脚本接管后等同于 3 天档：把档位键改写成 3d，
   * 让粒度（按小时）、区间推算、截齐判断都走企业版 3d 的同一套逻辑。
   */
  function resolvePersonalTodayRangeKey(rangeKey, todayDays) {
    const days = Number(todayDays == null ? PERSONAL_TODAY_DAYS : todayDays);
    if (!(days > 1)) {
      return rangeKey;
    }
    return rangeKey === "today" ? PERSONAL_TODAY_RANGE_KEY : rangeKey;
  }

  /** 按预设档位推算区间（含今天共 N 天），口径与档位标签一致 */
  function presetDateRange(rangeKey, nowMs) {
    const days = RANGE_LABEL_DAYS[rangeKey] || 0;
    if (!days) {
      return { startDate: "", endDate: "" };
    }
    const today = startOfDay(nowMs == null ? Date.now() : nowMs);
    return {
      startDate: formatDateOnly(today - (days - 1) * DAY_MS),
      endDate: formatDateOnly(today),
    };
  }

  /**
   * 把「今天档」的请求区间扩成 N 天：平台区间的唯一来源就是请求体的
   * startTime / endTime，而在请求层改写是唯一能让「表格 + 图表」同时对齐的办法
   * （只改图表会让按钮与表格互相矛盾）。
   * 只在请求区间恰为「今天 00:00:00 ~ 今天 23:59:59」时命中，其它档位与手动区间原样放过。
   * @returns {string|null} 改写后的请求体；未命中返回 null
   */
  function rewriteTodayRequestRange(bodyText, nowMs, days) {
    const span = Number(days == null ? PERSONAL_TODAY_DAYS : days);
    if (!bodyText || typeof bodyText !== "string" || !(span > 1)) {
      return null;
    }
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (error) {
      return null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const startText = payload.startTime;
    const endText = payload.endTime;
    if (typeof startText !== "string" || typeof endText !== "string") {
      return null;
    }
    const today = formatDateOnly(startOfDay(nowMs == null ? Date.now() : nowMs));
    if (normalizeDateOnly(startText) !== today || normalizeDateOnly(endText) !== today) {
      return null;
    }
    const preset = presetDateRange(PERSONAL_TODAY_RANGE_KEY, nowMs);
    if (!preset.startDate) {
      return null;
    }
    if (preset.startDate === today) {
      return null;
    }
    payload.startTime = `${preset.startDate} ${String(startText).slice(11) || "00:00:00"}`;
    return JSON.stringify(payload);
  }

  function buildSignature(startDate, endDate, rangeKey, unit) {
    return [startDate || "na", endDate || "na", rangeKey || "custom", unit || "day"].join("|");
  }

  function parseSignature(signature) {
    const parts = String(signature || "").split("|");
    return {
      startDate: parts[0] && parts[0] !== "na" ? parts[0] : "",
      endDate: parts[1] && parts[1] !== "na" ? parts[1] : "",
      rangeKey: parts[2] === "custom" ? "" : parts[2] || "",
      unit: parts[3] || "day",
    };
  }

  function getStateSignature(uiState) {
    return buildSignature(uiState.startDate, uiState.endDate, uiState.rangeKey, uiState.unit);
  }

  function isUiStateForSignature(uiState, signature) {
    return Boolean(uiState && signature && getStateSignature(uiState) === signature);
  }

  function getRangeBounds(uiState, unit) {
    if (!uiState.startDate || !uiState.endDate) {
      return null;
    }
    const start = parseDateOnly(uiState.startDate);
    const end = parseDateOnly(uiState.endDate);
    if (!start || !end) {
      return null;
    }
    const filterStart = startOfDay(start);
    const filterEnd = endOfDay(end);
    if (unit === "hour") {
      return {
        filterStart,
        filterEnd,
        firstBucketStart: filterStart,
        lastBucketStart: startOfHour(filterEnd),
      };
    }
    return {
      filterStart,
      filterEnd,
      firstBucketStart: startOfDay(start),
      lastBucketStart: startOfDay(end),
    };
  }

  function dedupeRecords(records) {
    const unique = new Map();
    records.forEach((record) => {
      unique.set(record.requestId, mergeUsageRecords(unique.get(record.requestId), record));
    });
    return Array.from(unique.values()).sort(
      (left, right) => parseDateTime(left.requestTime) - parseDateTime(right.requestTime)
    );
  }

  function fingerprintRecords(records) {
    const total = records.reduce((sum, record) => sum + record.credit, 0);
    const first = records[0] ? records[0].requestTime : "na";
    const last = records[records.length - 1] ? records[records.length - 1].requestTime : "na";
    return `${records.length}:${first}:${last}:${total.toFixed(2)}`;
  }

  function mergeUsageRecords(existingRecord, incomingRecord) {
    if (!existingRecord) {
      return incomingRecord;
    }
    if (!incomingRecord) {
      return existingRecord;
    }
    const existingModel = normalizeModelName(existingRecord.modelName);
    const incomingModel = normalizeModelName(incomingRecord.modelName);
    if (existingModel === UNKNOWN_MODEL_NAME && incomingModel !== UNKNOWN_MODEL_NAME) {
      return { ...existingRecord, ...incomingRecord, modelName: incomingModel };
    }
    if (existingModel !== UNKNOWN_MODEL_NAME && incomingModel === UNKNOWN_MODEL_NAME) {
      return { ...existingRecord, ...incomingRecord, modelName: existingModel };
    }
    return { ...existingRecord, ...incomingRecord };
  }

  function getFirstValue(object, keys) {
    for (const key of keys) {
      if (object[key] != null && object[key] !== "") {
        return object[key];
      }
    }
    return null;
  }

  function normalizeModelName(value) {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!text || text === "[object Object]") {
      return UNKNOWN_MODEL_NAME;
    }
    return text;
  }

  function normalizeModelValue(value) {
    if (value == null || value === "") {
      return "";
    }
    if (typeof value === "string" || typeof value === "number") {
      const normalized = normalizeModelName(String(value));
      return normalized === UNKNOWN_MODEL_NAME ? "" : normalized;
    }
    if (typeof value === "object") {
      const nested = getFirstValue(value, [
        "name", "model", "modelName", "model_name", "id", "modelId", "engine",
      ]);
      return nested != null ? normalizeModelValue(nested) : "";
    }
    return "";
  }

  function extractModelName(record) {
    for (const key of ["model", "modelName", "model_name", "llmModel", "engine", "modelId"]) {
      const normalized = normalizeModelValue(record[key]);
      if (normalized) {
        return normalized;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (!/(model|engine)/i.test(key)) {
        continue;
      }
      const normalized = normalizeModelValue(value);
      if (normalized) {
        return normalized;
      }
    }
    return UNKNOWN_MODEL_NAME;
  }

  function normalizeUsageRecord(record) {
    if (!record || typeof record !== "object") {
      return null;
    }
    const requestId =
      getFirstValue(record, ["requestId", "requestID", "reqId", "id"]) || null;
    const credit = parseNumber(
      getFirstValue(record, ["credit", "credits", "creditCost", "consumeCredit", "cost"])
    );
    const requestTime =
      getFirstValue(record, [
        "requestTime", "request_time", "time", "date", "createdAt", "created_at", "timestamp",
      ]) || null;
    const normalizedTime = normalizeDateTime(requestTime);
    if (!Number.isFinite(credit) || !normalizedTime) {
      return null;
    }
    return {
      // 只用短字段拼指纹：响应里可能带很长的 input 正文
      requestId:
        requestId ||
        makeStableId("rec", `${normalizedTime}|${credit}|${String(record.model || "")}`),
      credit,
      requestTime: normalizedTime,
      modelName: extractModelName(record),
    };
  }

  function scoreCandidateArray(array, key, parentObject) {
    if (!array.length || typeof array[0] !== "object" || Array.isArray(array[0])) {
      return null;
    }

    const records = [];
    for (const item of array) {
      const normalized = normalizeUsageRecord(item);
      if (normalized) {
        records.push(normalized);
      }
    }
    if (!records.length) {
      return null;
    }

    let fieldHits = 0;
    for (const item of array.slice(0, Math.min(array.length, 8))) {
      const keys = Object.keys(item || {}).map((name) => name.toLowerCase());
      if (keys.some((name) => name === "requestid")) {
        fieldHits += 4;
      }
      if (keys.some((name) => name.includes("credit"))) {
        fieldHits += 4;
      }
      if (keys.some((name) => name.includes("requesttime") || name === "time" || name === "date")) {
        fieldHits += 4;
      }
      if (keys.some((name) => name.includes("model") || name.includes("engine"))) {
        fieldHits += 2;
      }
    }

    const keyBonus = /record|list|item|data|usage|detail/i.test(key || "") ? 6 : 0;
    return {
      records: dedupeRecords(records),
      total: extractTotal(parentObject),
      score: fieldHits + keyBonus + Math.min(records.length, 48),
    };
  }

  function extractUsageRecords(payload) {
    const seen = new WeakSet();
    let best = null;

    const visit = (node, parentKey, parentObject) => {
      if (!node || typeof node !== "object" || seen.has(node)) {
        return;
      }
      seen.add(node);

      if (Array.isArray(node)) {
        const candidate = scoreCandidateArray(node, parentKey, parentObject);
        if (candidate && (!best || candidate.score > best.score)) {
          best = candidate;
        }
        for (const item of node) {
          visit(item, parentKey, parentObject);
        }
        return;
      }

      for (const [key, value] of Object.entries(node)) {
        visit(value, key, node);
      }
    };

    visit(payload, "", null);
    return best;
  }

  function extractTotal(parentObject) {
    if (!parentObject || typeof parentObject !== "object") {
      return null;
    }
    for (const key of ["totalCount", "recordCount", "recordsTotal", "totalRecords", "total"]) {
      const value = parentObject[key];
      if (Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
    if (parentObject.pagination && Number.isFinite(Number(parentObject.pagination.total))) {
      return Number(parentObject.pagination.total);
    }
    return null;
  }

  function extractRangeHint(meta, originOverride) {
    const values = new URLSearchParams();
    const base = originOverride ||
      (typeof location !== "undefined" ? location.origin : "http://localhost");
    const href = typeof location !== "undefined" ? location.href : base;
    try {
      const url = new URL(meta && meta.url ? meta.url : href, base);
      url.searchParams.forEach((value, key) => values.append(key, value));
    } catch (error) {
      // ignore
    }
    if (meta && typeof meta.body === "string" && meta.body) {
      const body = meta.body.trim();
      if (body.startsWith("{")) {
        try {
          flattenObject(JSON.parse(body)).forEach(([key, value]) =>
            values.append(key, String(value))
          );
        } catch (error) {
          // ignore
        }
      } else {
        new URLSearchParams(body).forEach((value, key) => values.append(key, value));
      }
    }

    let startDate = "";
    let endDate = "";
    let rangeKey = "";
    values.forEach((value, key) => {
      const normalizedKey = key.toLowerCase();
      const normalizedValue = String(value).trim();
      if (!normalizedValue) {
        return;
      }
      if (!startDate && /(start|from|begin)/i.test(normalizedKey)) {
        startDate = normalizeDateOnly(normalizedValue);
      }
      if (!endDate && /(end|to|finish)/i.test(normalizedKey)) {
        endDate = normalizeDateOnly(normalizedValue);
      }
      if (!rangeKey) {
        const hit = normalizedValue.toLowerCase().match(/\b(today|3d|7d|30d)\b/);
        if (hit && /(range|period|preset|type|days|key)/i.test(normalizedKey)) {
          rangeKey = hit[1];
        }
      }
    });
    return { startDate, endDate, rangeKey };
  }

  function flattenObject(object, prefix = "", result = []) {
    if (!object || typeof object !== "object") {
      return result;
    }
    Object.entries(object).forEach(([key, value]) => {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        flattenObject(value, fullKey, result);
      } else if (!Array.isArray(value)) {
        result.push([fullKey, value]);
      }
    });
    return result;
  }

  /**
   * 用「按天汇总」校准「请求明细」。
   *
   * 明细接口有 2-3 小时延迟，直接求和会明显低于页面汇总（实测 512 vs 645），
   * 所以按天取汇总值，把当天明细的（时段 × 模型）分布等比缩放过去。
   *
   * 缩放的前提是「明细基本覆盖了当天」。若某天明细只覆盖很小一部分
   * （刚过零点、分页失败、接口抽风），等比放大等于把整天的消耗塞进那几小时，
   * 分布会严重失真 —— 这种天降级为「整日一条」，并如实计入 stats.degraded。
   */
  function calibrateSeries(dailyRecords, detailRecords, options) {
    const minCoverage = (options && options.minCoverage) || 0.5;
    const stats = { days: 0, calibrated: 0, degraded: 0, missing: 0, coverage: 0 };

    if (!dailyRecords || !dailyRecords.length) {
      return { records: detailRecords || [], stats };
    }
    if (!detailRecords || !detailRecords.length) {
      stats.days = dailyRecords.length;
      stats.missing = dailyRecords.length;
      return { records: dailyRecords, stats };
    }

    const detailByDate = new Map();
    for (const record of detailRecords) {
      const time = parseDateTime(record.requestTime);
      if (!time) {
        continue;
      }
      const date = formatDateOnly(startOfDay(time));
      if (!detailByDate.has(date)) {
        detailByDate.set(date, []);
      }
      detailByDate.get(date).push(record);
    }

    const output = [];
    let dailySumAll = 0;
    let detailSumAll = 0;

    for (const item of dailyRecords) {
      // daily 记录可能来自接口原始结构（date）或已规范化的记录（requestTime）
      const itemTime = parseDateTime(item && (item.requestTime || item.date));
      const date = itemTime ? formatDateOnly(startOfDay(itemTime)) : "";
      const target = parseNumber(item && item.credit);
      if (!date || !Number.isFinite(target) || target <= 0) {
        continue;
      }
      stats.days += 1;
      dailySumAll += target;

      const dayRecords = detailByDate.get(date) || [];
      const daySum = dayRecords.reduce((sum, record) => sum + record.credit, 0);
      detailSumAll += daySum;

      const fallback = () => {
        output.push({
          requestId: `daily-${date}`,
          credit: target,
          requestTime: `${date} 00:00:00`,
          modelName: UNKNOWN_MODEL_NAME,
        });
      };

      if (!dayRecords.length || daySum <= 0) {
        stats.missing += 1;
        fallback();
        continue;
      }

      if (daySum / target < minCoverage) {
        stats.degraded += 1;
        fallback();
        continue;
      }

      stats.calibrated += 1;

      // 按 (时段, 模型) 分组后等比缩放，保证求和精确等于汇总值
      const groups = new Map();
      for (const record of dayRecords) {
        const time = parseDateTime(record.requestTime);
        const slot = startOfHour(time);
        const model = normalizeModelName(record.modelName);
        const key = `${slot}|${model}`;
        const current = groups.get(key) || { slot, model, credit: 0, time: record.requestTime };
        current.credit += record.credit;
        groups.set(key, current);
      }

      const scale = target / daySum;
      const list = Array.from(groups.values());
      let assigned = 0;
      list.forEach((group, index) => {
        const isLast = index === list.length - 1;
        const credit = isLast
          ? Number((target - assigned).toFixed(4))
          : Number((group.credit * scale).toFixed(4));
        assigned += credit;
        output.push({
          requestId: `cal-${date}-${index}`,
          credit,
          requestTime: group.time,
          modelName: group.model,
        });
      });
    }

    stats.coverage = dailySumAll > 0 ? detailSumAll / dailySumAll : 0;
    return { records: output.length ? output : detailRecords, stats };
  }

  function encodeTooltipBreakdown(items) {
    try {
      return encodeURIComponent(
        JSON.stringify(
          (items || []).map((item) => ({
            name: item.name,
            value: item.value,
            share: item.share,
            color: item.color,
          }))
        )
      );
    } catch (error) {
      return "";
    }
  }

  function decodeTooltipBreakdown(value) {
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(decodeURIComponent(value));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function buildTooltipBreakdownHtml(items) {
    if (!items.length) {
      return "";
    }
    return items
      .map(
        (item) => `
          <div class="cbuc-tooltip-row">
            <span class="cbuc-tooltip-swatch" style="background:${escapeHtml(item.color)}"></span>
            <span class="cbuc-tooltip-model">${escapeHtml(item.name)}</span>
            <span class="cbuc-tooltip-credit">${escapeHtml(formatCredit(item.value))}</span>
            <span class="cbuc-tooltip-share">${escapeHtml(formatPercent(item.share))}</span>
          </div>
        `
      )
      .join("");
  }

  function getExpectedCount(dataset, uiState, extracted) {
    const candidates = [
      dataset && dataset.totalExpected,
      extracted && extracted.total,
      uiState && uiState.totalCount,
    ].filter((value) => Number.isFinite(value) && value > 0);
    if (!candidates.length) {
      return null;
    }
    const expected = Math.max(...candidates);
    // 平台给的总条数覆盖 N+1 天，按天数折算到截齐后的区间，
    // 否则永远判定「部分覆盖」
    const adjusted = uiState && uiState.rangeAdjusted;
    if (adjusted && adjusted.platformDays > 0) {
      return Math.max(1, Math.floor((expected * adjusted.labelDays) / adjusted.platformDays));
    }
    return expected;
  }

  /**
   * 按区间把记录切成时间桶并汇总模型占比。
   * 纯计算：颜色由 colorFn 注入，便于在 node 里直接测试分桶边界。
   */
  /**
   * 决定实际绘制粒度：按小时画超宽区间会产生上千个柱子（SVG 节点爆炸、也看不清），
   * 超过 maxBuckets 就退回按天。
   */
  function resolveGranularity(uiState, unit, maxBuckets) {
    if (unit !== "hour") {
      return { unit, downgraded: false, buckets: 0 };
    }
    const range = getRangeBounds(uiState, "hour");
    const buckets = range
      ? Math.floor((range.lastBucketStart - range.firstBucketStart) / HOUR_MS) + 1
      : 0;
    if (buckets > (maxBuckets || 240)) {
      return { unit: "day", downgraded: true, buckets };
    }
    return { unit, downgraded: false, buckets };
  }

  function bucketizeRecords(records, range, unit, colorFn) {
    if (!range) {
      return { buckets: [], maxValue: 0, total: 0, unit, modelTotals: [] };
    }

    const step = unit === "hour" ? HOUR_MS : DAY_MS;
    const bucketCount = Math.floor((range.lastBucketStart - range.firstBucketStart) / step) + 1;
    const buckets = [];

    for (let index = 0; index < bucketCount; index += 1) {
      const bucketStart = range.firstBucketStart + index * step;
      buckets.push({
        start: bucketStart,
        value: 0,
        axisLabel: formatAxisLabel(bucketStart, unit, index),
        tooltipTitle: formatTooltipLabel(bucketStart, unit),
        models: new Map(),
        stackSegments: [],
        tooltipModels: [],
      });
    }

    const modelTotals = new Map();
    records.forEach((record) => {
      const time = parseDateTime(record.requestTime);
      if (!time || time < range.filterStart || time > range.filterEnd) {
        return;
      }
      const bucketStart = unit === "hour" ? startOfHour(time) : startOfDay(time);
      const index = Math.floor((bucketStart - range.firstBucketStart) / step);
      if (index < 0 || index >= buckets.length) {
        return;
      }
      const modelName = normalizeModelName(record.modelName);
      buckets[index].value += record.credit;
      buckets[index].models.set(modelName, (buckets[index].models.get(modelName) || 0) + record.credit);
      modelTotals.set(modelName, (modelTotals.get(modelName) || 0) + record.credit);
    });

    const sortedModelTotals = Array.from(modelTotals.entries())
      .filter((entry) => entry[1] > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
      .map(([name, value]) => ({ name, value, color: colorFn(name) }));

    buckets.forEach((bucket) => {
      bucket.tooltipModels = Array.from(bucket.models.entries())
        .filter((entry) => entry[1] > 0)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
        .map(([name, value]) => ({
          name,
          value,
          share: bucket.value > 0 ? value / bucket.value : 0,
          color: colorFn(name),
        }));
      bucket.stackSegments = sortedModelTotals
        .map((model) => ({
          name: model.name,
          value: bucket.models.get(model.name) || 0,
          color: model.color,
        }))
        .filter((segment) => segment.value > 0);
    });

    const maxValue = Math.max(0, ...buckets.map((bucket) => bucket.value));
    const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0);

    return { buckets, maxValue, total, unit, modelTotals: sortedModelTotals };
  }

export {
  DAY_MS,
  HOUR_MS,
  UNKNOWN_MODEL_NAME,
  ALIGN_RANGE_TO_LABEL,
  RANGE_LABEL_DAYS,
  HYDRATE_PAGE_LIMIT,
  PERSONAL_TODAY_DAYS,
  PERSONAL_TODAY_LABEL,
  PERSONAL_TODAY_RANGE_KEY,
  resolvePersonalTodayRangeKey,
  presetDateRange,
  rewriteTodayRequestRange,
  NUMBER_FORMATTER,
  DATETIME_TEXT_RE,
  NUMERIC_TEXT_RE,
  parseNumber,
  parseDateTime,
  normalizeDateOnly,
  normalizeDateTime,
  parseDateOnly,
  startOfDay,
  endOfDay,
  startOfHour,
  formatDateOnly,
  formatAxisLabel,
  formatTooltipLabel,
  formatAxisValue,
  formatRangeSummary,
  formatCredit,
  formatPercent,
  getLabelStep,
  getNiceScale,
  pad,
  escapeHtml,
  hashText,
  makeStableId,
  determineUnit,
  alignRangeToLabel,
  describeRangeAdjustment,
  buildSignature,
  parseSignature,
  getStateSignature,
  isUiStateForSignature,
  getRangeBounds,
  dedupeRecords,
  fingerprintRecords,
  mergeUsageRecords,
  getFirstValue,
  normalizeModelName,
  normalizeModelValue,
  extractModelName,
  normalizeUsageRecord,
  scoreCandidateArray,
  extractUsageRecords,
  extractTotal,
  extractRangeHint,
  flattenObject,
  calibrateSeries,
  describeCalibration,
  encodeTooltipBreakdown,
  decodeTooltipBreakdown,
  buildTooltipBreakdownHtml,
  getExpectedCount,
  resolveGranularity,
  bucketizeRecords,
};
