/**
 * 零依赖构建：core.js（纯函数层）+ main.js（页面层）→ 单文件油猴脚本。
 * 用法：node build.mjs [--check]
 *
 * 之所以不用打包器：产物必须是一个可直接贴进 Tampermonkey 的 .user.js，
 * 而源码要能被 node 直接 import 做单测。这里只做「剥离 export + 拼接」。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "codebuddy-usage-chart.user.js");

const HEADER = `// ==UserScript==
// @name         CodeBuddy / WorkBuddy Usage Credit Chart
// @namespace    https://github.com/lixy1998/codebuddy-usage-chart
// @version      __VERSION__
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
`;

/** 从已有产物里读版本号，避免每次手改两处 */
function currentVersion() {
  try {
    const text = readFileSync(OUT, "utf8");
    const hit = text.match(/@version\s+([\d.]+)/);
    return hit ? hit[1] : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 剥掉 core.js 末尾的 export 块（浏览器里所有模块共处同一作用域） */
function stripExports(source) {
  return source.replace(/\nexport\s*\{[\s\S]*?\};\s*$/m, "\n");
}

const args = process.argv.slice(2);
const versionArg = args.find((a) => a.startsWith("--version="));
const version = versionArg ? versionArg.split("=")[1] : currentVersion();

const core = stripExports(readFileSync(join(ROOT, "src", "core.js"), "utf8"));
const main = readFileSync(join(ROOT, "src", "main.js"), "utf8");

const bundle =
  HEADER.replace("__VERSION__", version) +
  "\n/* 由 build.mjs 生成，请勿直接编辑：改 src/core.js 或 src/main.js 后重新构建 */\n" +
  "(function () {\n" +
  '  "use strict";\n\n' +
  core.trim() +
  "\n\n" +
  main.trim() +
  "\n})();\n";

if (args.includes("--check")) {
  const prev = readFileSync(OUT, "utf8");
  if (prev !== bundle) {
    console.error("产物与源码不一致：请运行 node build.mjs");
    process.exit(1);
  }
  console.log("产物与源码一致（version " + version + "）");
  process.exit(0);
}

writeFileSync(OUT, bundle, "utf8");
console.log(
  "built " +
    OUT +
    " (version " +
    version +
    ", " +
    bundle.split("\n").length +
    " lines)"
);
