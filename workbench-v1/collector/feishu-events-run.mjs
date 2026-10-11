#!/usr/bin/env node
/**
 * v1/collector/feishu-events-run.mjs —— 飞书聊天的**常驻消费者**入口
 *
 * 干一件事：把 `lark-cli event consume im.message.receive_v1 --as bot` 的输出**追加**到
 * `_meta/out/v1/.runtime/fs-im-events.ndjson`，然后**一直活着**（连接断了就重连）。
 * 采集器（`fs-im-group` / `fs-im-p2p`）每轮只读那个文件 —— 它们不自己建连接。
 *
 * 为什么不放进 5 分钟节拍：长连接只在活着时收事件，节拍里跑 20 秒会漏掉中间 4 分 40 秒的消息
 * （那是典型的假绿）。钉钉那条从 2026-09-21 起就是这么常驻的。
 *
 * 用法（隐藏窗口启动）：
 *   wscript _meta/tools/run-hidden.vbs node _meta/workbench/v1/collector/feishu-events-run.mjs
 * 停止：杀掉本进程即可（它会顺手把子进程带走）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { startConsumer, eventsFile, consumerStateFile, EVENT_KEY } from './feishu-events.mjs';

const LOG = path.join(path.dirname(eventsFile()), 'fs-im-consumer.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const say = (m) => {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { /* noop */ }
  process.stdout.write(line);
};

say(`消费者启动：event=${EVENT_KEY} → ${eventsFile()}`);

let proc = null;
let stopping = false;

function boot() {
  if (stopping) return;
  const { proc: p, state } = startConsumer({});
  proc = p;
  say(`已起 lark-cli event consume（pid=${state.pid}）`);
  p.on('exit', (code, sig) => {
    say(`consume 退出（code=${code} sig=${sig}）—— 5 秒后重连`);
    if (!stopping) setTimeout(boot, 5000);
  });
}

boot();

// 心跳：每 5 分钟记一次，方便判断"它是不是还活着"（而不是只有崩溃时才有日志）
setInterval(() => {
  let lines = 0;
  try { lines = fs.readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean).length; } catch { /* 还没有文件 */ }
  try {
    const st = JSON.parse(fs.readFileSync(consumerStateFile(), 'utf8'));
    say(`心跳：子进程 pid=${st.pid} · 事件文件累计 ${lines} 行`);
  } catch { say(`心跳：事件文件累计 ${lines} 行`); }
}, 5 * 60 * 1000);

const bye = () => {
  stopping = true;
  say('收到退出信号，停子进程');
  try { proc?.kill(); } catch { /* noop */ }
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
