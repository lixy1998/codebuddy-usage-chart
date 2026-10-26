import test from "node:test";
import assert from "node:assert/strict";

import {
  parseNumber,
  parseDateTime,
  normalizeDateTime,
  normalizeDateOnly,
  parseDateOnly,
  startOfDay,
  formatDateOnly,
  formatAxisValue,
  getNiceScale,
  determineUnit,
  alignRangeToLabel,
  describeRangeAdjustment,
  buildSignature,
  parseSignature,
  getRangeBounds,
  dedupeRecords,
  fingerprintRecords,
  normalizeUsageRecord,
  extractUsageRecords,
  extractRangeHint,
  calibrateSeries,
  describeCalibration,
  resolveGranularity,
  bucketizeRecords,
  getExpectedCount,
  DAY_MS,
} from "../src/core.js";

const NOW = Date.UTC(2026, 9, 26, 5, 0, 0); // 北京时间 2026-10-26 13:00

test("时间解析固定按 UTC+8，不受运行机时区影响", () => {
  const t = parseDateTime("2026-10-26 21:02:59");
  assert.equal(t, Date.UTC(2026, 9, 26, 13, 2, 59));
  assert.equal(normalizeDateTime(t), "2026-10-26 21:02:59");
  assert.equal(normalizeDateTime("2026-10-26 00:00:00"), "2026-10-26 00:00:00");
});

test("日期往返：parseDateOnly → startOfDay → formatDateOnly", () => {
  for (const d of ["2026-10-19", "2026-01-01", "2026-12-31"]) {
    assert.equal(formatDateOnly(startOfDay(parseDateOnly(d))), d);
  }
});

test("只含日期的记录归到当天零点", () => {
  assert.equal(normalizeDateTime("2026-10-25"), "2026-10-25 00:00:00");
  assert.equal(normalizeDateOnly("2026/10/5"), "2026-10-05");
});

test("数值解析容忍千分位与单位文字", () => {
  assert.equal(parseNumber("1,234.56"), 1234.56);
  assert.equal(parseNumber(" 0.49 积分 "), 0.49);
  assert.ok(Number.isNaN(parseNumber("")));
  assert.ok(Number.isNaN(parseNumber(null)));
});

test("范围截齐：只在“跨度 = 档位+1 且终点是今天”时生效", () => {
  const cases = [
    { key: "7d", s: "2026-10-19", e: "2026-10-26", want: "2026-10-20", adjusted: true },
    { key: "3d", s: "2026-10-23", e: "2026-10-26", want: "2026-10-24", adjusted: true },
    { key: "30d", s: "2026-09-26", e: "2026-10-26", want: "2026-09-27", adjusted: true },
    { key: "today", s: "2026-10-26", e: "2026-10-26", want: "2026-10-26", adjusted: false },
    { key: "7d", s: "2026-10-20", e: "2026-10-26", want: "2026-10-20", adjusted: false },
    { key: "7d", s: "2026-10-05", e: "2026-10-12", want: "2026-10-05", adjusted: false },
  ];
  for (const c of cases) {
    const out = alignRangeToLabel(
      { rangeKey: c.key, startDate: c.s, endDate: c.e, unit: "day" },
      NOW
    );
    assert.equal(out.startDate, c.want, `${c.key} ${c.s}~${c.e}`);
    assert.equal(Boolean(out.rangeAdjusted), c.adjusted, `${c.key} 标记`);
  }
  const adj = alignRangeToLabel(
    { rangeKey: "7d", startDate: "2026-10-19", endDate: "2026-10-26", unit: "day" },
    NOW
  );
  assert.match(describeRangeAdjustment(adj), /7天档实为8天/);
});

test("档位决定聚合粒度", () => {
  assert.equal(determineUnit("today"), "hour");
  assert.equal(determineUnit("3d"), "hour");
  assert.equal(determineUnit("7d"), "day");
  assert.equal(determineUnit("30d"), "day");
});

test("signature 往返稳定", () => {
  const sig = buildSignature("2026-10-20", "2026-10-26", "7d", "day");
  assert.deepEqual(parseSignature(sig), {
    startDate: "2026-10-20",
    endDate: "2026-10-26",
    rangeKey: "7d",
    unit: "day",
  });
  assert.equal(buildSignature("", "", "", ""), "na|na|custom|day");
});

