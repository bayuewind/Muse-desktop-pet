(() => {
  'use strict';
  const feed=document.querySelector('#replies'), newer=document.querySelector('#new-replies');
  const rows=new Map(), media=new Map(); let mediaBytes=0, epoch=0;
  function textNode(tag,text,className) { const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el; }
  function messageText(container,text,id) {
    container.replaceChildren(); let at=0,codeIndex=0;
    for(const match of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
      if(match.index>at)container.append(textNode('div',text.slice(at,match.index),'reply-text'));
      const box=document.createElement('div');box.className='code-box';
      const head=document.createElement('div');head.className='code-head';head.append(textNode('span',match[1].trim()||'代码'));
      const copy=textNode('button','复制'),index=codeIndex++;
      copy.onclick=async()=>{const result=await window.composer.copyCode(id,index);copy.textContent=result?.ok?'已复制':'不可复制';};
      head.append(copy);box.append(head,textNode('pre',match[2]));container.append(box);at=match.index+match[0].length;
    }
    if(at<text.length)container.append(textNode('div',text.slice(at),'reply-text'));
  }
  function release(key) {
    const item=media.get(key);if(!item)return;
    item.preview.querySelectorAll('audio').forEach(audio=>{audio.pause();audio.removeAttribute('src');audio.load();});
    URL.revokeObjectURL(item.url);media.delete(key);mediaBytes-=item.size;
    item.preview.replaceChildren();item.load.disabled=false;item.load.textContent=item.label;
  }
  function attachment(row,asset) {
    const card=document.createElement('div');card.className='attachment';
    const head=document.createElement('div');head.className='attachment-head';
    const names={code:'代码',image:'图片',audio:'音频',file:'文件'};
    head.append(textNode('span',names[asset.kind]||'文件','attachment-icon'));
    const name=textNode('div',asset.name,'attachment-name');
    if(Number.isFinite(asset.size))name.append(textNode('small',`${asset.size.toLocaleString()} 字节`));head.append(name);
    const label=asset.kind==='audio'?'加载音频':asset.kind==='image'?'查看图片':'预览代码';
    const load=textNode('button',label),save=textNode('button','保存');
    if(asset.kind!=='file')head.append(load);head.append(save);
    const preview=document.createElement('div');preview.className='attachment-preview';
    const note=textNode('div','','attachment-note');card.append(head,preview,note);
    const key=`${row.id}:${asset.id}`;
    load.onclick=async()=>{
      const requestEpoch=epoch;load.disabled=true;note.textContent='正在读取附件…';
      try {
        const result=await window.composer.attachment(row.id,asset.id);
        if(requestEpoch!==epoch||!card.isConnected){load.disabled=false;note.textContent='';return;}
        if(!result?.ok){note.textContent='暂时无法预览。可尝试保存，或在 Muse 中查看。';load.disabled=false;return;}
        preview.replaceChildren();
        if(result.kind==='code') {preview.append(textNode('pre',result.text));note.textContent='仅显示代码，不会执行。';load.textContent='已预览';return;}
        while(media.size>=6||mediaBytes+result.size>24*1024*1024){const oldest=media.keys().next().value;if(!oldest)break;release(oldest);}
        if(media.has(key))release(key);
        const url=URL.createObjectURL(new Blob([result.bytes],{type:result.mime}));
        media.set(key,{url,size:result.size,preview,load,label});mediaBytes+=result.size;
        if(result.kind==='image'){
          const image=document.createElement('img');image.alt=asset.name;image.src=url;
          image.onerror=()=>{note.textContent='图片解码失败，请保存后查看。';};preview.append(image);note.textContent='';
        } else {
          const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.src=url;
          audio.onerror=()=>{note.textContent='此音频暂不可播放，请保存后查看。';};preview.append(audio);note.textContent='点击播放，不会自动播放。';
        }
        load.textContent='已加载';
      } catch {note.textContent='读取失败，请检查连接。';load.disabled=false;}
    };
    save.onclick=async()=>{
      save.disabled=true;
      try{const result=await window.composer.saveAttachment(row.id,asset.id);note.textContent=result?.ok?'已保存，不会自动打开或执行。':result?.reason==='cancelled'?'':result?.reason==='already_exists'?'文件已存在，请另选名称。':'保存失败，请检查连接。';}
      catch{note.textContent='保存失败。';}finally{save.disabled=false;}
    };
    return card;
  }
  function render(snapshot) {
    if(!snapshot)return;
    const nearBottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<70;
    if(snapshot.messages.length)feed.querySelector('.empty')?.remove();
    const wanted=new Set(snapshot.messages.map(message=>message.id));
    for(const [id,entry]of rows)if(!wanted.has(id)){entry.article.remove();rows.delete(id);for(const key of [...media.keys()])if(key.startsWith(id+':'))release(key);}
    for(const message of snapshot.messages){
      let entry=rows.get(message.id);
      if(!entry){
        const article=document.createElement('article');article.className=`reply ${message.role}`;
        article.append(textNode('div',message.role==='user'?'你':'Muse','reply-label'));
        const content=document.createElement('div'),assets=document.createElement('div'),status=textNode('div','','reply-status');
        article.append(content,assets,status);entry={article,content,assets,status,text:null,assetSignature:null};rows.set(message.id,entry);
      }
      if(entry.text!==message.text){messageText(entry.content,message.text,message.id);entry.text=message.text;}
      const signature=JSON.stringify(message.attachments);
      if(entry.assetSignature!==signature){
        for(const key of [...media.keys()])if(key.startsWith(message.id+':'))release(key);
        entry.assets.replaceChildren(...message.attachments.map(asset=>attachment(message,asset)));entry.assetSignature=signature;
      }
      entry.status.textContent=message.state==='streaming'?'正在接收…':message.state==='interrupted'?'连接中断，回复可能不完整。':message.state==='error'?'回复异常，请在 Muse 中检查。':message.truncated?'内容较长，已截断显示。':'';
      feed.append(entry.article);
    }
    if(nearBottom){feed.scrollTop=feed.scrollHeight;newer.hidden=true;if(document.hasFocus())window.composer.markRead();}
    else newer.hidden=!snapshot.unread;
  }
  newer.onclick=()=>{feed.scrollTop=feed.scrollHeight;newer.hidden=true;window.composer.markRead();};
  feed.addEventListener('scroll',()=>{if(feed.scrollHeight-feed.scrollTop-feed.clientHeight<50&&document.hasFocus()){newer.hidden=true;window.composer.markRead();}});
  document.querySelector('#refresh-replies').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;button.textContent='同步中…';
    try{const result=await window.composer.refreshReplies();button.textContent=result?.ok?'已同步':'同步失败';}
    catch{button.textContent='同步失败';}finally{button.disabled=false;}
  };
  window.composer.onReplies(render);
  window.composer.onHidden(()=>{epoch++;for(const key of [...media.keys()])release(key);});
  window.composer.onFocus(()=>{void window.composer.replies().then(render);});
  void window.composer.replies().then(render);
})();
