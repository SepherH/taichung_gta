#!/usr/bin/env node
// 測試總入口：依檔名排序逐支執行 tools/test/*.mjs（排除本檔），不並行
// 用法：node tools/test/run-all.mjs [篩選字串]（只跑檔名含該字串者；任一失敗 exit 1）
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, '..', '..');
const self = 'run-all.mjs';
const filter = process.argv[2];

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.mjs') && f !== self)
  .filter((f) => filter === undefined || f.includes(filter))
  .sort();

const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(testDir, f)], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) failed.push(f);
}

const total = files.length;
console.log(`run-all: ${total - failed.length}/${total} passed, ${failed.length} failed`);
for (const f of failed) console.log(f);
process.exit(failed.length > 0 ? 1 : 0);