test("区间边界：含首尾整天", () => {
  const bounds = getRangeBounds({ startDate: "2026-10-20", endDate: "2026-10-26" }, "day");
  assert.equal(formatDateOnly(startOfDay(bounds.filterStart)), "2026-10-20");
  assert.equal(formatDateOnly(bounds.filterEnd), "2026-10-26");
  // 桶数 = 7
  const buckets = (bounds.lastBucketStart - bounds.firstBucketStart) / DAY_MS + 1;
  assert.equal(buckets, 7);
});

test("日粒度分桶：记录落对天，越界记录被丢弃", () => {
  const range = getRangeBounds({ startDate: "2026-10-20", endDate: "2026-10-26" }, "day");
  const records = [
    { requestId: "a", credit: 10, requestTime: "2026-10-20 00:30:00", modelName: "m1" },
    { requestId: "b", credit: 20, requestTime: "2026-10-26 23:59:59", modelName: "m1" },
    { requestId: "c", credit: 5, requestTime: "2026-10-26 23:59:59", modelName: "m2" },
    { requestId: "x", credit: 99, requestTime: "2026-10-19 23:59:59", modelName: "m1" },
  ];
  const out = bucketizeRecords(records, range, "day", (n) => `#${n}`);
  assert.equal(out.buckets.length, 7);
  assert.equal(out.buckets[0].value, 10);
  assert.equal(out.buckets[6].value, 25);
  assert.equal(out.total, 35);
  assert.equal(out.maxValue, 25);
  assert.deepEqual(
    out.buckets[6].tooltipModels.map((m) => [m.name, m.value]),
    [["m1", 20], ["m2", 5]]
  );
  assert.equal(out.buckets[6].tooltipModels[0].color, "#m1");
});

test("小时粒度分桶：3 天 = 72 桶", () => {
  const range = getRangeBounds({ startDate: "2026-10-24", endDate: "2026-10-26" }, "hour");
  const out = bucketizeRecords(
    [{ requestId: "a", credit: 1, requestTime: "2026-10-24 13:20:00", modelName: "m" }],
    range,
    "hour",
    () => "#000"
  );
  assert.equal(out.buckets.length, 72);
  assert.equal(out.buckets[13].value, 1);
  assert.equal(out.total, 1);
});

test("校准：柱高总和等于按天汇总，模型占比保留", () => {
  const daily = [
    { requestId: "daily-2026-10-25", credit: 100, requestTime: "2026-10-25 00:00:00" },
    { requestId: "daily-2026-10-26", credit: 0, requestTime: "2026-10-26 00:00:00" },
  ];
  // 明细需基本覆盖当天（coverage ≥ 0.5），否则会走降级分支
  const detail = [
    { requestId: "a", credit: 60, requestTime: "2026-10-25 09:10:00", modelName: "A" },
    { requestId: "b", credit: 40, requestTime: "2026-10-25 10:20:00", modelName: "B" },
  ];
  const { records: out, stats } = calibrateSeries(daily, detail);
  const total = out.reduce((s, r) => s + r.credit, 0);
  assert.ok(Math.abs(total - 100) < 1e-6, "总额应与汇总一致");
  const byModel = {};
  for (const r of out) byModel[r.modelName] = (byModel[r.modelName] || 0) + r.credit;
  assert.equal(Math.round(byModel.A), 60);
  assert.equal(Math.round(byModel.B), 40);
  // 时间点仍落在当天各自小时，天/小时分桶都不失真
  assert.ok(out.every((r) => r.requestTime.startsWith("2026-10-25")));
});

test("校准：当天没有明细时退回整日单条", () => {
  const daily = [{ requestId: "d1", credit: 42, requestTime: "2026-10-24 00:00:00" }];
  const { records: out, stats } = calibrateSeries(daily, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].credit, 42);
  assert.equal(out[0].requestTime, "2026-10-24 00:00:00");
  assert.equal(stats.missing, 1);
});

test("记录归一化：企业版与个人版字段都能认", () => {
  const a = normalizeUsageRecord({
    requestId: "01a1784d",
    credit: 0.49,
    model: "deepseek-v4.1-flash",
    requestTime: "2026-10-26 21:02:59",
    input: "很长很长的请求正文".repeat(100),
  });
  assert.equal(a.credit, 0.49);
  assert.equal(a.modelName, "deepseek-v4.1-flash");
  assert.equal(a.requestTime, "2026-10-26 21:02:59");

  const b = normalizeUsageRecord({ date: "2026-10-25", credit: "70.97" });
  assert.equal(b.credit, 70.97);
  assert.equal(b.requestTime, "2026-10-25 00:00:00");

  assert.equal(normalizeUsageRecord({ credit: 1 }), null);
});

