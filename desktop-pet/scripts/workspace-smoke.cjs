'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
async function runWorkspaceSmoke(window) {
  const output = path.join(__dirname, '../.test-output/workspace');
  await fs.mkdir(output, { recursive: true });
  const execute = code => window.webContents.executeJavaScript(code, true);
  const settle = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const send = async (channel, value) => { window.webContents.send(channel, value); await settle(); };
  const click = selector => execute(`document.querySelector(${JSON.stringify(selector)}).click()`).then(settle);
  const text = selector => execute(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const input = (selector, value) => execute(`(() => {const el=document.querySelector(${JSON.stringify(selector)});
    el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`).then(settle);
  const now = Date.now();
  const fixture = { online: true, fresh: true, updatedAt: now, activityAt: now, activityFresh: true, invalidSchedules: 0, subagents: 1,
    schedules: [
      { id: 'daily', title: '每日英语练习', enabled: true, heartbeat: false, nextRunAt: now + 3600000, timezone: 'Asia/Shanghai' },
      { id: 'monitor', title: '服务可用性检查', enabled: true, heartbeat: true, nextRunAt: now + 300000, timezone: 'Asia/Shanghai' },
      { id: 'digest', title: '周末阅读摘要', enabled: false, heartbeat: false, nextRunAt: null, timezone: 'Asia/Shanghai' },
    ],
    runs: [
      { id: 'r1', title: '服务可用性检查', status: 'running', scheduledAt: now, summary: '正在检查服务状态。', error: '' },
      { id: 'r2', title: '每日英语练习', status: 'completed', scheduledAt: now - 3600000, summary: '英文练习音频已生成。', error: '' },
      { id: 'r3', title: '周末阅读摘要', status: 'failed', scheduledAt: now - 86400000, summary: '', error: '连接中断，请检查后重试。' },
    ],
    agents: [{ id: 'main', code: 'working', title: '整理阅读清单' }, { id: 'approval', code: 'needs_approval', title: '待确认' }],
    activities: [{ id: 'a1', title: '生成英文练习音频', summary: '已生成音频文件', status: 'completed', at: now - 3600000 }],
  };
  const messages = [{ id: 'workspace-fixture', role: 'assistant', state: 'done', text: '今天的练习和资料已经准备好了。', createdAt: now,
    attachments: [
      { id: 'a'.repeat(24), name: 'daily-speaking.mp3', kind: 'audio', size: 286000 },
      { id: 'b'.repeat(24), name: 'reading-notes.md', kind: 'file', size: 1840 },
      { id: 'c'.repeat(24), name: 'practice-cover.png', kind: 'image', size: 68000 },
      { id: 'd'.repeat(24), name: 'example.py', kind: 'code', size: 256 },
    ] }];
  await send('pet:state', { mode: 'native', kind: 'working', label: '正在工作' });
  await send('composer:workspace', fixture);
  await send('composer:replies', { messages, unread: 1 });
  await click('#tab-tasks');
  assert.equal(await execute('document.querySelector("#panel-tasks").hidden'), false, 'task_tab_failed');
  assert.equal(await execute('document.querySelectorAll("#task-list .task-row").length'), 3, 'schedule_rows_failed');
  assert.equal(await execute('document.querySelector("#attention").hidden'), false, 'busy_concealed_approval');
  await input('#task-search', '英语');
  assert.equal(await execute('document.querySelectorAll("#task-list .task-row").length'), 1, 'task_search_failed');
  await input('#task-search', '');
  await click('#task-list summary');
  await send('composer:workspace', { ...fixture });
  assert.equal(await execute('document.querySelector("#task-list details").open'), true, 'poll_closed_details');
  await click('[data-task-filter="runs"]');
  assert.match(await text('#task-list'), /失败/);
  await click('[data-task-filter="running"]');
  assert.match(await text('#task-list'), /整理阅读清单/);
  await send('composer:workspace', { ...fixture, online: false, fresh: false, activityFresh: false });
  assert.equal(await execute('document.querySelector("#workspace-warning").hidden'), false, 'stale_banner_failed');
  assert.equal(await text('#metric-running'), '—', 'stale_metric_failed');
  await send('composer:workspace', fixture);
  await click('[data-task-filter="schedules"]');
  await click('#tab-library');
  assert.equal(await execute('document.querySelectorAll("#library-list .attachment").length'), 4, 'library_rows_failed');
  await click('[data-library-filter="audio"]');
  assert.equal(await execute('document.querySelectorAll("#library-list .attachment").length'), 1, 'library_filter_failed');
  await input('#library-search', 'absent');
  assert.match(await text('#library-list'), /没有匹配/);
  await input('#library-search', '');
  await click('[data-library-filter="all"]');
  await click('#tab-settings');
  const denied = await execute(`window.composer.officialPage('https://attacker.invalid/')`);
  assert.equal(denied.ok, false, 'external_allowlist_failed');
  await execute(`document.querySelector('#tab-settings').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  assert.equal(await execute('document.body.dataset.view'), 'chat', 'keyboard_tab_navigation_failed');
  await input('#draft', 'Local smoke only; not transmitted');
  await execute(`document.querySelector('#draft').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))`);
  await settle();
  assert.match(await text('#feedback'), /本次没有发送/, 'windows_send_shortcut_failed');
  assert.equal(await execute('document.querySelector("#draft").value'), 'Local smoke only; not transmitted', 'draft_lost');
  for (const [width, height] of [[580, 730], [440, 540]]) {
    window.setBounds({ width, height });
    for (const view of ['chat', 'tasks', 'library', 'settings']) {
      await click(`#tab-${view}`);
      const layout = await execute(`(() => {
        const panel=document.querySelector('#panel-${view}'), b=panel.getBoundingClientRect();
        const visible=[...panel.querySelectorAll('button,input,textarea,select')].filter(e=>e.checkVisibility());
        return {panelVisible:b.width>0&&b.height>0, panelFits:b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth,
          controlsFit:visible.every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}),
          icons:document.querySelectorAll('svg.lucide').length>10};
      })()`);
      assert.ok(Object.values(layout).every(Boolean), `layout_failed_${view}_${width}`);
      const image = await window.webContents.capturePage();
      await fs.writeFile(path.join(output, `${view}-${width}x${height}.png`), image.toPNG());
    }
  }
  // All server-provided content must stay inert, including task details.
  await send('composer:workspace', { ...fixture, schedules: [{ ...fixture.schedules[0], title: '<img src=x onerror=alert(1)>' }] });
  await click('#tab-tasks');
  assert.equal(await execute('!!document.querySelector("#task-list img")'), false, 'unsafe_task_html');
  assert.match(await text('#task-list'), /<img/);
  console.log('WORKSPACE_SMOKE_PASS: navigation, search, filters, fresh/stale, busy + approval, keyboard, drafts, inert content, external allowlist, 8 screenshots');
}
module.exports = { runWorkspaceSmoke };
