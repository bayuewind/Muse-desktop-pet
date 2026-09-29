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
  const sessions = { activeId: null, selection: 0, title: '主会话', ready: true, phase: 'ready', fresh: true,
    rows: [{ id: 'side-a', title: '阅读计划', thread: true, primary: false },
      { id: 'side-b', title: '项目讨论', thread: true, primary: false }] };
  await send('composer:sessions', sessions);
  await input('#draft', 'Main draft retained');
  await send('composer:sessions', { ...sessions, activeId: 'side-a', selection: 1, title: '阅读计划' });
  assert.equal(await execute('document.querySelector("#draft").value'), '', 'side_inherited_main_draft');
  await input('#draft', 'Side draft retained');
  await send('composer:replies', { sessionId: 'side-a', selection: 1, unread: 1, messages: [{ ...messages[0], text: 'Side reply only' }] });
  assert.match(await text('#replies'), /Side reply only/);
  await send('composer:replies', { sessionId: null, selection: 0, unread: 1, messages });
  assert.equal((await text('#replies')).includes('今天的练习'), false, 'late_main_crossed_into_thread');
  await send('composer:sessions', { ...sessions, selection: 2 });
  assert.equal(await execute('document.querySelector("#draft").value'), 'Main draft retained', 'main_draft_not_restored');
  await send('composer:replies', { sessionId: 'side-a', selection: 1, unread: 1, messages: [{ ...messages[0], text: 'Side reply only' }] });
  assert.equal((await text('#replies')).includes('Side reply only'), false, 'late_thread_crossed_into_main');
  await send('composer:sessions', { ...sessions, activeId: 'side-a', selection: 3, title: '阅读计划', ready: false, phase: 'connecting' });
  assert.equal(await execute('document.querySelector("#draft").value'), 'Side draft retained', 'side_draft_not_restored');
  assert.equal(await execute('document.querySelector("#send").disabled'), true, 'unsynced_thread_send_enabled');
  await send('composer:sessions', sessions);
  await input('#draft', '');
  await send('composer:replies', { messages, unread: 1 });
  const spaces = {
    goals: { online: true, fresh: true, updatedAt: now, partial: true, rows: [
      { id: 'g1', title: '建立每周学习节奏', summary: '复习英语与阅读笔记。', description: '保持可持续的学习安排。',
        source: 'user_goal', status: 'active' },
      { id: 'g2', title: '整理项目资料', summary: '归档已完成的内容。', source: 'assistant_tracking', status: 'completed' },
    ] },
    ideas: { online: true, fresh: true, updatedAt: now, partial: false, rows: [
      { id: 'i1', title: '制作每日口语练习', summary: '从阅读笔记生成对话练习。', section: '学习与表达', status: 'new' },
    ] },
  };
  await send('composer:spaces', spaces);
  const audioCheck = await execute(`(async()=>{
    const deadline=async(promise,label)=>{
      let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error(label+JSON.stringify([...document.querySelectorAll('.audio-player audio')].map(a=>({
          paused:a.paused,time:a.currentTime,ready:a.readyState,seeking:a.seeking,network:a.networkState,error:a.error?.code
        }))))),5000);
      })]);}finally{clearTimeout(timer);}
    };
    const bytes=new ArrayBuffer(44+48000), view=new DataView(bytes);
    const word=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
    word(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);word(8,'WAVE');word(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
    word(36,'data');view.setUint32(40,48000,true);
    const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    let failed=false;
    const player=window.museAudio.create(url,'Synthetic silent audio',()=>{failed=true;});
    const otherPlayer=window.museAudio.create(url,'Second silent audio',()=>{failed=true;});
    document.querySelector('#replies').append(player,otherPlayer);
    window.lucide.createIcons();
    const audio=player.querySelector('audio'), other=otherPlayer.querySelector('audio');
    audio.muted=true;other.muted=true;
    try {
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error('audio_metadata_timeout')),5000);
        if(audio.readyState>=1){clearTimeout(timeout);resolve();}
        else audio.addEventListener('loadedmetadata',()=>{clearTimeout(timeout);resolve();},{once:true});
      });
      const noAutoplay=audio.paused, duration=audio.duration;
      const select=player.querySelector('select');select.value='1.5';select.dispatchEvent(new Event('change'));
      await deadline(other.play(),'audio_first_play_timeout');await deadline(audio.play(),'audio_second_play_timeout');
      const exclusive=other.paused;
      audio.pause();audio.currentTime=0.6;
      await player.querySelector('button').onclick();
      const replayed=audio.currentTime<0.3&&!audio.paused;
      return {noAutoplay,duration,speed:audio.playbackRate,exclusive,replayed,failed};
    } catch(error) { return {diagnostic:error.message}; } finally {
      for(const item of [audio,other]){item.pause();item.removeAttribute('src');item.load();}
      player.remove();otherPlayer.remove();URL.revokeObjectURL(url);
    }
  })()`);
  if (audioCheck.diagnostic) console.log('SYNTHETIC_AUDIO_DIAGNOSTIC', audioCheck.diagnostic);
  assert.equal(audioCheck.noAutoplay, true, 'audio_autoplayed');
  assert.equal(audioCheck.duration, 1, 'audio_not_decoded');
  assert.equal(audioCheck.speed, 1.5, 'audio_speed_failed');
  assert.equal(audioCheck.exclusive, true, 'audio_overlap');
  assert.equal(audioCheck.replayed, true, 'audio_replay_failed');
  assert.equal(audioCheck.failed, false, 'audio_playback_failed');
  await click('#tab-spaces');
  assert.equal(await execute('document.querySelectorAll("#spaces-list details").length'), 2, 'goal_rows_failed');
  assert.match(await text('#spaces-scope'), /列表不完整/);
  await input('#spaces-search', '学习');
  assert.equal(await execute('document.querySelectorAll("#spaces-list details").length'), 1, 'goal_search_failed');
  await input('#spaces-search', '');
  await execute(`document.querySelector('#spaces-status').value='completed';document.querySelector('#spaces-status').dispatchEvent(new Event('change'))`);
  assert.equal(await execute('document.querySelectorAll("#spaces-list details").length'), 1, 'goal_status_filter_failed');
  await execute(`document.querySelector('#spaces-status').value='all';document.querySelector('#spaces-status').dispatchEvent(new Event('change'))`);
  await click('#spaces-list summary');
  await send('composer:spaces', spaces);
  assert.equal(await execute('document.querySelector("#spaces-list details").open'), true, 'goal_refresh_closed_details');
  await input('#draft', 'Preserve this draft');
  await click('#spaces-list button');
  assert.equal(await execute('document.body.dataset.view'), 'chat', 'goal_draft_navigation_failed');
  assert.match(await execute('document.querySelector("#draft").value'), /^Preserve this draft\n\n/);
  assert.match(await text('#feedback'), /尚未发送/);
  await click('#tab-spaces');
  await input('#draft', 'a'.repeat(7999));
  await click('#spaces-list button');
  assert.equal(await execute('document.querySelector("#draft").value.length'), 7999, 'overlong_context_mutated_draft');
  assert.match(await text('#workspace-feedback'), /8000/);
  await input('#draft', '');
  await click('[data-space-kind="ideas"]');
  assert.equal(await execute('document.querySelectorAll("#spaces-list details").length'), 1, 'idea_rows_failed');
  await send('composer:spaces', { ...spaces, ideas: { ...spaces.ideas, fresh: false, failed: true } });
  assert.match(await text('#spaces-warning'), /失败/);
  await send('composer:spaces', spaces);
  await click('[data-space-kind="goals"]');
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
  await send('pet:state', { mode: 'native', kind: 'working', requiresApproval: true, label: '正在工作' });
  assert.equal(await execute('document.querySelector("#send").disabled'), true, 'busy_approval_send_enabled');
  await send('pet:state', { mode: 'native', kind: 'working', label: '正在工作' });
  await execute(`document.querySelector('#draft').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))`);
  await settle();
  assert.match(await text('#feedback'), /本次没有发送/, 'windows_send_shortcut_failed');
  assert.equal(await execute('document.querySelector("#draft").value'), 'Local smoke only; not transmitted', 'draft_lost');
  await execute(`window.draftFiles.stageFiles([new File(['Synthetic local file'], 'draft-notes.txt', {type:'text/plain'})])`);
  assert.equal(await execute('document.querySelectorAll("#input-files .input-file").length'), 1, 'stage_file_failed');
  assert.equal((await execute('window.composer.inputList()'))[0].name, 'draft-notes.txt', 'stage_file_memory_failed');
  await click('#capture');
  await execute(`new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('capture_dialog_timeout')),5000);
    function check(){if(document.querySelector('#capture-dialog').open){clearTimeout(timeout);resolve();}else requestAnimationFrame(check);}check();
  })`);
  assert.equal(await execute('document.querySelector("#capture-canvas").width'), 640, 'capture_fixture_failed');
  await execute(`(() => {
    for(const [key,value] of Object.entries({x:10,y:20,width:200,height:100})){
      const input=document.querySelector('#crop-'+key);input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));
    }
  })()`);
  assert.equal(await text('#capture-size'), '200 × 100 px', 'crop_fields_failed');
  await fs.writeFile(path.join(output, 'capture-crop.png'), (await window.webContents.capturePage()).toPNG());
  await click('#capture-add');
  await execute(`new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('capture_stage_timeout')),5000);
    function check(){if(!document.querySelector('#capture-dialog').open){clearTimeout(timeout);resolve();}else requestAnimationFrame(check);}check();
  })`);
  const staged = await execute('window.composer.inputList()');
  assert.equal(staged.length, 2, 'capture_not_staged');
  assert.equal(staged[1].kind, 'image', 'capture_not_image');
  const cropDimensions = await execute(`(async()=>{
    const result=await window.composer.inputPreview(${JSON.stringify(staged[1].id)});
    const blob=new Blob([result.bytes],{type:'image/png'}), bitmap=await createImageBitmap(blob);
    const resultSize={width:bitmap.width,height:bitmap.height};bitmap.close();return resultSize;
  })()`);
  assert.deepEqual(cropDimensions, { width: 200, height: 100 }, 'wrong_cropped_pixels');
  await click('#capture');
  await execute(`new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('capture_dialog_timeout')),5000);
    function check(){if(document.querySelector('#capture-dialog').open){clearTimeout(timeout);resolve();}else requestAnimationFrame(check);}check();
  })`);
  await click('#capture-cancel');
  assert.equal((await execute('window.composer.inputList()')).length, 2, 'cancel_staged_capture');
  for (const [width, height] of [[580, 730], [440, 540]]) {
    window.setBounds({ width, height });
    for (const view of ['chat', 'tasks', 'spaces', 'library', 'settings']) {
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
  await send('composer:spaces', { ...spaces, goals: { ...spaces.goals, rows: [
    { ...spaces.goals.rows[0], title: '<img src=x onerror=alert(1)>', summary: '<script>throw Error("unsafe")</script>' },
  ] } });
  await click('#tab-spaces');
  assert.equal(await execute('!!document.querySelector("#spaces-list img, #spaces-list script")'), false, 'unsafe_goal_html');
  assert.match(await text('#spaces-list'), /<img/);
  console.log('WORKSPACE_SMOKE_PASS: navigation, scoped replies/drafts, search, filters, fresh/stale, goals/ideas, append-only drafts, inert content, keyboard, busy + approval, silent audio decode/speed/replay/exclusivity, external allowlist, local files, synthetic screenshot crop/cancel, 11 screenshots');
}
module.exports = { runWorkspaceSmoke };
