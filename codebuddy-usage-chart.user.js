// ==UserScript==
// @name         CodeBuddy / WorkBuddy Usage Credit Chart
// @namespace    https://github.com/lixy1998/codebuddy-usage-chart
// @version      0.6.0
// @description  Add a credit usage chart above the usage tables of CodeBuddy / WorkBuddy (personal & enterprise).
// @license      MIT
// @author       lixy1998
// @match        https://www.codebuddy.cn/profile/plans-usage*
// @match        https://www.workbuddy.cn/profile/plans-usage*
// @match        https://www.workbuddy.cn/profile/usage*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/lixy1998/codebuddy-usage-chart
// @supportURL   https://github.com/lixy1998/codebuddy-usage-chart/issues
// @downloadURL  https://raw.githubusercontent.com/lixy1998/codebuddy-usage-chart/main/codebuddy-usage-chart.user.js
// @updateURL    https://raw.githubusercontent.com/lixy1998/codebuddy-usage-chart/main/codebuddy-usage-chart.user.js
// ==/UserScript==

/* 由 build.mjs 生成，请勿直接编辑：改 src/core.js 或 src/main.js 后重新构建 */
(function () {
  "use strict";

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

  function alignRangeToLabel(uiState) {
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
    const endsToday = startOfDay(end) === startOfDay(Date.now());
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

/* 页面层：DOM 适配、数据源、渲染与交互。构建脚本把它接在 core.js 之后。 */

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  const SCRIPT_ID = "cbuc-script";
  const STYLE_ID = "cbuc-style";
  const ROOT_ID = "cbuc-root";
  const PAYLOAD_EVENT = "cbuc:payload";
  const BRIDGE_FLAG = "__CBUC_PAGE_BRIDGE__";
  const HYDRATE_HEADER = "x-cbuc-hydrate";
  const SCHEDULE_DELAY = 120;
  const POOL_LIMIT = 20000;
  const API_TIMEOUT = 15000;
  const API_PAGE_LIMIT = 40;
  // 企业版游标分页：pageSize 100 与页面自带选项一致；传 500 服务端会按内部批次
  // 截断并提前关闭游标（实测 119 条只回 103 条），必须以 100 逐页跟随 token。
  const API_PAGE_SIZE = 100;

  // 个人版补数的页大小：表格自身默认 10 条/页，30 天档要翻 100+ 页；
  // 接口实测支持 100（10/50/100 均 200 OK），提上来后同样数据只需十余页。
  const HYDRATE_PAGE_SIZE = 100;

  const MODEL_COLOR_PALETTE = [
    "#6f90d6", "#6fb7a7", "#d49c74", "#cdb37a", "#c8849f",
    "#8b92d6", "#6ea6c8", "#94b06d", "#a887c8", "#cb8f76",
  ];

  // 接口结果缓存 60s：切回来立刻看到旧数据（同时后台刷新），过期后自动换新
  const API_CACHE_TTL = 60 * 1000;
  // 失败后 30s 内不重复打接口，避免抖动时连环请求
  const API_ERROR_COOLDOWN = 30 * 1000;
  // 网络错误 / 429 / 5xx 的退避重试
  const API_RETRY_LIMIT = 2;
  const API_RETRY_BASE_MS = 400;
  // 单图最多绘制的柱数：超过就降级到天粒度，避免上千个 SVG 节点
  const MAX_BUCKETS = 240;

  // 企业版接口：与页面自身使用的端点一致（同源、带 cookie，无需额外鉴权头）
  const EP = {
    request: "/billing/meter/get-user-request-usage",
    daily: "/billing/meter/get-user-daily-usage",
  };



  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  const state = {
    recordPool: new Map(),
    datasets: new Map(),
    hydrationJobs: new Map(),
    apiCache: new Map(),
    apiRefreshing: new Set(),

    mounted: false,
    scheduleTimer: null,
    usageRoot: null,
    chartRoot: null,
    adapterId: "",

    lastUiFingerprint: "",
    lastDataFingerprint: "",
    lastRenderWidth: 0,
    lastPayloadHash: "",

    resizeObserver: null,
    mutationObserver: null,
    syncing: false,

    interactionHintUntil: 0,
    tooltipCleanup: null,
    splitByModel: false,
    modelColors: new Map(),
    nextModelColorIndex: 0,
    themeVars: null,
  };

  init();

  /* ------------------------------------------------------------------ *
   * 调试开关
   * 打开方式：控制台执行 __CBUC_DEBUG = true（或在 localStorage 里
   * 写 cbuc_debug=1 后刷新）。打开后会打印区间解析、数据源选择、
   * 接口耗时、校准统计等中间态，便于排查「为什么图不对」。
   * ------------------------------------------------------------------ */

  function isDebugEnabled() {
    try {
      if (window.__CBUC_DEBUG === true) {
        return true;
      }
      return window.localStorage.getItem("cbuc_debug") === "1";
    } catch (error) {
      return false;
    }
  }

  function debugLog(event, data) {
    if (!isDebugEnabled()) {
      return;
    }
    try {
      console.log("[CBUC]", event, data === undefined ? "" : data);
    } catch (error) {
      // 忽略日志失败
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function init() {
    injectPageBridge();
    ensureStyles();
    window.addEventListener(PAYLOAD_EVENT, handleBridgePayload, false);
    document.addEventListener("click", handleUserInteraction, true);
    document.addEventListener("change", handleUserInteraction, true);
    observeDocument();
    whenReady(() => scheduleSync("init"));
  }

  /**
   * 装网络钩子。@grant none 时脚本本来就跑在页面上下文，直接打补丁即可，
   * 不必再插 <script>（严格 CSP 的站点会拦掉内联脚本）。
   * 只有存在沙箱迹象（管理器注入了 unsafeWindow）时才回退到注入方式。
   */
  function injectPageBridge() {
    if (document.documentElement && document.documentElement.hasAttribute(`data-${SCRIPT_ID}`)) {
      return;
    }

    const config = {
      eventName: PAYLOAD_EVENT,
      flag: BRIDGE_FLAG,
      skipHeader: HYDRATE_HEADER,
    };

    const inPageContext = typeof unsafeWindow === "undefined";
    if (inPageContext) {
      try {
        pageBridge(config);
        debugLog("bridge.direct", { patched: Boolean(window[BRIDGE_FLAG]) });
      } catch (error) {
        console.warn("[CBUC] bridge direct failed", error);
      }
    }

    if (!window[BRIDGE_FLAG]) {
      const target = document.documentElement || document.head || document.body;
      if (!target) {
        whenReady(injectPageBridge);
        return;
      }
      const script = document.createElement("script");
      script.setAttribute(`data-${SCRIPT_ID}`, "true");
      script.textContent = `(${pageBridge.toString()})(${JSON.stringify(config)});`;
      target.appendChild(script);
      script.remove();
      debugLog("bridge.injected", { via: "script" });
    }

    if (document.documentElement) {
      document.documentElement.setAttribute(`data-${SCRIPT_ID}`, "true");
    }
  }

  /**
   * 页面主世界里的网络钩子：捕获 fetch / XHR 的 JSON 响应并转发给沙箱侧。
   * 由本脚本主动发起的补数请求带 x-cbuc-hydrate 头，会被跳过，避免二次解析。
   */
  function pageBridge(config) {
    try {
      if (window[config.flag]) {
        return;
      }
      window[config.flag] = true;

      const shouldInspect = (url, contentType) => {
        if (contentType && /json/i.test(contentType)) {
          return true;
        }
        return /usage|credit|profile|detail|record|consum|bill|request|meter/i.test(url || "");
      };

      const emit = (meta, payload) => {
        try {
          window.dispatchEvent(
            new CustomEvent(config.eventName, { detail: JSON.stringify({ meta, payload }) })
          );
        } catch (error) {
          console.warn("[CBUC] emit failed", error);
        }
      };

      const parseJsonText = (text) => {
        if (!text || typeof text !== "string") {
          return null;
        }
        try {
          return JSON.parse(text);
        } catch (error) {
          return null;
        }
      };

      const normalizeBody = (body) => {
        if (!body) {
          return null;
        }
        if (typeof body === "string") {
          return body;
        }
        if (body instanceof URLSearchParams) {
          return body.toString();
        }
        if (typeof FormData !== "undefined" && body instanceof FormData) {
          const pairs = [];
          body.forEach((value, key) => {
            pairs.push([key, typeof value === "string" ? value : String(value)]);
          });
          return new URLSearchParams(pairs).toString();
        }
        return null;
      };

      const normalizeHeaders = (headers) => {
        if (!headers) {
          return null;
        }
        if (typeof Headers !== "undefined" && headers instanceof Headers) {
          const result = {};
          headers.forEach((value, key) => {
            result[key] = value;
          });
          return result;
        }
        if (Array.isArray(headers)) {
          const result = {};
          headers.forEach((entry) => {
            if (Array.isArray(entry) && entry.length >= 2) {
              result[String(entry[0])] = String(entry[1]);
            }
          });
          return result;
        }
        if (typeof headers === "object") {
          return Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [String(key), String(value)])
          );
        }
        return null;
      };

      const isOwnRequest = (headers) => {
        if (!headers) {
          return false;
        }
        return Object.keys(headers).some(
          (key) => key.toLowerCase() === config.skipHeader
        );
      };

      const originalFetch = window.fetch;
      if (typeof originalFetch === "function") {
        window.fetch = function patchedFetch(input, init) {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          const method =
            (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
          let headers = null;
          try {
            headers =
              normalizeHeaders(init && init.headers) ||
              normalizeHeaders(input && typeof input === "object" && input.headers);
          } catch (error) {
            headers = null;
          }

          const meta = {
            channel: "fetch",
            url,
            method,
            body: (init && normalizeBody(init.body)) || null,
            headers,
            timestamp: Date.now(),
          };
          const skip = isOwnRequest(headers);

          return originalFetch.apply(this, arguments).then((response) => {
            if (skip) {
              return response;
            }
            try {
              const clone = response.clone();
              const contentType = (clone.headers && clone.headers.get("content-type")) || "";
              if (!shouldInspect(url, contentType)) {
                return response;
              }
              clone
                .text()
                .then((text) => {
                  const payload = parseJsonText(text);
                  if (payload !== null) {
                    emit(meta, payload);
                  }
                })
                .catch(() => {});
            } catch (error) {
              console.warn("[CBUC] fetch clone failed", error);
            }
            return response;
          });
        };
        // 诊断标记：能据此确认钩子确实打在页面主世界
        window.fetch.__cbuc = true;
      }

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__cbucMeta = {
          channel: "xhr",
          url: typeof url === "string" ? url : "",
          method: method || "GET",
          body: null,
          headers: {},
          timestamp: Date.now(),
        };
        return originalOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
        if (this.__cbucMeta && name) {
          this.__cbucMeta.headers[String(name)] = String(value);
        }
        return originalSetRequestHeader.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function patchedSend(body) {
        if (this.__cbucMeta) {
          this.__cbucMeta.body = normalizeBody(body);
        }
        this.addEventListener(
          "load",
          function onLoad() {
            const meta = this.__cbucMeta;
            if (!meta || isOwnRequest(meta.headers)) {
              return;
            }
            const contentType =
              (typeof this.getResponseHeader === "function" &&
                this.getResponseHeader("content-type")) ||
              "";
            if (!shouldInspect(meta.url, contentType)) {
              return;
            }
            let payload = null;
            if (this.responseType === "json") {
              payload = this.response;
            } else if (!this.responseType || this.responseType === "text") {
              payload = parseJsonText(this.responseText);
            }
            if (payload !== null) {
              emit(meta, payload);
            }
          },
          { once: true }
        );
        return originalSend.apply(this, arguments);
      };
    } catch (error) {
      console.warn("[CBUC] bridge init failed", error);
    }
  }

  /* ------------------------------------------------------------------ *
   * 样式
   * ------------------------------------------------------------------ */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const target = document.head || document.documentElement || document.body;
    if (!target) {
      whenReady(ensureStyles);
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        /* dark = CodeBuddy（#191a24 + 紫 #724bff） */
        --cbuc-bg: #191a24;
        --cbuc-border: #4b4b4b;
        --cbuc-panel: #4b4f6d;
        --cbuc-grid: rgba(255, 255, 255, 0.08);
        --cbuc-axis: rgba(255, 255, 255, 0.55);
        --cbuc-muted: rgba(255, 255, 255, 0.55);
        --cbuc-text: #ffffff;
        --cbuc-accent: #724bff;
        --cbuc-accent-strong: #947dff;
        --cbuc-accent-soft: rgba(114, 75, 255, 0.18);
        --cbuc-accent-soft-strong: rgba(114, 75, 255, 0.28);
        --cbuc-accent-border: rgba(114, 75, 255, 0.4);
        --cbuc-accent-border-strong: rgba(148, 125, 255, 0.7);
        --cbuc-unknown-model: #7f8799;
        --cbuc-shadow: 0 18px 42px rgba(0, 0, 0, 0.32);
        --cbuc-canvas-bg: linear-gradient(180deg, rgba(114, 75, 255, 0.04), rgba(114, 75, 255, 0));
        --cbuc-tooltip-bg: #252735;
        --cbuc-tooltip-border: rgba(114, 75, 255, 0.4);
        --cbuc-tooltip-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
        --cbuc-tooltip-title: rgba(255, 255, 255, 0.74);
        --cbuc-tooltip-row: rgba(255, 255, 255, 0.9);
        --cbuc-tooltip-share: rgba(255, 255, 255, 0.55);
        --cbuc-cursor-line: rgba(255, 255, 255, 0.6);
        --cbuc-spinner-track: rgba(255, 255, 255, 0.16);
        --cbuc-swatch-inset: rgba(255, 255, 255, 0.12);
        --cbuc-glow: radial-gradient(circle, rgba(114, 75, 255, 0.18), rgba(114, 75, 255, 0));
        --cbuc-bar-glow: rgba(114, 75, 255, 0.24);

        position: relative;
        margin: 0 0 24px;
        padding: 24px 24px 16px;
        border: 1px solid var(--cbuc-border);
        border-radius: 20px;
        background: var(--cbuc-bg);
        box-shadow: var(--cbuc-shadow);
        overflow: hidden;
        box-sizing: border-box;
        color: var(--cbuc-text);
        font-family: inherit;
      }

      #${ROOT_ID}[data-cbuc-theme="light"] {
        /* light = WorkBuddy（白底 + 薄荷绿 #4ecba0） */
        --cbuc-bg: #ffffff;
        --cbuc-border: #e7eaef;
        --cbuc-panel: #f5f7fa;
        --cbuc-grid: rgba(27, 26, 36, 0.08);
        --cbuc-axis: rgba(27, 26, 36, 0.55);
        --cbuc-muted: rgba(27, 26, 36, 0.6);
        --cbuc-text: #1b1a24;
        --cbuc-accent: #4ecba0;
        --cbuc-accent-strong: #3dbf93;
        --cbuc-accent-soft: rgba(78, 203, 160, 0.12);
        --cbuc-accent-soft-strong: rgba(78, 203, 160, 0.22);
        --cbuc-accent-border: rgba(78, 203, 160, 0.4);
        --cbuc-accent-border-strong: rgba(78, 203, 160, 0.7);
        --cbuc-unknown-model: #9ca0a9;
        --cbuc-shadow: 0 8px 28px rgba(27, 26, 36, 0.06);
        --cbuc-canvas-bg: linear-gradient(180deg, rgba(78, 203, 160, 0.02), rgba(78, 203, 160, 0));
        --cbuc-tooltip-bg: #1b1a24;
        --cbuc-tooltip-border: rgba(78, 203, 160, 0.4);
        --cbuc-tooltip-shadow: 0 10px 30px rgba(27, 26, 36, 0.16);
        --cbuc-tooltip-title: rgba(255, 255, 255, 0.74);
        --cbuc-tooltip-row: rgba(255, 255, 255, 0.9);
        --cbuc-tooltip-share: rgba(255, 255, 255, 0.55);
        --cbuc-cursor-line: rgba(27, 26, 36, 0.35);
        --cbuc-spinner-track: rgba(27, 26, 36, 0.14);
        --cbuc-swatch-inset: rgba(255, 255, 255, 0.2);
        --cbuc-glow: radial-gradient(circle, rgba(78, 203, 160, 0.14), rgba(78, 203, 160, 0));
        --cbuc-bar-glow: rgba(78, 203, 160, 0.2);
      }

      /* 企业版页面本身就是扁平卡片，图表卡跟随其卡片语言 */
      #${ROOT_ID}[data-cbuc-adapter="enterprise"] {
        border-radius: 8px;
        padding: 20px 20px 12px;
        margin-bottom: 24px;
        box-shadow: none;
        background: var(--cbuc-surface, var(--cbuc-bg));
        border-color: var(--cbuc-card-border, var(--cbuc-border));
      }

      #${ROOT_ID}::before {
        content: "";
        position: absolute;
        inset: -80px auto auto -80px;
        width: 220px;
        height: 220px;
        border-radius: 50%;
        background: var(--cbuc-glow);
        pointer-events: none;
      }

      #${ROOT_ID} .cbuc-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 20px;
        margin-bottom: 16px;
      }

      #${ROOT_ID} .cbuc-title {
        font-size: 13px;
        line-height: 18px;
        letter-spacing: 0.08em;
        color: var(--cbuc-axis);
        text-transform: uppercase;
      }

      #${ROOT_ID} .cbuc-total {
        margin-top: 6px;
        font-size: clamp(32px, 4.4vw, 52px);
        line-height: 1;
        font-weight: 800;
        color: var(--cbuc-text);
        font-variant-numeric: tabular-nums;
      }

      #${ROOT_ID} .cbuc-summary {
        display: grid;
        justify-items: end;
        gap: 8px;
        min-width: 190px;
      }

      #${ROOT_ID} .cbuc-summary-top {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      #${ROOT_ID} .cbuc-status {
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--cbuc-panel);
        color: var(--cbuc-muted);
        font-size: 12px;
        line-height: 16px;
        white-space: nowrap;
      }

      #${ROOT_ID} .cbuc-status[data-kind="warning"] {
        color: #b8741a;
        background: rgba(255, 168, 64, 0.16);
      }

      #${ROOT_ID}[data-cbuc-theme="dark"] .cbuc-status[data-kind="warning"] {
        color: #ffd38c;
        background: rgba(255, 186, 82, 0.14);
      }

      #${ROOT_ID} .cbuc-meta {
        color: var(--cbuc-muted);
        font-size: 13px;
        line-height: 18px;
        text-align: right;
      }

      #${ROOT_ID} .cbuc-toggle {
        appearance: none;
        border: 1px solid var(--cbuc-accent-border);
        border-radius: 999px;
        padding: 7px 12px;
        background: var(--cbuc-accent-soft);
        color: var(--cbuc-text);
        font-size: 12px;
        line-height: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease,
          transform 0.15s ease;
      }

      #${ROOT_ID}[data-cbuc-theme="dark"] .cbuc-toggle {
        color: rgba(255, 255, 255, 0.82);
      }

      #${ROOT_ID} .cbuc-toggle:hover:not(:disabled) {
        border-color: var(--cbuc-accent-border-strong);
        transform: translateY(-1px);
      }

      #${ROOT_ID} .cbuc-toggle[aria-pressed="true"] {
        background: var(--cbuc-accent-soft-strong);
        border-color: var(--cbuc-accent-border-strong);
        color: var(--cbuc-text);
      }

      #${ROOT_ID}[data-cbuc-theme="dark"] .cbuc-toggle[aria-pressed="true"] {
        color: #ffffff;
      }

      #${ROOT_ID} .cbuc-toggle:disabled {
        opacity: 0.46;
        cursor: not-allowed;
      }

      #${ROOT_ID} .cbuc-canvas {
        position: relative;
        min-height: 360px;
        border-radius: 14px;
        background: var(--cbuc-canvas-bg);
        overflow: hidden;
      }

      #${ROOT_ID} .cbuc-svg {
        display: block;
        width: 100%;
        height: 360px;
      }

      #${ROOT_ID} .cbuc-legend {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 10px 14px;
        margin-top: 12px;
        color: var(--cbuc-muted);
        font-size: 13px;
        line-height: 18px;
      }

      #${ROOT_ID} .cbuc-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      #${ROOT_ID} .cbuc-legend-swatch {
        width: 16px;
        height: 16px;
        border-radius: 4px;
        background: linear-gradient(180deg, var(--cbuc-accent), var(--cbuc-accent-strong));
        box-shadow: inset 0 0 0 1px var(--cbuc-swatch-inset);
      }

      #${ROOT_ID} .cbuc-tooltip-swatch {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        flex: 0 0 auto;
        box-shadow: inset 0 0 0 1px var(--cbuc-swatch-inset);
      }

      #${ROOT_ID} .cbuc-tooltip {
        position: absolute;
        z-index: 20;
        width: max-content;
        min-width: 210px;
        max-width: 360px;
        padding: 10px 12px;
        border: 1px solid var(--cbuc-tooltip-border);
        border-radius: 12px;
        background: var(--cbuc-tooltip-bg);
        box-shadow: var(--cbuc-tooltip-shadow);
        color: #ffffff;
        font-size: 12px;
        line-height: 17px;
        pointer-events: none;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 0.14s ease, transform 0.14s ease;
      }

      #${ROOT_ID} .cbuc-tooltip.is-visible {
        opacity: 1;
        transform: translateY(0);
      }

      #${ROOT_ID} .cbuc-tooltip-title {
        color: var(--cbuc-tooltip-title);
        margin-bottom: 4px;
      }

      #${ROOT_ID} .cbuc-tooltip-value {
        font-size: 15px;
        line-height: 20px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      #${ROOT_ID} .cbuc-tooltip-breakdown {
        margin-top: 8px;
        display: grid;
        gap: 6px;
      }

      #${ROOT_ID} .cbuc-tooltip-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto auto;
        align-items: center;
        gap: 8px;
        color: var(--cbuc-tooltip-row);
      }

      #${ROOT_ID} .cbuc-tooltip-model {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${ROOT_ID} .cbuc-tooltip-credit,
      #${ROOT_ID} .cbuc-tooltip-share {
        font-variant-numeric: tabular-nums;
      }

      #${ROOT_ID} .cbuc-tooltip-share {
        color: var(--cbuc-tooltip-share);
      }

      #${ROOT_ID} .cbuc-cursor-line {
        pointer-events: none;
        stroke: var(--cbuc-cursor-line);
        stroke-width: 1;
        stroke-dasharray: 4 4;
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      #${ROOT_ID} .cbuc-cursor-line.is-visible {
        opacity: 1;
      }

      #${ROOT_ID} rect[data-bar="true"] {
        transition: filter 0.15s ease, opacity 0.15s ease;
      }

      #${ROOT_ID} rect[data-bar="true"].is-highlighted {
        filter: url(#cbucGlow) brightness(1.08) !important;
        opacity: 1 !important;
      }

      #${ROOT_ID} rect[data-bar="true"].is-dimmed {
        opacity: 0.5;
      }

      #${ROOT_ID} .cbuc-empty,
      #${ROOT_ID} .cbuc-loading {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        align-content: center;
        gap: 10px;
        padding: 24px;
        color: var(--cbuc-muted);
        font-size: 14px;
        line-height: 22px;
        text-align: center;
      }

      #${ROOT_ID} .cbuc-loading::before {
        content: "";
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: 2px solid var(--cbuc-spinner-track);
        border-top-color: var(--cbuc-accent-strong);
        animation: cbuc-spin 0.8s linear infinite;
      }

      @keyframes cbuc-spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (max-width: 900px) {
        #${ROOT_ID} {
          padding: 18px 16px 12px;
        }

        #${ROOT_ID} .cbuc-header {
          flex-direction: column;
          align-items: stretch;
        }

        #${ROOT_ID} .cbuc-summary {
          justify-items: start;
          min-width: 0;
        }

        #${ROOT_ID} .cbuc-summary-top,
        #${ROOT_ID} .cbuc-meta {
          justify-content: flex-start;
          text-align: left;
        }

        #${ROOT_ID} .cbuc-svg,
        #${ROOT_ID} .cbuc-canvas {
          height: 320px;
          min-height: 320px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        #${ROOT_ID} .cbuc-loading::before {
          animation: none;
        }
      }
    `;
    target.appendChild(style);
  }

  /* ------------------------------------------------------------------ *
   * 适配器
   * ------------------------------------------------------------------ */

  /**
   * 个人版 / CodeBuddy：`.request-usage-table--plans-usage`
   * CodeBuddy 深色 + 紫；WorkBuddy 个人版浅色 + 薄荷绿，由 data-brand 决定主题。
   */
  const plansUsageAdapter = {
    id: "plans",
    match: () => Boolean(findPlansUsageSection()),
    findSection: findPlansUsageSection,
    getMountAnchor: getPlansMountAnchor,
    readUi: (section) => readPlansUi(section),
  };

  /**
   * 企业版（https://www.workbuddy.cn/profile/usage）：React + TDesign
   * 结构：.dashboard-content > [周期额度卡, 每日用量卡, 积分消耗明细卡]
   * 接口：/billing/meter/get-user-request-usage（游标分页，含 model）
   *       /billing/meter/get-user-daily-usage（按天汇总）
   */
  const enterpriseAdapter = {
    id: "enterprise",
    match: () => Boolean(findEnterpriseSection()),
    findSection: findEnterpriseSection,
    getMountAnchor: getEnterpriseMountAnchor,
    readUi: (section) => readEnterpriseUi(section),
    fetchDataset: fetchEnterpriseDataset,
  };

  const ADAPTERS = [enterpriseAdapter, plansUsageAdapter];

  function getActiveAdapter() {
    for (const adapter of ADAPTERS) {
      try {
        if (adapter.match()) {
          return adapter;
        }
      } catch (error) {
        // 适配器探测失败不应中断其它适配器
      }
    }
    return null;
  }

  function getActiveTheme() {
    return detectPageBrand() === "workbuddy" ? "light" : "dark";
  }

  /** 企业版页面全中文，术语跟随「积分」；CodeBuddy 沿用 Credit */
  function getLabels() {
    const isEnterprise = state.adapterId === "enterprise";
    return {
      title: isEnterprise ? "积分消耗趋势" : "Credit Usage",
      series: isEnterprise ? "积分消耗" : "Credit 用量",
      unit: isEnterprise ? "积分" : "Credits",
    };
  }

  function detectPageBrand() {
    const root = document.documentElement;
    const attr = (root && root.getAttribute("data-brand")) || "";
    if (attr) {
      return attr.toLowerCase();
    }
    return /workbuddy/i.test(location.host) ? "workbuddy" : "codebuddy";
  }

  /* -------------------- 个人版 DOM 读取 -------------------- */

  function findPlansUsageSection() {
    const table = document.querySelector(".request-usage-table--plans-usage");
    if (table) {
      return table;
    }
    const titles = Array.from(document.querySelectorAll("div, h1, h2, h3, span"));
    for (const element of titles) {
      if (!getOwnText(element).startsWith("用量明细")) {
        continue;
      }
      let current = element;
      while (current && current !== document.body) {
        if (current.querySelector(".request-usage-table")) {
          return current;
        }
        current = current.parentElement;
      }
    }
    return null;
  }

  function getPlansMountAnchor(usageRoot) {
    if (!usageRoot) {
      return { parent: null, anchor: null };
    }
    const panel = usageRoot.querySelector(".request-usage-table__panel");
    if (panel && panel.parentElement) {
      return { parent: panel.parentElement, anchor: panel };
    }
    const pagination = usageRoot.querySelector(".request-usage-table__pagination");
    if (pagination && pagination.parentElement) {
      return { parent: pagination.parentElement, anchor: pagination };
    }
    return { parent: null, anchor: null };
  }

  function readPlansUi(usageRoot) {
    const checkedInput = usageRoot.querySelector(".t-radio-button.t-is-checked input");
    const checkedLabel = usageRoot.querySelector(
      ".t-radio-button.t-is-checked .t-radio-button__label"
    );
    const rangeKey = (
      (checkedInput && checkedInput.value) ||
      (checkedLabel && checkedLabel.textContent) ||
      ""
    )
      .trim()
      .toLowerCase();

    const rangeText = usageRoot.querySelector(".request-usage-table__date-range-text");
    const rangeValue = rangeText ? rangeText.textContent || "" : "";
    const dateMatch = rangeValue.match(
      /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*[-–—~]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/
    );
    const startDate = dateMatch ? normalizeDateOnly(dateMatch[1]) : "";
    const endDate = dateMatch ? normalizeDateOnly(dateMatch[2]) : "";

    return {
      rangeKey,
      startDate,
      endDate,
      unit: determineUnit(rangeKey, startDate, endDate),
      totalCount: parsePlansTotalCount(usageRoot),
      tableRecords: parsePlansTableRows(usageRoot),
      granularity: "auto",
    };
  }

  function parsePlansTotalCount(usageRoot) {
    const nodes = usageRoot.querySelectorAll(
      ".request-usage-table__pagination > span, .request-usage-table__pagination span"
    );
    for (const node of nodes) {
      const text = (node.textContent || "").trim();
      const match = text.match(/共\s*(\d+)\s*条/);
      if (match) {
        return Number(match[1]);
      }
    }
    return null;
  }

  function parsePlansTableRows(usageRoot) {
    const table = usageRoot ? usageRoot.querySelector(".request-usage-table__body") : null;
    if (!table) {
      return [];
    }
    const rows = Array.from(table.querySelectorAll(".request-usage-table__row"));
    return rows
      .map((row, index) => {
        const cells = Array.from(row.children).filter(
          (child) => child.tagName.toLowerCase() === "span"
        );
        if (cells.length < 3) {
          return null;
        }

        // 列顺序在改版中变过（曾为 时间/credit/模型/…，现为 时间/请求摘要/credit/模型/…），
        // 因此按内容特征定位列，而不是写死下标。
        const texts = cells.map((cell) => getCellText(cell));
        const timeIndex = texts.findIndex((text) => DATETIME_TEXT_RE.test(text));
        if (timeIndex < 0) {
          return null;
        }

        let creditIndex = -1;
        let credit = NaN;
        for (let i = 0; i < cells.length; i += 1) {
          if (i === timeIndex || cells[i].classList.contains("request-usage-table__request-cell")) {
            continue;
          }
          if (NUMERIC_TEXT_RE.test(texts[i])) {
            creditIndex = i;
            credit = parseNumber(texts[i]);
            break;
          }
        }
        if (creditIndex < 0 || !Number.isFinite(credit)) {
          return null;
        }

        let modelName = "";
        for (let i = creditIndex + 1; i < cells.length; i += 1) {
          const text = texts[i];
          if (!text || NUMERIC_TEXT_RE.test(text) || DATETIME_TEXT_RE.test(text)) {
            continue;
          }
          modelName = text;
          break;
        }

        const requestTime = texts[timeIndex];
        if (!parseDateTime(requestTime)) {
          return null;
        }

        const requestIdNode = row.querySelector(".request-usage-table__request-id");
        const requestId = requestIdNode ? (requestIdNode.textContent || "").trim() : "";

        return {
          requestId:
            requestId ||
            makeStableId("table", `${index}|${requestTime}|${credit}|${modelName}`),
          credit,
          requestTime: normalizeDateTime(requestTime),
          modelName: normalizeModelName(modelName),
        };
      })
      .filter(Boolean);
  }

  /* -------------------- 企业版 DOM 读取 -------------------- */

  function findEnterpriseSection() {
    const dashboard = document.querySelector(".dashboard-content");
    if (!dashboard) {
      return null;
    }
    const hasUsageTable = dashboard.querySelector(".usage-request-table, .t-table");
    if (!hasUsageTable) {
      return null;
    }
    // 只认「每日用量」或「积分消耗明细」这两类卡的宿主，避免误挂到控制台其它页面
    const text = dashboard.textContent || "";
    if (!/每日用量|周期额度|积分消耗/.test(text)) {
      return null;
    }
    return dashboard;
  }

  function getEnterpriseMountAnchor(dashboard) {
    if (!dashboard) {
      return { parent: null, anchor: null };
    }
    // 与个人版语义一致：图表紧贴「每日用量」表格上方。
    // 卡片组由 React 渲染，实测在组内插入兄弟节点不会被 reconciliation 清掉；
    // 若被清掉，MutationObserver 会重新挂回。
    const cardsWrap = Array.from(dashboard.children).find(
      (child) =>
        child.children.length >= 2 &&
        child.querySelector(".usage-request-table, .t-table")
    );
    if (cardsWrap) {
      const dailyCard = Array.from(cardsWrap.children).find((card) =>
        /每日用量/.test((card.textContent || "").slice(0, 60))
      );
      if (dailyCard) {
        return { parent: cardsWrap, anchor: dailyCard };
      }
      const firstTableCard = Array.from(cardsWrap.children).find((card) =>
        card.querySelector(".t-table")
      );
      if (firstTableCard) {
        return { parent: cardsWrap, anchor: firstTableCard };
      }
    }
    return { parent: dashboard, anchor: dashboard.firstElementChild || null };
  }

  function readEnterpriseUi(dashboard) {
    const groups = Array.from(dashboard.querySelectorAll(".t-radio-group"));
    let rangeKey = "";
    for (const group of groups) {
      const checked = group.querySelector(".t-radio-button.t-is-checked input");
      const checkedLabel = group.querySelector(".t-radio-button.t-is-checked");
      const value = (checked && checked.value) ||
        (checkedLabel && (checkedLabel.textContent || "").trim()) || "";
      if (/^(3d|7d|30d|today)$/i.test(value)) {
        rangeKey = value.toLowerCase();
        break;
      }
    }

    const { startDate, endDate } = readEnterpriseDateRange(dashboard, rangeKey);
    const tableRecords = parseEnterpriseRows(dashboard);

    return {
      rangeKey,
      startDate,
      endDate,
      unit: determineUnit(rangeKey, startDate, endDate),
      totalCount: null, // 企业版「当前页 N 条」不是总数，不使用
      tableRecords,
      granularity: "auto",
    };
  }

  function readEnterpriseDateRange(dashboard, rangeKey) {
    const pickers = Array.from(dashboard.querySelectorAll(".t-date-range-picker"));
    for (const picker of pickers) {
      const inputs = Array.from(picker.querySelectorAll("input"));
      const values = inputs
        .map((input) => normalizeDateOnly(input.value || input.getAttribute("value") || ""))
        .filter(Boolean);
      if (values.length >= 2) {
        return { startDate: values[0], endDate: values[values.length - 1] };
      }
      const text = (picker.textContent || "").trim();
      const match = text.match(
        /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*[-–—~]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/
      );
      if (match) {
        return {
          startDate: normalizeDateOnly(match[1]),
          endDate: normalizeDateOnly(match[2]),
        };
      }
    }
    // 兜底：读不到日期控件时按档位推算（与标签口径一致，含今天共 N 天）
    const days = RANGE_LABEL_DAYS[rangeKey] || 0;
    if (!days) {
      return { startDate: "", endDate: "" };
    }
    const today = startOfDay(Date.now());
    const start = today - (days - 1) * DAY_MS;
    return { startDate: formatDateOnly(start), endDate: formatDateOnly(today) };
  }

  function parseEnterpriseRows(dashboard) {
    const records = [];
    const tables = Array.from(dashboard.querySelectorAll("table.t-table"));
    for (const table of tables) {
      const heads = Array.from(table.querySelectorAll("thead th")).map((th) =>
        String(th.getAttribute("data-colkey") || "").toLowerCase()
      );
      const timeIndex = heads.indexOf("requesttime");
      const creditIndex = heads.indexOf("credit");
      const modelIndex = heads.indexOf("model");
      const idIndex = heads.indexOf("requestid");
      if (timeIndex < 0 || creditIndex < 0) {
        continue;
      }
      const body = table.querySelector("tbody");
      if (!body) {
        continue;
      }
      Array.from(body.children).forEach((row, index) => {
        const cells = Array.from(row.children);
        const timeText = (getCellText(cells[timeIndex]) || "").trim();
        const credit = parseNumber(getCellText(cells[creditIndex]));
        if (!Number.isFinite(credit) || !parseDateTime(timeText)) {
          return;
        }
        const modelName = modelIndex >= 0 ? getCellText(cells[modelIndex]) : "";
        const requestId = idIndex >= 0 ? getCellText(cells[idIndex]) : "";
        records.push({
          requestId:
            requestId || makeStableId("table", `${index}|${timeText}|${credit}|${modelName}`),
          credit,
          requestTime: normalizeDateTime(timeText),
          modelName: normalizeModelName(modelName),
        });
      });
    }
    return records;
  }

  /* ------------------------------------------------------------------ *
   * 观察与调度
   * ------------------------------------------------------------------ */

  function observeDocument() {
    const observer = new MutationObserver(() => scheduleSync("dom"));
    const start = () => {
      if (!document.body) {
        return false;
      }
      observer.observe(document.body, { childList: true, subtree: true });
      return true;
    };
    if (!start()) {
      whenReady(start);
    }
    state.globalObserver = observer;
  }

  function whenReady(callback) {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      callback();
      return;
    }
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function scheduleSync(reason, delay = SCHEDULE_DELAY) {
    window.clearTimeout(state.scheduleTimer);
    state.scheduleTimer = window.setTimeout(() => {
      try {
        sync(reason);
      } catch (error) {
        console.warn("[CBUC] sync failed", error);
      }
    }, delay);
  }

  function handleUserInteraction(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const adapter = getActiveAdapter();
    const section = adapter ? adapter.findSection() : null;
    if (!section || !section.contains(target)) {
      return;
    }

    const toggleButton = target.closest(`#${ROOT_ID} [data-role='toggle-model-mode']`);
    if (toggleButton) {
      if (toggleButton.disabled) {
        return;
      }
      state.splitByModel = !state.splitByModel;
      state.lastUiFingerprint = "";
      scheduleSync("toggle-model-mode", 0);
      return;
    }

    if (
      target.closest(".t-radio-button") ||
      target.closest(".t-radio-group") ||
      target.closest(".t-pagination") ||
      target.closest(".t-date-range-picker") ||
      target.closest(".t-range-input") ||
      target.closest(".t-select") ||
      target.closest("select") ||
      target.closest(".usage-request-cursor-pagination") ||
      target.closest(".request-usage-table__pagination") ||
      target.closest(".request-usage-table__date-range") ||
      target.closest(".request-usage-table__export-btn")
    ) {
      state.interactionHintUntil = Date.now() + 2500;
      state.lastUiFingerprint = "";
      renderLoadingState("正在同步最新用量数据...");
      scheduleSync("interaction", 260);
    }
  }

  /* ------------------------------------------------------------------ *
   * 主流程
   * ------------------------------------------------------------------ */

  function sync(reason) {
    const adapter = getActiveAdapter();
    if (!adapter) {
      cleanupMount();
      return;
    }

    const section = adapter.findSection();
    if (!section) {
      cleanupMount();
      return;
    }

    state.adapterId = adapter.id;
    state.usageRoot = section;
    mountInto(section, adapter);

    const uiState = alignRangeToLabel(adapter.readUi(section));
    const signature = getStateSignature(uiState);
    // 轻量指纹：这里在每次 DOM 变动后都会重算，用字符串拼接代替 JSON.stringify
    const uiFingerprint = [
      signature,
      uiState.totalCount,
      uiState.tableRecords.length,
      state.splitByModel ? "model" : "total",
      isLoadingHintActive() ? "hint" : "-",
      adapter.id,
      uiState.rangeAdjusted ? uiState.rangeAdjusted.droppedDate : "-",
    ].join("|");

    // 企业版走接口主动补数：先触发（幂等），再按缓存状态渲染
    let apiSource = null;
    if (typeof adapter.fetchDataset === "function") {
      apiSource = ensureApiDataset(adapter, signature, uiState);
    }

    const source = apiSource || chooseBestSource(uiState);
    const dataFingerprint = source ? source.fingerprint : "none";

    if (
      reason !== "payload" &&
      state.lastUiFingerprint === uiFingerprint &&
      state.lastDataFingerprint === dataFingerprint
    ) {
      return;
    }
    state.lastUiFingerprint = uiFingerprint;
    state.lastDataFingerprint = dataFingerprint;

    debugLog("sync", {
      reason,
      adapter: adapter.id,
      signature,
      range: `${uiState.startDate}~${uiState.endDate}`,
      unit: uiState.unit,
      source: source ? source.label : "none",
      records: source ? source.records.length : 0,
    });

    if (source && source.records.length) {
      renderChart(uiState, source);
      return;
    }

    if (source && source.status === "loading") {
      renderLoadingState(source.message || "正在获取完整用量数据...");
      return;
    }

    if (isLoadingHintActive()) {
      renderLoadingState("正在同步最新用量数据...");
      return;
    }

    renderEmptyState(
      source && source.error
        ? `用量接口请求失败：${source.error}`
        : "当前范围内暂无可用的 Credit 用量数据。",
      source
    );
  }

  /* -------------------- 挂载 -------------------- */

  function mountInto(section, adapter) {
    const mountAnchor = adapter.getMountAnchor(section);
    if (!mountAnchor.anchor || !mountAnchor.parent) {
      return;
    }

    let root = mountAnchor.parent.querySelector(`#${ROOT_ID}`);
    if (!root) {
      root = document.createElement("section");
      root.id = ROOT_ID;
      root.innerHTML = `
        <div class="cbuc-header">
          <div class="cbuc-overview">
            <div class="cbuc-title">${escapeHtml(getLabels().title)}</div>
            <div class="cbuc-total">0</div>
          </div>
          <div class="cbuc-summary">
            <div class="cbuc-summary-top">
              <button class="cbuc-toggle" data-role="toggle-model-mode" type="button" aria-pressed="false">
                按模型划分
              </button>
              <div class="cbuc-status" data-role="status">等待数据</div>
            </div>
            <div class="cbuc-meta" data-role="meta">-</div>
          </div>
        </div>
        <div class="cbuc-canvas" data-role="canvas"></div>
        <div class="cbuc-legend" data-role="legend"></div>
        <div class="cbuc-tooltip" data-role="tooltip">
          <div class="cbuc-tooltip-title"></div>
          <div class="cbuc-tooltip-value"></div>
          <div class="cbuc-tooltip-breakdown"></div>
        </div>
      `;
    }

    if (root.parentElement !== mountAnchor.parent || root.nextElementSibling !== mountAnchor.anchor) {
      mountAnchor.parent.insertBefore(root, mountAnchor.anchor);
    }

    const theme = getActiveTheme();
    if (root.dataset.cbucTheme !== theme) {
      root.dataset.cbucTheme = theme;
    }
    if (root.dataset.cbucAdapter !== adapter.id) {
      root.dataset.cbucAdapter = adapter.id;
    }
    const titleNode = root.querySelector(".cbuc-title");
    if (titleNode && titleNode.textContent !== getLabels().title) {
      titleNode.textContent = getLabels().title;
    }
    if (theme === "light") {
      applyPageSurface(root);
    }

    state.chartRoot = root;
    state.mounted = true;

    if (!state.resizeObserver) {
      state.resizeObserver = new ResizeObserver(() => {
        if (!state.chartRoot) {
          return;
        }
        const width = Math.round(state.chartRoot.clientWidth);
        if (width && width !== state.lastRenderWidth) {
          scheduleSync("resize", 60);
        }
      });
    }
    state.resizeObserver.disconnect();
    state.resizeObserver.observe(root);

    if (!state.mutationObserver) {
      state.mutationObserver = new MutationObserver((mutations) => {
        // 忽略图表自身引起的变动（否则每次重绘都会再触发一轮同步）
        const chart = state.chartRoot;
        const external = mutations.some((mutation) => !chart || !chart.contains(mutation.target));
        if (external) {
          scheduleSync("section");
        }
      });
    }
    state.mutationObserver.disconnect();
    state.mutationObserver.observe(mountAnchor.parent, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "value", "checked"],
    });
  }

  /** 浅色页面：让图表卡沿用页面自身的卡片底色/边框，避免"外来"感 */
  function applyPageSurface(root) {
    const probe = document.querySelector(".usage-request-table") ||
      document.querySelector(".request-usage-table");
    const computed = probe ? getComputedStyle(probe) : null;
    const rootStyle = getComputedStyle(document.documentElement);
    const surface =
      (computed && (computed.backgroundColor || "").replace(/\s/g, "")) ||
      rootStyle.getPropertyValue("--cb-surface-container").trim();
    const border =
      rootStyle.getPropertyValue("--cb-card-border").trim() ||
      rootStyle.getPropertyValue("--cb-border").trim();

    if (surface && surface !== "rgba(0,0,0,0)" && surface !== "transparent") {
      root.style.setProperty("--cbuc-surface", surface);
    }
    if (border) {
      root.style.setProperty("--cbuc-card-border", border);
    }
  }

  function cleanupMount() {
    state.usageRoot = null;
    state.chartRoot = null;
    state.mounted = false;
    state.adapterId = "";
    state.lastUiFingerprint = "";
    state.lastDataFingerprint = "";
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
    }
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
    }
  }

  /* ------------------------------------------------------------------ *
   * 数据源 A：企业版接口主动拉取
   * ------------------------------------------------------------------ */

  /**
   * 接口数据的取用策略：
   * - 命中且未过期 → 直接用
   * - 命中但过期（默认 60s）→ 先用旧数据渲染，同时后台刷新，避免闪「加载中」
   * - 未命中 → 首次拉取，期间显示加载态
   * - 失败 → 30s 内不重复打接口，先用表格里已渲染的行兜底
   */
  function ensureApiDataset(adapter, signature, uiState) {
    const cached = state.apiCache.get(signature);
    const fresh = cached && cached.status === "done" &&
      Date.now() - (cached.at || 0) < API_CACHE_TTL;

    if (cached && cached.status === "done" && fresh) {
      return buildApiSource(cached);
    }

    if (cached && cached.status === "loading") {
      return { status: "loading", records: [], message: "正在获取完整用量数据..." };
    }

    if (cached && cached.status === "done") {
      // 过期：旧数据先撑着，后台刷新（同一区间只挂一个任务）
      if (!state.apiRefreshing.has(signature)) {
        state.apiRefreshing.add(signature);
        void fetchAndStoreDataset(adapter, signature, uiState);
      }
      return buildApiSource(cached);
    }

    if (cached && cached.status === "error" && Date.now() - (cached.at || 0) < API_ERROR_COOLDOWN) {
      const tableSource = chooseBestSource(uiState);
      if (tableSource && tableSource.records.length) {
        return tableSource;
      }
      return { status: "error", records: [], error: cached.error, fingerprint: "error" };
    }

    state.apiCache.set(signature, { status: "loading", at: Date.now() });
    void fetchAndStoreDataset(adapter, signature, uiState);
    return { status: "loading", records: [], message: "正在获取完整用量数据..." };
  }

  async function fetchAndStoreDataset(adapter, signature, uiState) {
    const startedAt = Date.now();
    try {
      const result = await adapter.fetchDataset(uiState);
      state.apiCache.set(signature, {
        status: "done",
        at: Date.now(),
        records: result.records,
        daily: result.daily,
        complete: result.complete,
        granularity: result.granularity,
        label: result.label,
        meta: result.meta,
      });
      debugLog("api.done", {
        signature,
        records: (result.records || []).length,
        daily: (result.daily || []).length,
        complete: result.complete,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      state.apiCache.set(signature, {
        status: "error",
        at: Date.now(),
        error: (error && error.message) || "未知错误",
      });
      debugLog("api.error", { signature, message: error && error.message, ms: Date.now() - startedAt });
    } finally {
      state.apiRefreshing.delete(signature);
      state.lastUiFingerprint = "";
      pruneApiCache();
      scheduleSync("api", 0);
    }
  }

  function buildApiSource(entry) {
    const records = entry.records || [];
    if (!records.length) {
      return {
        status: "empty",
        records: [],
        label: "暂无数据",
        meta: "接口返回 0 条记录",
        fingerprint: "api-empty",
      };
    }
    return {
      status: "ready",
      records,
      daily: entry.daily || null,
      granularity: entry.granularity || "day",
      label: entry.label,
      meta: entry.meta,
      fingerprint: `api:${fingerprintRecords(records)}:${(entry.daily || []).length}`,
    };
  }

  /**
   * 用「按天汇总」的每日总额校准「请求明细」：
   * 明细接口存在近实时延迟，直接求和会低于页面显示值（实测 512 vs 645）。
   * 做法是按天取汇总值，把当天明细的 (时段 × 模型) 分布按比例缩放到该值，
   * 这样柱高总和与页面表格一致，模型占比与小时分布仍来自真实明细。
   */

  async function fetchEnterpriseDataset(uiState) {
    if (!uiState.startDate || !uiState.endDate) {
      throw new Error("未能识别日期范围");
    }

    const base = {
      startTime: `${uiState.startDate} 00:00:00`,
      endTime: `${uiState.endDate} 23:59:59`,
      timezone: "Asia/Shanghai",
      version: 2,
    };

    // 两个接口并行：daily 是页面表格的权威按天汇总（有 2-3 小时延迟但完整），
    // request 明细带模型与精确时间戳（近实时，可能滞后于汇总）。
    const [dailyResult, detailResult] = await Promise.allSettled([
      fetchDailyUsage(base),
      fetchRequestUsage(base),
    ]);

    const daily = dailyResult.status === "fulfilled" ? dailyResult.value : null;
    const detail = detailResult.status === "fulfilled" ? detailResult.value : null;

    const dailyRecords = (daily && daily.records) || [];
    const detailRecords = (detail && detail.records) || [];

    if (!dailyRecords.length && !detailRecords.length) {
      const error =
        (detailResult.status === "rejected" && detailResult.reason) ||
        (dailyResult.status === "rejected" && dailyResult.reason);
      throw error instanceof Error ? error : new Error("用量接口未返回数据");
    }

    if (dailyRecords.length && detailRecords.length) {
      return {
        records: detailRecords,
        daily: dailyRecords,
        complete: Boolean(detail && detail.complete),
        granularity: "auto",
        label: "汇总校准",
        meta: `${dailyRecords.length} 天汇总校准 · ${detailRecords.length} 条明细`,
      };
    }

    if (detailRecords.length) {
      return {
        records: detailRecords,
        daily: null,
        complete: Boolean(detail && detail.complete),
        granularity: "auto",
        label: "接口数据（明细聚合）",
        meta: `${detailRecords.length} 条请求记录`,
      };
    }

    return {
      records: dailyRecords,
      daily: dailyRecords,
      complete: Boolean(daily && daily.complete),
      granularity: "day",
      label: "接口数据（按天汇总）",
      meta: `${dailyRecords.length} 天记录`,
    };
  }

  async function fetchRequestUsage(base) {
    const records = [];
    let token = "";
    let pages = 0;
    let complete = false;

    while (pages < API_PAGE_LIMIT) {
      const payload = await postJson(EP.request, {
        ...base,
        pageSize: API_PAGE_SIZE,
        pageToken: token,
      });
      const list = (payload && payload.data && payload.data.data) || [];
      for (const item of list) {
        const record = normalizeUsageRecord(item);
        if (record) {
          records.push(record);
        }
      }
      token = (payload && payload.data && payload.data.nextPageToken) || "";
      pages += 1;
      if (!token || !list.length) {
        complete = true;
        break;
      }
    }

    const unique = dedupeRecords(records);
    for (const record of unique) {
      state.recordPool.set(record.requestId, record);
    }
    trimPool();
    debugLog("api.request-usage", { records: unique.length, pages, complete });
    return { records: unique, complete, pages };
  }

  async function fetchDailyUsage(base) {
    const records = [];
    let pageNum = 1;
    let total = Infinity;
    let complete = false;

    while (pageNum <= API_PAGE_LIMIT) {
      const payload = await postJson(EP.daily, {
        startTime: base.startTime,
        endTime: base.endTime,
        pageNum,
        pageSize: API_PAGE_SIZE,
      });
      const data = (payload && payload.data) || {};
      const list = data.data || [];
      total = Number.isFinite(Number(data.total)) ? Number(data.total) : 0;
      for (const item of list) {
        const credit = parseNumber(item && item.credit);
        const date = normalizeDateOnly(item && item.date);
        if (!Number.isFinite(credit) || !date) {
          continue;
        }
        records.push({
          requestId: `daily-${date}`,
          credit,
          requestTime: `${date} 00:00:00`,
          modelName: UNKNOWN_MODEL_NAME,
        });
      }
      if (!list.length || pageNum * API_PAGE_SIZE >= total) {
        complete = true;
        break;
      }
      pageNum += 1;
    }

    return { records: dedupeRecords(records), complete };
  }

  /**
   * 统一 POST。网络错误 / 429 / 5xx 退避重试（最多 2 次），
   * 业务错误（code != 0）不重试——重试也不会变。
   */
  async function postJson(url, body, attempt = 0) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? window.setTimeout(() => controller.abort(), API_TIMEOUT)
      : null;
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-client-platform": "web",
          [HYDRATE_HEADER]: "1",
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      if (payload && typeof payload.code === "number" && payload.code !== 0) {
        const error = new Error(payload.msg || `业务错误 ${payload.code}`);
        error.bizCode = payload.code;
        throw error;
      }
      return payload;
    } catch (error) {
      const status = error && error.status;
      const retryable =
        !error || (!error.bizCode && (!status || status === 429 || status >= 500));
      if (retryable && attempt < API_RETRY_LIMIT) {
        const wait = API_RETRY_BASE_MS * Math.pow(3, attempt);
        debugLog("api.retry", { url, attempt: attempt + 1, wait, message: error && error.message });
        await sleep(wait);
        return postJson(url, body, attempt + 1);
      }
      throw error;
    } finally {
      if (timer) {
        window.clearTimeout(timer);
      }
    }
  }

  /** 接口缓存只保留最近若干个区间，避免来回切换范围时无限增长 */
  function pruneApiCache(limit = 12) {
    if (state.apiCache.size <= limit) {
      return;
    }
    const entries = Array.from(state.apiCache.entries()).sort(
      (left, right) => (left[1].at || 0) - (right[1].at || 0)
    );
    const overflow = state.apiCache.size - limit;
    for (let index = 0; index < overflow; index += 1) {
      state.apiCache.delete(entries[index][0]);
    }
  }

  function trimPool() {    if (state.recordPool.size <= POOL_LIMIT) {
      return;
    }
    const overflow = state.recordPool.size - POOL_LIMIT;
    const keys = state.recordPool.keys();
    for (let index = 0; index < overflow; index += 1) {
      const next = keys.next();
      if (next.done) {
        break;
      }
      state.recordPool.delete(next.value);
    }
  }

  /* ------------------------------------------------------------------ *
   * 数据源 B：网络负载捕获 + 表格兜底（个人版原有逻辑）
   * ------------------------------------------------------------------ */

  function handleBridgePayload(event) {
    const detail = event.detail;
    if (!detail) {
      return;
    }

    let parsed = null;
    try {
      parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
    } catch (error) {
      return;
    }

    const payload = parsed && parsed.payload;
    const meta = parsed && parsed.meta;
    const extracted = extractUsageRecords(payload);
    if (!extracted || !extracted.records.length) {
      return;
    }

    // 同一批数据重复推送（React 双请求、翻页重放）直接跳过
    const hash = `${meta && meta.url}|${fingerprintRecords(extracted.records)}`;
    if (hash === state.lastPayloadHash) {
      return;
    }
    state.lastPayloadHash = hash;

    const adapter = getActiveAdapter();
    if (!adapter) {
      return;
    }
    const uiState = alignRangeToLabel(adapter.readUi(adapter.findSection() || document));
    const signature = resolveSignature(meta, extracted, uiState);

    debugLog("payload", {
      url: meta && meta.url,
      records: extracted.records.length,
      total: extracted.total,
      signature,
    });

    upsertDataset(signature, extracted, uiState);
    for (const record of extracted.records) {
      state.recordPool.set(record.requestId, record);
    }
    trimPool();

    if (adapter.id !== "enterprise") {
      maybeHydrateDataset(signature, extracted, uiState, meta);
    }

    state.interactionHintUntil = 0;
    state.lastUiFingerprint = "";
    scheduleSync("payload");
  }

  function chooseBestSource(uiState) {
    const signature = getStateSignature(uiState);
    const dataset = state.datasets.get(signature);
    const tableRecords = uiState.tableRecords;
    const cachedRecords = getCachedRecordsForUiState(uiState);
    const expected = getExpectedCount(dataset, uiState);
    const isComplete = Boolean(expected && cachedRecords.length >= expected);

    const tableSource = tableRecords.length
      ? {
          status: "ready",
          records: dedupeRecords(tableRecords),
          label: "当前仅基于已加载表格数据",
          meta: `${tableRecords.length} 条已加载记录`,
          fingerprint: `table:${fingerprintRecords(tableRecords)}`,
        }
      : null;

    if (cachedRecords.length && isComplete) {
      return {
        status: "ready",
        records: cachedRecords,
        label: "缓存命中（已完整）",
        meta: expected
          ? `已复用 ${cachedRecords.length}/${expected} 条记录`
          : `${cachedRecords.length} 条缓存记录`,
        fingerprint: `cache-full:${fingerprintRecords(cachedRecords)}`,
      };
    }

    if (cachedRecords.length > tableRecords.length) {
      return {
        status: "ready",
        records: cachedRecords,
        label: "缓存命中（部分覆盖）",
        meta: expected
          ? `已复用 ${cachedRecords.length}/${expected} 条记录`
          : `已复用 ${cachedRecords.length} 条缓存记录`,
        fingerprint: `cache-partial:${fingerprintRecords(cachedRecords)}`,
      };
    }

    return tableSource;
  }

  function upsertDataset(signature, extracted, uiState) {
    const existing = ensureRangeDataset(signature, uiState);
    for (const record of extracted.records) {
      existing.recordIds.add(record.requestId);
    }
    if (Number.isFinite(extracted.total) && extracted.total > 0) {
      existing.totalExpected = Math.max(existing.totalExpected || 0, extracted.total);
    }
    if (Number.isFinite(uiState.totalCount) && uiState.totalCount > 0) {
      existing.totalExpected = Math.max(existing.totalExpected || 0, uiState.totalCount);
    }
    existing.lastSeenAt = Date.now();
    state.datasets.set(signature, existing);
  }

  function ensureRangeDataset(signature, uiState) {
    const parsed = parseSignature(signature);
    const existing =
      state.datasets.get(signature) || {
        signature,
        createdAt: Date.now(),
        recordIds: new Set(),
        totalExpected: null,
        lastSeenAt: 0,
        hydrationStatus: "idle",
      };
    existing.startDate = parsed.startDate || existing.startDate || "";
    existing.endDate = parsed.endDate || existing.endDate || "";
    existing.unit = parsed.unit || existing.unit || "day";
    if (uiState && Number.isFinite(uiState.totalCount) && uiState.totalCount > 0) {
      existing.totalExpected = Math.max(existing.totalExpected || 0, uiState.totalCount);
    }
    state.datasets.set(signature, existing);
    return existing;
  }

  function maybeHydrateDataset(signature, extracted, uiState, meta) {
    const dataset = state.datasets.get(signature);
    if (!dataset) {
      return;
    }
    const expected = getExpectedCount(dataset, uiState, extracted);
    const cachedCount = getCachedRecordsForDataset(dataset).length;
    if (!Number.isFinite(expected) || expected <= cachedCount) {
      return;
    }
    const existingJob = state.hydrationJobs.get(signature);
    if (existingJob && existingJob.running) {
      return;
    }

    const plan = derivePaginationPlan(meta, expected);
    if (!plan) {
      return;
    }

    const job = { running: true, plan, pages: new Set() };
    state.hydrationJobs.set(signature, job);
    void fetchRemainingPages(signature, job).finally(() => {
      job.running = false;
      state.lastUiFingerprint = "";
      scheduleSync("hydrate", 0);
    });
  }

  async function fetchRemainingPages(signature, job) {
    const targets = [];
    const keepCurrent = !job.plan.pageSizeChanged;
    if (job.plan.mode === "page") {
      for (let index = 0; index < job.plan.totalPages; index += 1) {
        const pageValue = job.plan.firstPage + index;
        if (keepCurrent && pageValue === job.plan.currentValue) {
          continue;
        }
        targets.push(pageValue);
      }
    } else {
      for (let offset = 0; offset < job.plan.totalExpected; offset += job.plan.pageSize) {
        if (keepCurrent && offset === job.plan.currentValue) {
          continue;
        }
        targets.push(offset);
      }
    }

    const concurrency = 3;
    let pointer = 0;
    const runner = async () => {
      while (pointer < targets.length) {
        const currentIndex = pointer;
        pointer += 1;
        const targetValue = targets[currentIndex];
        if (job.pages.has(String(targetValue))) {
          continue;
        }
        job.pages.add(String(targetValue));
        try {
          const payload = await fetchHydrationPage(job.plan, targetValue);
          const extracted = extractUsageRecords(payload);
          if (!extracted || !extracted.records.length) {
            continue;
          }
          for (const record of extracted.records) {
            state.recordPool.set(record.requestId, record);
          }
          upsertDataset(signature, extracted, { totalCount: null });
          scheduleSync("hydrate-page");
        } catch (error) {
          console.warn("[CBUC] hydrate page failed", error);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, runner)
    );
    trimPool();
  }

  async function fetchHydrationPage(plan, targetValue) {
    const request = buildHydrationRequest(plan, targetValue);
    const response = await fetch(request.url, request.options);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function buildHydrationRequest(plan, targetValue) {
    const url = new URL(plan.url.toString());
    const headers = new Headers();
    Object.entries(plan.headers || {}).forEach(([key, value]) => {
      if (!/^(content-length|host|cookie)$/i.test(key)) {
        headers.set(key, value);
      }
    });
    headers.set(HYDRATE_HEADER, "1");

    const queryParams = new URLSearchParams(url.search);
    Object.entries(plan.queryParams || {}).forEach(([key, value]) => {
      queryParams.set(key, value);
    });

    // 页大小可能已被放大（见 derivePaginationPlan），必须一并写回请求，
    // 否则页码按新语义算、页大小仍是旧值，拿到的数据段就对不上。
    const sizeKey = plan.mode === "page" ? plan.sizeKey : plan.limitKey;
    const sizeValue = Number.isFinite(plan.pageSize) ? String(plan.pageSize) : null;

    let body = null;
    if (plan.mode === "page") {
      if (plan.target === "query") {
        queryParams.set(plan.pageKey, String(targetValue));
        if (sizeKey && sizeValue) {
          queryParams.set(sizeKey, sizeValue);
        }
      } else {
        body = buildBodyPayload(plan, plan.pageKey, targetValue, headers, sizeKey, sizeValue);
      }
    } else if (plan.target === "query") {
      queryParams.set(plan.offsetKey, String(targetValue));
      if (sizeKey && sizeValue) {
        queryParams.set(sizeKey, sizeValue);
      }
    } else {
      body = buildBodyPayload(plan, plan.offsetKey, targetValue, headers, sizeKey, sizeValue);
    }
    url.search = queryParams.toString();

    const options = { method: plan.method, credentials: "include", headers };
    if (body != null && plan.method !== "GET" && plan.method !== "HEAD") {
      options.body = body;
    }
    return { url: url.toString(), options };
  }

  function buildBodyPayload(plan, key, value, headers, sizeKey, sizeValue) {
    if (plan.bodyType === "json") {
      const payload = JSON.parse(JSON.stringify(plan.bodyParams || {}));
      payload[key] = value;
      if (sizeKey && sizeValue) {
        payload[sizeKey] = Number(sizeValue);
      }
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json;charset=UTF-8");
      }
      return JSON.stringify(payload);
    }
    const params = new URLSearchParams();
    Object.entries(plan.bodyParams || {}).forEach(([name, currentValue]) => {
      params.set(name, String(currentValue));
    });
    params.set(key, String(value));
    if (sizeKey && sizeValue) {
      params.set(sizeKey, sizeValue);
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
    return params.toString();
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function renderChart(uiState, source) {
    if (!state.chartRoot) {
      return;
    }

    state.themeVars = readThemeVars(state.chartRoot);
    const preferredUnit = source.granularity === "day" ? "day" : uiState.unit;
    const calibrated = calibrateSeries(source.daily, source.records);
    const bucketData = aggregateRecords(calibrated.records, uiState, preferredUnit);
    debugLog("chart.render", {
      source: source.label,
      unit: bucketData.unit,
      buckets: bucketData.buckets.length,
      records: calibrated.records.length,
      total: Number(bucketData.total.toFixed(2)),
      calibration: calibrated.stats,
    });
    if (!bucketData.buckets.length) {
      renderEmptyState("当前范围内暂无可用的 Credit 用量数据。", source);
      return;
    }

    state.lastRenderWidth = Math.round(state.chartRoot.clientWidth);

    const titleNode = state.chartRoot.querySelector(".cbuc-total");
    const statusNode = state.chartRoot.querySelector("[data-role='status']");
    const metaNode = state.chartRoot.querySelector("[data-role='meta']");
    const canvasNode = state.chartRoot.querySelector("[data-role='canvas']");
    const tooltipNode = state.chartRoot.querySelector("[data-role='tooltip']");
    const legendNode = state.chartRoot.querySelector("[data-role='legend']");
    if (!titleNode || !statusNode || !metaNode || !canvasNode || !tooltipNode || !legendNode) {
      return;
    }

    titleNode.textContent = formatCredit(bucketData.total);
    statusNode.textContent = source.label || "数据就绪";
    statusNode.dataset.kind = /部分|当前仅|未取完/.test(source.label || "") ? "warning" : "default";
    metaNode.textContent = [
      formatRangeSummary(uiState, bucketData.unit),
      source.meta || "",
      describeCalibration(calibrated.stats),
      describeRangeAdjustment(uiState),
    ]
      .filter(Boolean)
      .join(" · ");
    renderToggleState(true);
    renderLegend(legendNode, bucketData, state.splitByModel);

    if (state.tooltipCleanup) {
      state.tooltipCleanup();
      state.tooltipCleanup = null;
    }

    canvasNode.innerHTML = "";
    const svg = buildSvgChart(
      bucketData,
      canvasNode.clientWidth || state.chartRoot.clientWidth || 800,
      { splitByModel: state.splitByModel }
    );
    svg.classList.add("cbuc-svg");
    canvasNode.appendChild(svg);
    state.tooltipCleanup = attachTooltip(svg, tooltipNode);
  }

  function buildSvgChart(bucketData, containerWidth, options) {
    const splitByModel = Boolean(options && options.splitByModel);
    const width = Math.max(520, containerWidth || 800);
    const height = width < 720 ? 320 : 360;
    const margin = {
      top: 18,
      right: 18,
      bottom: width < 720 ? 74 : 82,
      left: width < 720 ? 52 : 60,
    };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const scale = getNiceScale(bucketData.maxValue);
    const labelStep = getLabelStep(bucketData.buckets.length, plotWidth, bucketData.unit);
    const count = bucketData.buckets.length;
    const barGap = count > 40 ? 2 : 6;
    // 等距槽位 + 最大柱宽：桶很少时（如 7 天）不至于把柱子拉成巨块
    const slotWidth = plotWidth / count;
    const maxBarWidth = bucketData.unit === "hour" ? 24 : 56;
    const barWidth = Math.max(2, Math.min(slotWidth - barGap, maxBarWidth));

    const themeColor = (name, fallback) => readThemeColor(state.chartRoot, name, fallback);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(height));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${getLabels().series}柱状图`);

    const gradient = createSvg("linearGradient", {
      id: "cbucBarGradient",
      x1: "0", x2: "0", y1: "0", y2: "1",
    });
    gradient.appendChild(
      createSvg("stop", {
        offset: "0%",
        "stop-color": themeColor("--cbuc-accent-strong", "#947dff"),
      })
    );
    gradient.appendChild(
      createSvg("stop", {
        offset: "100%",
        "stop-color": themeColor("--cbuc-accent", "#724bff"),
      })
    );

    const filter = createSvg("filter", {
      id: "cbucGlow",
      x: "-20%", y: "-20%", width: "140%", height: "140%",
    });
    filter.appendChild(
      createSvg("feDropShadow", {
        dx: "0", dy: "7", stdDeviation: "7",
        "flood-color": themeColor("--cbuc-bar-glow", "rgba(114, 75, 255, 0.24)"),
      })
    );

    const defs = createSvg("defs", {});
    defs.appendChild(gradient);
    defs.appendChild(filter);
    svg.appendChild(defs);

    const gridGroup = createSvg("g", {});
    const yAxisGroup = createSvg("g", {});
    const xAxisGroup = createSvg("g", {});
    const barsGroup = createSvg("g", {});
    const gridStroke = themeColor("--cbuc-grid", "rgba(255, 255, 255, 0.08)");
    const axisFill = themeColor("--cbuc-axis", "rgba(255,255,255,0.55)");

    scale.ticks.forEach((tick) => {
      const y = margin.top + plotHeight - (tick / scale.max) * plotHeight;
      gridGroup.appendChild(
        createSvg("line", {
          x1: String(margin.left),
          x2: String(width - margin.right),
          y1: String(y),
          y2: String(y),
          stroke: gridStroke,
          "stroke-width": tick === 0 ? "1.4" : "1",
        })
      );
      const label = createSvg("text", {
        x: String(margin.left - 10),
        y: String(y + 4),
        "text-anchor": "end",
        "font-size": width < 720 ? "11" : "12",
        fill: axisFill,
      });
      label.textContent = formatAxisValue(tick);
      yAxisGroup.appendChild(label);
    });

    const cursorLine = createSvg("line", {
      class: "cbuc-cursor-line",
      x1: "0", x2: "0",
      y1: String(margin.top),
      y2: String(margin.top + plotHeight),
    });
    svg.appendChild(cursorLine);

    bucketData.buckets.forEach((bucket, index) => {
      const x = margin.left + index * slotWidth + (slotWidth - barWidth) / 2;
      const scaledHeight =
        bucket.value <= 0 ? 0 : Math.max(3, (bucket.value / scale.max) * plotHeight);
      const barTopY = margin.top + plotHeight - scaledHeight;

      if (splitByModel && bucket.stackSegments.length) {
        let stackedHeight = 0;
        let cursorY = margin.top + plotHeight;
        bucket.stackSegments.forEach((segment, segmentIndex) => {
          const isTop = segmentIndex === bucket.stackSegments.length - 1;
          const segmentHeight =
            segment.value <= 0
              ? 0
              : isTop
                ? Math.max(0, scaledHeight - stackedHeight)
                : (segment.value / bucket.value) * scaledHeight;
          stackedHeight += segmentHeight;
          cursorY -= segmentHeight;
          if (segmentHeight <= 0) {
            return;
          }
          barsGroup.appendChild(
            createSvg("rect", {
              x: String(x),
              y: String(cursorY),
              width: String(barWidth),
              height: String(segmentHeight),
              rx: String(isTop ? Math.min(6, barWidth / 2) : 0),
              fill: segment.color,
              "data-bar": "true",
              "data-bucket-index": String(index),
            })
          );
        });
      } else {
        barsGroup.appendChild(
          createSvg("rect", {
            x: String(x),
            y: String(barTopY),
            width: String(barWidth),
            height: String(scaledHeight),
            rx: String(Math.min(6, barWidth / 2)),
            fill: "url(#cbucBarGradient)",
            "data-bar": "true",
            "data-bucket-index": String(index),
          })
        );
      }

      // 透明锚点：hover 命中区，附带 tooltip 数据
      const anchorRect = createSvg("rect", {
        x: String(x),
        y: String(scaledHeight ? barTopY : margin.top + plotHeight - 3),
        width: String(barWidth),
        height: String(scaledHeight || 3),
        fill: "transparent",
        "data-index": String(index),
        "data-tooltip-title": bucket.tooltipTitle,
        "data-tooltip-value": formatCredit(bucket.value),
        "data-tooltip-breakdown": encodeTooltipBreakdown(bucket.tooltipModels),
      });
      barsGroup.appendChild(anchorRect);

      if (index % labelStep === 0 || index === bucketData.buckets.length - 1) {
        const label = createSvg("text", {
          x: String(x + barWidth / 2),
          y: String(height - 26),
          "text-anchor": "middle",
          "font-size": width < 720 ? "10" : "11",
          fill: axisFill,
        });
        label.textContent = bucket.axisLabel;
        xAxisGroup.appendChild(label);
      }
    });

    const overlay = createSvg("rect", {
      x: String(margin.left),
      y: String(margin.top),
      width: String(plotWidth),
      height: String(plotHeight),
      fill: "transparent",
      cursor: "crosshair",
      "data-role": "chart-overlay",
    });

    svg.dataset.marginLeft = String(margin.left);
    svg.dataset.marginTop = String(margin.top);
    svg.dataset.barWidth = String(barWidth);
    svg.dataset.slotWidth = String(slotWidth);
    svg.dataset.plotHeight = String(plotHeight);
    svg.dataset.bucketCount = String(count);

    svg.appendChild(gridGroup);
    svg.appendChild(yAxisGroup);
    svg.appendChild(xAxisGroup);
    svg.appendChild(barsGroup);
    svg.appendChild(overlay);
    return svg;
  }

  function createSvg(name, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      if (key === "class") {
        node.setAttribute("class", value);
      } else {
        node.setAttribute(key, value);
      }
    });
    return node;
  }

  function attachTooltip(svg, tooltipNode) {
    const anchors = Array.from(svg.querySelectorAll("rect[data-index]"));
    const barRects = Array.from(svg.querySelectorAll("rect[data-bar='true']"));
    if (!anchors.length) {
      return null;
    }

    const titleNode = tooltipNode.querySelector(".cbuc-tooltip-title");
    const valueNode = tooltipNode.querySelector(".cbuc-tooltip-value");
    const breakdownNode = tooltipNode.querySelector(".cbuc-tooltip-breakdown");
    const overlay = svg.querySelector("rect[data-role='chart-overlay']");
    const cursorLine = svg.querySelector(".cbuc-cursor-line");
    if (!titleNode || !valueNode || !breakdownNode || !overlay) {
      return null;
    }

    const marginLeft = parseFloat(svg.dataset.marginLeft) || 0;
    const slotWidth = parseFloat(svg.dataset.slotWidth) || 0;
    const bucketCount = parseInt(svg.dataset.bucketCount, 10) || 0;
    const viewBoxWidth = parseFloat((svg.getAttribute("viewBox") || "").split(" ")[2]) || 1;
    const viewBoxHeight = parseFloat((svg.getAttribute("viewBox") || "").split(" ")[3]) || 1;

    let currentIndex = -1;

    const metrics = () => {
      const svgRect = svg.getBoundingClientRect();
      // tooltip 是 #cbuc-root 的直接子节点，绝对定位以 root 为参照系
      const rootRect =
        state.chartRoot && typeof state.chartRoot.getBoundingClientRect === "function"
          ? state.chartRoot.getBoundingClientRect()
          : svgRect;
      return {
        svgRect,
        rootRect,
        scaleX: svgRect.width / viewBoxWidth,
        scaleY: svgRect.height / viewBoxHeight,
      };
    };

    const hide = () => {
      tooltipNode.classList.remove("is-visible");
      cursorLine.classList.remove("is-visible");
      breakdownNode.textContent = "";
      barRects.forEach((rect) => rect.classList.remove("is-highlighted", "is-dimmed"));
      currentIndex = -1;
    };

    const show = (index) => {
      const target = anchors[index];
      if (!target) {
        return;
      }
      barRects.forEach((rect) => {
        rect.classList.remove("is-highlighted", "is-dimmed");
        rect.classList.add(
          rect.dataset.bucketIndex === String(index) ? "is-highlighted" : "is-dimmed"
        );
      });

      // 先填内容再定位：tooltip 宽度随内容变化，先测量会用到上一格的宽度
      titleNode.textContent = target.dataset.tooltipTitle || "";
      valueNode.textContent = `总计 ${target.dataset.tooltipValue || "0"} ${getLabels().unit}`;
      breakdownNode.innerHTML = buildTooltipBreakdownHtml(
        decodeTooltipBreakdown(target.dataset.tooltipBreakdown || "")
      );
      tooltipNode.classList.add("is-visible");

      const { svgRect, rootRect, scaleX, scaleY } = metrics();
      const tooltipRect = tooltipNode.getBoundingClientRect();
      const barCenterX =
        svgRect.left + (marginLeft + index * slotWidth + slotWidth / 2) * scaleX - rootRect.left;

      // 垂直方向按 scaleY 换算（viewBox 与显示尺寸不等比时 scaleX 会错位）
      const barTopY = svgRect.top + parseFloat(target.getAttribute("y")) * scaleY - rootRect.top;
      const barHeight = parseFloat(target.getAttribute("height")) * scaleY;

      let left = barCenterX + 12;
      let top = barTopY - tooltipRect.height - 12;
      if (top < 8) {
        top = barTopY + barHeight + 12;
      }
      left = Math.max(8, Math.min(left, rootRect.width - tooltipRect.width - 8));
      top = Math.max(8, Math.min(top, rootRect.height - tooltipRect.height - 8));

      tooltipNode.style.left = `${left}px`;
      tooltipNode.style.top = `${top}px`;
    };

    const updateCursor = (clientX) => {
      if (!cursorLine) {
        return;
      }
      const { svgRect, scaleX } = metrics();
      const x = (clientX - svgRect.left) / (scaleX || 1);
      cursorLine.setAttribute("x1", String(x));
      cursorLine.setAttribute("x2", String(x));
      cursorLine.classList.add("is-visible");
    };

    const onMove = (event) => {
      const { svgRect, scaleX } = metrics();
      const relativeX = (event.clientX - svgRect.left) / (scaleX || 1) - marginLeft;
      const index = Math.floor(relativeX / (slotWidth || 1));
      if (index < 0 || index >= bucketCount) {
        if (currentIndex !== -1) {
          hide();
        }
        return;
      }
      if (index !== currentIndex) {
        currentIndex = index;
        show(index);
      }
      updateCursor(event.clientX);
    };

    overlay.addEventListener("mousemove", onMove);
    overlay.addEventListener("mouseleave", hide);

    return () => {
      overlay.removeEventListener("mousemove", onMove);
      overlay.removeEventListener("mouseleave", hide);
    };
  }

  function renderLoadingState(text) {
    if (!state.chartRoot) {
      return;
    }
    const titleNode = state.chartRoot.querySelector(".cbuc-total");
    const statusNode = state.chartRoot.querySelector("[data-role='status']");
    const metaNode = state.chartRoot.querySelector("[data-role='meta']");
    const canvasNode = state.chartRoot.querySelector("[data-role='canvas']");
    const legendNode = state.chartRoot.querySelector("[data-role='legend']");
    if (!titleNode || !statusNode || !metaNode || !canvasNode || !legendNode) {
      return;
    }

    titleNode.textContent = "...";
    statusNode.textContent = "加载中";
    statusNode.dataset.kind = "default";
    metaNode.textContent = "等待页面返回最新数据";
    if (state.tooltipCleanup) {
      state.tooltipCleanup();
      state.tooltipCleanup = null;
    }
    canvasNode.innerHTML = `<div class="cbuc-loading">${escapeHtml(text)}</div>`;
    renderToggleState(false);
    renderLegend(legendNode, null, false);
  }

  function renderEmptyState(text, source) {
    if (!state.chartRoot) {
      return;
    }
    const titleNode = state.chartRoot.querySelector(".cbuc-total");
    const statusNode = state.chartRoot.querySelector("[data-role='status']");
    const metaNode = state.chartRoot.querySelector("[data-role='meta']");
    const canvasNode = state.chartRoot.querySelector("[data-role='canvas']");
    const legendNode = state.chartRoot.querySelector("[data-role='legend']");
    if (!titleNode || !statusNode || !metaNode || !canvasNode || !legendNode) {
      return;
    }

    titleNode.textContent = "0";
    statusNode.textContent = (source && source.label) || "暂无数据";
    statusNode.dataset.kind = "warning";
    metaNode.textContent = (source && source.meta) || "当前范围无记录";
    if (state.tooltipCleanup) {
      state.tooltipCleanup();
      state.tooltipCleanup = null;
    }
    canvasNode.innerHTML = `<div class="cbuc-empty">${escapeHtml(text)}</div>`;
    renderToggleState(false);
    renderLegend(legendNode, null, false);
  }

  function renderToggleState(hasData) {
    if (!state.chartRoot) {
      return;
    }
    const button = state.chartRoot.querySelector("[data-role='toggle-model-mode']");
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.disabled = !hasData;
    button.setAttribute("aria-pressed", hasData && state.splitByModel ? "true" : "false");
  }

  function renderLegend(legendNode, bucketData, splitByModel) {
    if (!legendNode) {
      return;
    }
    if (splitByModel && bucketData && bucketData.modelTotals.length) {
      legendNode.innerHTML =
        `<span class="cbuc-legend-item"><span>${escapeHtml(getLabels().series)}</span></span>` +
        bucketData.modelTotals
          .map(
            (model) => `
              <span class="cbuc-legend-item">
                <span class="cbuc-legend-swatch" style="background:${escapeHtml(model.color)}"></span>
                <span>${escapeHtml(model.name)}</span>
              </span>
            `
          )
          .join("");
      return;
    }
    legendNode.innerHTML = `
      <span class="cbuc-legend-item">
        <span class="cbuc-legend-swatch"></span>
        <span>${escapeHtml(getLabels().series)}</span>
      </span>
    `;
  }

  /* ------------------------------------------------------------------ *
   * 聚合
   * ------------------------------------------------------------------ */



  /* ------------------------------------------------------------------ *
   * 记录解析
   * ------------------------------------------------------------------ */








  function getModelColor(modelName) {
    const normalized = normalizeModelName(modelName);
    if (normalized === UNKNOWN_MODEL_NAME) {
      return readThemeColor(state.chartRoot, "--cbuc-unknown-model", "#9ca0a9");
    }
    if (state.modelColors.has(normalized)) {
      return state.modelColors.get(normalized);
    }
    // 首个模型用品牌色，避免「按模型划分」时整片柱子与页面主色脱节
    let color;
    if (state.nextModelColorIndex === 0) {
      color = readThemeColor(state.chartRoot, "--cbuc-accent-strong", MODEL_COLOR_PALETTE[0]);
      state.nextModelColorIndex = 1;
    } else if (state.nextModelColorIndex - 1 < MODEL_COLOR_PALETTE.length) {
      color = MODEL_COLOR_PALETTE[state.nextModelColorIndex - 1];
      state.nextModelColorIndex += 1;
    } else {
      color = `hsl(${hashText(normalized) % 360} 32% 62%)`;
    }
    state.modelColors.set(normalized, color);
    return color;
  }

  /* ------------------------------------------------------------------ *
   * 范围与签名
   * ------------------------------------------------------------------ */

  function resolveSignature(meta, extracted, uiState) {
    const hinted = extractRangeHint(meta);
    // UI 优先：uiState 已按标签口径截齐，若让请求体里的日期（平台原始窗口）优先，
    // 同一档位会算出两个 signature，缓存与聚合范围就对不上了。
    if (uiState && (uiState.startDate || uiState.endDate)) {
      return getStateSignature(uiState);
    }
    const startDate = hinted.startDate || "";
    const endDate = hinted.endDate || "";
    const rangeKey = hinted.rangeKey || "";
    const aligned = alignRangeToLabel({
      startDate,
      endDate,
      rangeKey,
      unit: determineUnit(rangeKey, startDate, endDate),
    });
    return buildSignature(
      aligned.startDate,
      aligned.endDate,
      rangeKey,
      determineUnit(rangeKey, aligned.startDate, aligned.endDate)
    );
  }








  function getCachedRecordsForUiState(uiState) {
    const bounds = getRangeBounds(uiState, uiState.unit);
    return bounds ? getCachedRecordsByBounds(bounds) : [];
  }

  function getCachedRecordsForDataset(dataset) {
    if (!dataset || !dataset.startDate || !dataset.endDate) {
      return [];
    }
    const bounds = getRangeBounds(
      { startDate: dataset.startDate, endDate: dataset.endDate },
      dataset.unit || "day"
    );
    return bounds ? getCachedRecordsByBounds(bounds) : [];
  }

  function getCachedRecordsByBounds(bounds) {
    const records = [];
    for (const record of state.recordPool.values()) {
      const time = parseDateTime(record.requestTime);
      if (!time || time < bounds.filterStart || time > bounds.filterEnd) {
        continue;
      }
      records.push(record);
    }
    return records.sort(
      (left, right) => parseDateTime(left.requestTime) - parseDateTime(right.requestTime)
    );
  }


  /**
   * 平台区间对齐：两处前端的预设档位都是 start = 今天 − N，
   * 于是「7天」覆盖 8 个自然日、「30天」覆盖 31 个。
   *
   * 只在「识别为平台自动生成的范围」时截齐（跨度 = N+1 且终点是今天），
   * 手动挑选的日期区间保持原样，不擅自裁剪用户的选择。
   */

  /** 对齐提示文案：只在发生截齐时出现 */

  /* ------------------------------------------------------------------ *
   * 分页模板（个人版补数）
   * ------------------------------------------------------------------ */

  function derivePaginationPlan(meta, totalExpected) {
    if (!meta || !meta.url) {
      return null;
    }
    const template = parseRequestTemplate(meta);
    if (!template || !Number.isFinite(totalExpected) || totalExpected <= 0) {
      return null;
    }
    const sourcePageSize = template.pageSize;
    if (!Number.isFinite(sourcePageSize) || sourcePageSize <= 0) {
      return null;
    }
    // 放大页大小以减少请求数。注意页码语义随之改变（新第 1 页 = 前 100 条），
    // 所以第 1 页必须重取，否则会漏掉原第 1 页与新第 2 页之间那段。
    const pageSize =
      sourcePageSize < HYDRATE_PAGE_SIZE ? HYDRATE_PAGE_SIZE : sourcePageSize;
    const pageSizeChanged = pageSize !== sourcePageSize;
    const totalPages = Math.ceil(totalExpected / pageSize);
    if (totalPages <= 1) {
      return null;
    }
    // 安全阀：极端区间（如个人版 30 天 1100+ 条 = 110+ 页）不至于打上百个请求
    const pages = Math.min(totalPages, HYDRATE_PAGE_LIMIT);
    if (template.mode === "page") {
      return {
        ...template,
        totalExpected,
        pageSize,
        pageSizeChanged,
        totalPages: pages,
        firstPage: template.currentValue === 0 ? 0 : 1,
      };
    }
    return { ...template, totalExpected, pageSize, pageSizeChanged, totalPages: pages };
  }

  function parseRequestTemplate(meta) {
    let url;
    try {
      url = new URL(meta.url, location.origin);
    } catch (error) {
      return null;
    }
    const method = String(meta.method || "GET").toUpperCase();
    const queryParams = Object.fromEntries(url.searchParams.entries());
    const bodyInfo = parseBodyTemplate(meta.body);
    const sources = [];
    if (bodyInfo.params && Object.keys(bodyInfo.params).length) {
      sources.push({ target: "body", params: bodyInfo.params });
    }
    if (Object.keys(queryParams).length) {
      sources.push({ target: "query", params: queryParams });
    }

    for (const source of sources) {
      const pageKey = detectNumericKey(source.params, [
        "pageIndex", "pageNum", "page", "current", "currentPage",
      ]);
      const sizeKey = detectNumericKey(
        source.params,
        ["pageSize", "page_size", "size", "limit", "pageLimit"],
        [pageKey]
      );
      if (pageKey && sizeKey) {
        return {
          mode: "page",
          url,
          method,
          headers: sanitizeHeaders(meta.headers),
          target: source.target,
          bodyType: bodyInfo.type,
          queryParams,
          bodyParams: bodyInfo.params,
          pageKey,
          sizeKey,
          currentValue: Number(source.params[pageKey]),
          pageSize: Number(source.params[sizeKey]),
        };
      }
      const offsetKey = detectNumericKey(source.params, ["offset", "start", "skip"]);
      const limitKey = detectNumericKey(
        source.params,
        ["limit", "size", "pageSize", "page_size"],
        [offsetKey]
      );
      if (offsetKey && limitKey) {
        return {
          mode: "offset",
          url,
          method,
          headers: sanitizeHeaders(meta.headers),
          target: source.target,
          bodyType: bodyInfo.type,
          queryParams,
          bodyParams: bodyInfo.params,
          offsetKey,
          limitKey,
          currentValue: Number(source.params[offsetKey]),
          pageSize: Number(source.params[limitKey]),
        };
      }
    }
    return null;
  }

  function parseBodyTemplate(body) {
    if (!body || typeof body !== "string") {
      return { type: "none", params: null };
    }
    const trimmed = body.trim();
    if (!trimmed) {
      return { type: "none", params: null };
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { type: "json", params: parsed };
        }
      } catch (error) {
        return { type: "raw", params: null };
      }
    }
    try {
      const params = Object.fromEntries(new URLSearchParams(trimmed).entries());
      if (Object.keys(params).length) {
        return { type: "form", params };
      }
    } catch (error) {
      return { type: "raw", params: null };
    }
    return { type: "raw", params: null };
  }

  function detectNumericKey(params, candidates, exclude = []) {
    for (const candidate of candidates) {
      if (exclude.includes(candidate)) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(params, candidate)) {
        if (Number.isFinite(Number(params[candidate]))) {
          return candidate;
        }
      }
    }
    return null;
  }

  function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== "object") {
      return {};
    }
    const result = {};
    Object.entries(headers).forEach(([key, value]) => {
      if (!/^(content-length|host|cookie)$/i.test(key)) {
        result[key] = String(value);
      }
    });
    return result;
  }

  /* ------------------------------------------------------------------ *
   * 工具：数字 / 日期 / 文本
   * ------------------------------------------------------------------ */


  /**
   * 统一按北京时间解析。
   * 页面接口给的 "2026-10-26 21:02:59" 本就是北京时间，
   * 若交给 `new Date()` 会按本机时区解释，跨时区/改系统时区就会错位。
   */




















  function getOwnText(element) {
    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join("")
      .trim();
  }

  function getCellText(cell) {
    return cell ? (cell.textContent || "").trim() : "";
  }

  function readThemeVars(root) {
    if (!root || typeof getComputedStyle !== "function") {
      return {};
    }
    const style = getComputedStyle(root);
    const names = [
      "--cbuc-grid", "--cbuc-axis", "--cbuc-accent", "--cbuc-accent-strong",
      "--cbuc-bar-glow", "--cbuc-unknown-model",
    ];
    const result = {};
    names.forEach((name) => {
      result[name] = style.getPropertyValue(name).trim();
    });
    return result;
  }

  function readThemeColor(root, name, fallback) {
    const cached = state.themeVars && state.themeVars[name];
    if (cached) {
      return cached;
    }
    if (!root || typeof getComputedStyle !== "function") {
      return fallback;
    }
    return getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  }

  function isLoadingHintActive() {
    return Date.now() < state.interactionHintUntil;
  }

  /**
   * 图表聚合入口：算出区间后交给纯函数分桶，颜色沿用页面主题。
   * 桶数过多（如按小时的宽区间）时降到天粒度——上千个 SVG 节点既卡又看不清。
   */
  function aggregateRecords(records, uiState, unit) {
    const plan = resolveGranularity(uiState, unit, MAX_BUCKETS);
    if (plan.downgraded) {
      debugLog("chart.downsample", { from: unit, buckets: plan.buckets, to: plan.unit });
    }
    return bucketizeRecords(
      records,
      getRangeBounds(uiState, plan.unit),
      plan.unit,
      getModelColor
    );
  }
})();
