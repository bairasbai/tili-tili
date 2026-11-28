#!/usr/bin/env node
// GitHub-страж для Claude Code. Общий журнал действует на одной машине при общем GH_GUARD_STATE_DIR.
// Назначение: консервативная защита от частых обращений к GitHub в поддерживаемых Claude Code hooks.
//
// PreToolUse (Bash, PowerShell, Monitor, WebFetch, GitHub-MCP):
//   • считает обращения к GitHub (gh, git push, api.github.com, MCP) в ОДНОМ журнале на все сессии;
//   • запрещает опрос в цикле (gh run watch, --watch, while/until, цикл со sleep) и запись в цикле;
//   • выдерживает паузу между пишущими действиями и ждёт, если минутный лимит занят;
//   • блокирует, когда часовой бюджет исчерпан или GitHub недавно ответил «лимит / abuse / неверный токен».
// PostToolUse / PostToolUseFailure: GitHub ответил такой ошибкой → пауза для ВСЕХ сессий.
// Сбой самого стража → вызов проходит, работа не ломается.
//
// Только для владельца, в своём терминале (агентам сброс запрещён):
//   node "%USERPROFILE%\.claude\hooks\github-api-guard.js" --status   — сколько запросов, есть ли пауза
//   node "%USERPROFILE%\.claude\hooks\github-api-guard.js" --clear    — снять паузу
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Лимиты GitHub (docs.github.com, 2026): 5000 запросов/час, 900 очков/мин, контент — 80/мин и 500/час,
// между пишущими запросами ≥ 1 с. Наши — с большим запасом: одна команда gh ≈ 1–5 HTTP-запросов.
const LIMITS = { perMinute: 12, perHour: 200, writesPerHour: 30, writeGapMs: 3000, maxWaitMs: 20000 };
const PAUSES = {
  suspended: { min: 720, label: 'аккаунт заблокирован или ограничен' },
  primary: { min: 60, label: 'исчерпан лимит API (rate limit exceeded)' },
  secondary: { min: 15, label: 'слишком часто (secondary rate limit / abuse)' },
  auth: { min: 10, label: 'токен неверный или отозван (Bad credentials)' },
};

const DIR = process.env.GH_GUARD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const LOG = path.join(DIR, 'github-api-guard.jsonl');
const PAUSE = path.join(DIR, 'github-api-guard.pause.json');
const GH_HOSTS = path.join(process.env.GH_CONFIG_DIR || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'GitHub CLI') : path.join(os.homedir(), '.config', 'gh')), 'hosts.yml');

const MSG = {
  bypass: '🛑 GitHub-страж: снимать паузу и чистить журнал стража может только владелец в своём терминале. Сообщи ему, если пауза мешает.',
  poll: (what) => `🛑 GitHub-страж: опрос GitHub в цикле запрещён (${what}) — gh run watch дёргает API каждые 3 с, gh pr checks --watch — каждые 10 с. Проверь статус ОДИН раз. Ждать CI — повторная проверка не чаще раза в 2–3 мин (ScheduleWakeup), в desktop — монитор PR.`,
  writeLoop: '🛑 GitHub-страж: пишущие действия в цикле / через xargs запрещены. Одна команда — одно действие (страж сам выдержит паузу) или один общий запрос (например, одно ревью PR со всеми комментариями). Массовые операции — только с явного разрешения владельца.',
  hour: (used, at) => `🛑 GitHub-страж: часовой бюджет исчерпан — ${used}/${LIMITS.perHour} обращений к GitHub за час (все сессии вместе). Следующее окно ≈ ${hhmm(at)}. Работай локально (git log/diff/show, grep), GitHub-шаги отложи; срочно — скажи владелецу.`,
  writes: (used, at) => `🛑 GitHub-страж: лимит пишущих действий — ${used}/${LIMITS.writesPerHour} за час. Следующее ≈ ${hhmm(at)}. Объедини или отложи; срочно — скажи владелецу.`,
  busy: (sec) => `⏳ GitHub-страж: минутный лимит (${LIMITS.perMinute}/мин на все сессии) занят. Повтори через ~${sec} с и не запускай GitHub-запросы параллельно.`,
  pause: (p, now) => `🛑 GitHub на паузе до ${hhmm(p.until)} (ещё ~${Math.max(1, Math.ceil((p.until - now) / 60e3))} мин): GitHub ответил «${p.label}». Никаких запросов к GitHub до конца паузы — повторы во время лимита GitHub прямо называет поводом для бана. Не обходи через curl/MCP/другую сессию; делай то, что можно локально, и сообщи владелецу.`
    + (p.kind === 'auth' ? ' Токен не работает: попроси владельца войти заново — `gh auth login` (запускать вход самому — только по его просьбе: `gh auth login --web`, код он подтверждает сам). После входа пауза снимется сама.' : ''),
};