test("从嵌套 payload 里挑出记录数组", () => {
  const payload = {
    code: 0,
    data: {
      total: 2,
      data: [
        { requestId: "a", credit: 1, model: "m", requestTime: "2026-10-26 10:00:00" },
        { requestId: "b", credit: 2, model: "m", requestTime: "2026-10-26 11:00:00" },
      ],
      nextPageToken: "t",
    },
  };
  const out = extractUsageRecords(payload);
  assert.equal(out.records.length, 2);
  assert.equal(out.total, 2);
});

test("从请求体里推断区间（个人版参数形态）", () => {
  const hint = extractRangeHint(
    {
      url: "/billing/meter/get-user-request-usage",
      method: "POST",
      body: JSON.stringify({
        startTime: "2026-10-19 00:00:00",
        endTime: "2026-10-26 23:59:59",
        pageNum: 1,
        pageSize: 10,
      }),
    },
    "https://www.codebuddy.cn"
  );
  assert.equal(hint.startDate, "2026-10-19");
  assert.equal(hint.endDate, "2026-10-26");
});

test("去重与指纹：同 id 合并，模型名优先保留已知", () => {
  const merged = dedupeRecords([
    { requestId: "a", credit: 1, requestTime: "2026-10-26 10:00:00", modelName: "未知模型" },
    { requestId: "a", credit: 1, requestTime: "2026-10-26 10:00:00", modelName: "m" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].modelName, "m");
  assert.equal(fingerprintRecords(merged), fingerprintRecords(merged));
});

test("期望条数：平台窗口含 N+1 天时按天数折算", () => {
  const dataset = { totalExpected: 291 };
  const uiState = {
    totalCount: null,
    rangeAdjusted: { labelDays: 7, platformDays: 8 },
  };
  assert.equal(getExpectedCount(dataset, uiState), Math.floor((291 * 7) / 8));
  assert.equal(getExpectedCount(dataset, { totalCount: null }), 291);
});

test("坐标刻度与文本格式", () => {
  assert.equal(getNiceScale(331).max, 400);
  assert.equal(getNiceScale(0).max, 1);
  assert.equal(formatAxisValue(1200), "1.2K");
  assert.equal(formatAxisValue(9.5), "9.5");
});

test("校准：明细覆盖不足时该天降级为整日直取，不硬缩放", () => {
  const daily = [
    { requestId: "d1", credit: 1000, requestTime: "2026-10-24 00:00:00" },
  ];
  const detail = [
    { requestId: "a", credit: 5, requestTime: "2026-10-24 23:30:00", modelName: "A" },
  ];
  const { records, stats } = calibrateSeries(daily, detail);
  assert.equal(stats.degraded, 1);
  assert.equal(stats.calibrated, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].credit, 1000);
  assert.equal(records[0].requestTime, "2026-10-24 00:00:00");
  assert.match(describeCalibration(stats), /明细覆盖不足/);
});

test("校准：覆盖充分时不提示质量", () => {
  const daily = [{ requestId: "d1", credit: 100, requestTime: "2026-10-24 00:00:00" }];
  const detail = [
    { requestId: "a", credit: 90, requestTime: "2026-10-24 10:00:00", modelName: "A" },
  ];
  const { stats } = calibrateSeries(daily, detail);
  assert.equal(stats.calibrated, 1);
  assert.equal(describeCalibration(stats), "");
});

test("粒度降级：桶数超阈值时按小时退回按天", () => {
  const wide = resolveGranularity({ startDate: "2026-10-01", endDate: "2026-10-26" }, "hour", 240);
  assert.equal(wide.unit, "day");
  assert.equal(wide.downgraded, true);

  const narrow = resolveGranularity({ startDate: "2026-10-24", endDate: "2026-10-26" }, "hour", 240);
  assert.equal(narrow.unit, "hour");
  assert.equal(narrow.downgraded, false);
  assert.equal(narrow.buckets, 72);

  const dayUnit = resolveGranularity({ startDate: "2026-10-19", endDate: "2026-10-26" }, "day", 240);
  assert.equal(dayUnit.unit, "day");
});