// ── Разбор shell-команды ──────────────────────────────────────────────────
// Вызов «в позиции команды»: начало, ; & | ( ) { } `, $(, перевод строки, do/then/if/xargs/watch…
const opener = (quotes) => String.raw`(?:^|[;&|(){}\n\`${quotes}]|\$\(|\b(?:do|then|else|if|elif|while|until|time|exec|nohup|sudo|xargs(?:\s+-\S+)*|watch(?:\s+-\S+(?:\s+\d[\d.]*)?)*)\s)`;
const GH_TAIL = String.raw`\s*(?:\w+=\S*\s+)*(?:[\w.:~-]*[\\/])*gh(?:\.exe)?\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?`;
const GH_RE = new RegExp(opener('') + GH_TAIL, 'gi');
const GH_RE_NESTED = new RegExp(opener(`"'`) + GH_TAIL, 'gi');
const PUSH_RE = new RegExp(opener('') + String.raw`\s*(?:\w+=\S*\s+)*git(?:\.exe)?(?:\s+-[Cc]\s+\S+)*\s+push\b`, 'gi');
const WHILE_RE = new RegExp(opener('') + String.raw`\s*(?:while|until)\b|\bdo\s*\{|` + opener('') + String.raw`\s*watch\s`, 'i');
const FOR_RE = new RegExp(opener('') + String.raw`\s*for(?:each)?\b|ForEach-Object|%\s*\{|\bxargs\b`, 'i');
const NESTED_RE = /\b(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\b[^\n;&|]*?\s-(?:c|Command)\b|\bcmd(?:\.exe)?\s+\/[ck]\b|\beval\b|Invoke-Expression|\biex\b/i;
const WRITE_VERB = /^(create|merge|close|reopen|comment|edit|review|ready|update-branch|lock|unlock|revert|delete|transfer|pin|unpin|develop|fork|rename|archive|unarchive|sync|upload|delete-asset|enable|disable|rerun|cancel|set|remove|add|link|unlink|copy|mark-template|item-add|item-create|item-edit|item-delete|item-archive|field-create|field-delete)$/;
const FREE_SUB = /^(config|alias|completion|help|version|auth)$/; // локальные команды, лимит не тратят

// Текст в кавычках и heredoc — это данные (сообщения коммитов, grep-шаблоны), а не вызовы.
function stripLiterals(s) {
  return s
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2(?=\s|$|\))/g, ' _ ')
    .replace(/"[^"\n]*[\\/]gh(?:\.exe)?"/gi, ' gh ')
    .replace(/'[^']*'/g, ' _ ')
    .replace(/"(?:[^"\\]|\\[\s\S])*"/g, ' _ ');
}

function classifyShell(cmd) {
  if (!/gh|api\.github\.com|push|github-api-guard/i.test(cmd)) return null;
  if (/github-api-guard/i.test(cmd) && /--clear|\brm\s|\bdel\s|Remove-Item|unlink|Clear-Content|Set-Content|Out-File|truncate|>\s*["']?\S*github-api-guard/i.test(cmd)) return { deny: MSG.bypass };
  const nested = NESTED_RE.test(cmd);
  const text = nested ? cmd : stripLiterals(cmd);
  const calls = [];
  for (const m of text.matchAll(nested ? GH_RE_NESTED : GH_RE)) {
    const sub = m[1].toLowerCase(), verb = (m[2] || '').toLowerCase();
    const rest = text.slice(m.index + m[0].length);
    const cut = rest.search(/[;&|\n]/);
    const seg = m[0] + (cut < 0 ? rest : rest.slice(0, cut));
    const kind = `gh ${sub}${verb ? ' ' + verb : ''}`;
    if ((sub === 'run' && verb === 'watch') || /\s--watch\b/.test(seg)) return { deny: MSG.poll(sub === 'run' && verb === 'watch' ? kind : kind + ' --watch') };
    if (FREE_SUB.test(sub) || (sub === 'api' && /\brate_limit\b/.test(seg)) || /\s(?:--help|-h)(?:\s|$)/.test(seg)) {
      // Вход заново — лекарство от паузы «неверный токен», его пауза не держит.
      calls.push({ k: kind, n: 0, w: 0, fix: sub === 'auth' && /^(login|refresh|logout|switch|token|setup-git)$/.test(verb) });
      continue;
    }
    let w = WRITE_VERB.test(verb) || (sub === 'workflow' && verb === 'run') || (sub === 'label' && verb === 'clone');
    if (sub === 'api') {
      if (verb === 'graphql') w = /\bmutation\b/.test(cmd);
      else {
        const mm = seg.match(/(?:-X\s*|--method[=\s]+)([a-z]+)/i);
        w = !/^(GET|HEAD)$/i.test(mm ? mm[1] : (/\s(?:-f|-F|--field|--raw-field|--input)\b/.test(seg) ? 'POST' : 'GET'));
      }
    }
    calls.push({ k: kind, n: /--paginate\b/.test(seg) ? 10 : 1, w: w ? 1 : 0 });
  }
  for (const _ of text.matchAll(PUSH_RE)) calls.push({ k: 'git push', n: 1, w: 1 });
  const urls = (cmd.match(/(?:api|uploads)\.github\.com/gi) || []).length;
  if (urls) {
    const w = /\s-X\s*(POST|PATCH|PUT|DELETE)|--request\s+(POST|PATCH|PUT|DELETE)|-Method\s+(Post|Patch|Put|Delete)|\s(?:-d|--data\S*|--json)\s/i.test(cmd);
    calls.push({ k: 'api.github.com', n: Math.min(urls, 5), w: w ? 1 : 0 });
  }
  if (!calls.length) return null;
  const real = calls.filter((c) => c.n > 0);
  if (real.length) {
    const forLoop = FOR_RE.test(text);
    if (WHILE_RE.test(text) || (forLoop && /\bsleep\b|Start-Sleep|\btimeout\s+\/t\b/i.test(text))) return { deny: MSG.poll('цикл или watch вокруг GitHub-запроса') };
    if (forLoop && real.some((c) => c.w)) return { deny: MSG.writeLoop };
    if (forLoop) for (const c of real) c.n *= 10; // цикл чтения — считаем как 10 обращений
  }
  return { calls };
}

function classifyTool(name, ti) {
  if (/^mcp__/.test(name) && /github/i.test(name)) {
    const op = name.split('__').pop().replace(/^github_/i, '');
    const w = /^(create|update|delete|merge|push|fork|add|remove|close|reopen|submit|approve|dispatch|rerun|cancel|star|unstar|follow|unfollow|transfer|lock|unlock|edit|upload|assign|request|mark|dismiss|pr_manage|workflow|issue_track)/i.test(op);
    return { calls: [{ k: 'mcp ' + op, n: /repo_analyze|metrics/i.test(op) ? 5 : 1, w: w ? 1 : 0 }] };
  }
  if (/^https?:\/\/(?:api|uploads)\.github\.com\//i.test(String(ti.url || ''))) return { calls: [{ k: 'fetch api.github.com', n: 1, w: 0 }] };
  return null;
}

// ── Журнал и пауза (общие для всех сессий) ────────────────────────────────
const sum = (arr, k) => arr.reduce((a, e) => a + (Number(e[k]) || 0), 0);
const hhmm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hostsMtime = () => { try { return fs.statSync(GH_HOSTS).mtimeMs; } catch { return 0; } };

function readLog(now) {
  let raw = '';
  try { raw = fs.readFileSync(LOG, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (const l of lines) { try { const e = JSON.parse(l); if (now - e.t < 3600e3) out.push(e); } catch {} }
  if (lines.length - out.length > 300) { // изредка выкидываем записи старше часа
    try { const tmp = `${LOG}.${process.pid}`; fs.writeFileSync(tmp, out.map((e) => JSON.stringify(e)).join('\n') + '\n'); fs.renameSync(tmp, LOG); } catch {}
  }
  return out;
}

function append(e) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG, JSON.stringify(e) + '\n'); } catch {}
}

// Когда освободится `excess` единиц: самые старые записи окна выпадают по одной.
function freeAt(entries, win, excess, now, key = 'n') {
  let acc = 0;
  for (const e of entries.slice().sort((a, b) => a.t - b.t)) { acc += Number(e[key]) || 0; if (acc >= excess) return e.t + win + 200; }
  return now + win;
}

function activePause(now) {
  let p;
  try { p = JSON.parse(fs.readFileSync(PAUSE, 'utf8')); } catch { return null; }
  if (!p || !(p.until > now)) return null;
  if (p.kind === 'auth' && hostsMtime() !== p.hosts) { try { fs.unlinkSync(PAUSE); } catch {} return null; } // перелогинился
  return p;
}

// ── События хука ──────────────────────────────────────────────────────────
function deny(reason, meta, now) {
  append({ t: now, n: 0, w: 0, d: 1, k: reason.slice(0, 70), ...meta });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function pre(c, meta) {
  const now = Date.now();
  if (c.deny) return deny(c.deny, meta, now);
  const p = activePause(now);
  if (p && !c.calls.every((x) => x.fix)) return deny(MSG.pause(p, now), meta, now);
  const n = sum(c.calls, 'n'), w = sum(c.calls, 'w');
  if (!n) return ''; // только бесплатное: gh auth, gh api rate_limit, gh help…
  const hour = readLog(now), minute = hour.filter((e) => now - e.t < 60e3);
  const hourN = sum(hour, 'n'), hourW = sum(hour, 'w');
  if (hourN + n > LIMITS.perHour) return deny(MSG.hour(hourN, freeAt(hour, 3600e3, hourN + n - LIMITS.perHour, now)), meta, now);
  if (w && hourW + w > LIMITS.writesPerHour) return deny(MSG.writes(hourW, freeAt(hour, 3600e3, hourW + w - LIMITS.writesPerHour, now, 'w')), meta, now);
  let wait = 0;
  const minN = sum(minute, 'n'), need = Math.min(n, LIMITS.perMinute);
  if (minN + need > LIMITS.perMinute) wait = freeAt(minute, 60e3, minN + need - LIMITS.perMinute, now) - now;
  if (w) wait = Math.max(wait, Math.max(0, ...hour.filter((e) => e.w).map((e) => e.t)) + LIMITS.writeGapMs - now);
  if (wait > LIMITS.maxWaitMs) return deny(MSG.busy(Math.ceil(wait / 1000)), meta, now);
  if (wait > 0) sleep(wait);
  append({ t: Date.now(), n, w, k: c.calls.map((x) => x.k).join(', ').slice(0, 80), ...meta });
  return '';
}

function detect(text) {
  if (/account (?:was |has been |is )?(?:suspended|flagged)/i.test(text)) return 'suspended';
  if (/secondary rate limit|abuse detection|abuse-rate-limits|submitted too quickly|HTTP 429|429 Too Many Requests/i.test(text)) return 'secondary';
  if (/API rate limit exceeded|rate limit exceeded for|x-ratelimit-remaining["':\s]+0\b/i.test(text)) return 'primary';
  if (/Bad credentials|HTTP 401|401 Unauthorized|Requires authentication|Authentication failed for 'https:\/\/github\.com|gh auth login/i.test(text)) return 'auth';
  return null;
}

function post(ev, c, input, meta) {
  if (c.deny) return '';
  const r = input.tool_response;
  let text = String(input.error || '');
  if (r && typeof r === 'object' && ('stdout' in r || 'stderr' in r)) {
    // Берём только каналы ошибок: stdout gh-поиска может цитировать чужие «rate limit exceeded».
    const errLines = String(r.stdout || '').split('\n').filter((l) => /^\s*(?:gh:|error:|fatal:|remote:|HTTP \d{3}|\{?\s*"message"\s*:)/i.test(l));
    text += '\n' + String(r.stderr || '') + '\n' + errLines.join('\n');
  } else if (r != null) {
    const s = typeof r === 'string' ? r : JSON.stringify(r);
    if (ev === 'PostToolUseFailure' || s.length < 1500 || r.isError) text += '\n' + s;
  }
  const kind = detect(text);
  if (!kind) return '';
  const now = Date.now();
  let p = activePause(now);
  if (!p || p.until < now + PAUSES[kind].min * 60e3) {
    p = { kind, label: PAUSES[kind].label, until: now + PAUSES[kind].min * 60e3, since: now, hosts: hostsMtime(),
      by: `${c.calls.map((x) => x.k).join(', ')} [${meta.p}]`.slice(0, 120) };
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(PAUSE, JSON.stringify(p)); } catch {}
  }
  return JSON.stringify({
    systemMessage: `⚠️ GitHub ответил «${p.label}» — все обращения к GitHub на паузе до ${hhmm(p.until)}.`,
    hookSpecificOutput: { hookEventName: ev, additionalContext: MSG.pause(p, now) },
  });
}

function main(input) {
  const ev = input.hook_event_name || 'PreToolUse';
  const name = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const c = /^(Bash|PowerShell|Monitor)$/.test(name)
    ? classifyShell(String(ti.command || ti.cmd || ti.script || ''))
    : classifyTool(name, ti);
  if (!c) return '';
  const meta = { p: path.basename(String(input.cwd || '')), s: String(input.session_id || '').slice(0, 8) };
  if (ev === 'PreToolUse') return pre(c, meta);
  if (ev === 'PostToolUse' || ev === 'PostToolUseFailure') return post(ev, c, input, meta);
  return '';
}

function status() {
  const now = Date.now(), log = readLog(now), p = activePause(now);
  const win = (ms) => log.filter((e) => now - e.t < ms);
  console.log('GitHub-страж — все сессии Claude Code вместе');
  console.log(`  за минуту: ${sum(win(60e3), 'n')}/${LIMITS.perMinute}   за час: ${sum(log, 'n')}/${LIMITS.perHour}   пишущих за час: ${sum(log, 'w')}/${LIMITS.writesPerHour}   отказов за час: ${log.filter((e) => e.d).length}`);
  console.log(p ? `  ПАУЗА до ${hhmm(p.until)} — ${p.label} (${p.by})` : '  пауза: нет');
  for (const e of log.slice(-10)) console.log(`  ${hhmm(e.t)}  ${e.d ? 'ОТКАЗ: ' : ''}${e.k}  [${e.p || '?'}]`);
}

const arg = process.argv[2];
if (arg === '--status') status();
else if (arg === '--clear') { try { fs.unlinkSync(PAUSE); } catch {} console.log('Пауза GitHub снята.'); }
else {
  let out = '';
  try { out = main(JSON.parse(fs.readFileSync(0, 'utf8') || '{}')); } catch { out = ''; }
  if (out) fs.writeSync(1, out);
}
