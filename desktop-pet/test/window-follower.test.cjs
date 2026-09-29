'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { WindowFollower } = require('../window-follower.cjs');
function fixture() {
  let pet={x:900,y:400,width:256,height:306},chat={x:280,y:200,width:580,height:730},visible=true,minimized=false,destroyed=false,enabled=true;
  const moves=[];
  const anchor={isDestroyed:()=>false,getBounds:()=>({...pet})};
  const follower={isDestroyed:()=>destroyed,isVisible:()=>visible,isMinimized:()=>minimized,
    getBounds:()=>({...chat}),setPosition:(x,y,animate)=>{assert.equal(animate,false);moves.push({x,y});chat={...chat,x,y};}};
  const follow=new WindowFollower({anchor:()=>anchor,follower:()=>follower,enabled:()=>enabled});
  return {follow,moves,pet:()=>pet,chat:()=>chat,
    movePet:(x,y)=>{pet={...pet,x,y};follow.moved();},moveChat:(x,y)=>{chat={...chat,x,y};},
    hide:()=>{visible=false;},show:()=>{visible=true;},minimize:()=>{minimized=true;},destroy:()=>{destroyed=true;},disable:()=>{enabled=false;}};
}
test('pet motion moves visible chat by exactly the same delta without resizing',()=>{
  const f=fixture();f.movePet(940,370);
  assert.deepEqual(f.chat(),{x:320,y:170,width:580,height:730});
  f.movePet(920,380);assert.deepEqual(f.chat(),{x:300,y:180,width:580,height:730});
});
test('manual chat move never changes pet, and its new offset is retained on the next pet drag',()=>{
  const f=fixture(),pet={...f.pet()};f.moveChat(100,50);
  assert.deepEqual(f.pet(),pet);assert.equal(f.moves.length,0);
  f.movePet(950,425);assert.equal(f.chat().x,150);assert.equal(f.chat().y,75);
});
test('programmatic bubble expansion and collapse never shift the chat, even with delayed move events',()=>{
  const f=fixture();f.follow.moveSilently(()=>f.movePet(850,352));f.follow.moved();
  assert.equal(f.moves.length,0);f.movePet(870,372);
  assert.deepEqual(f.moves,[{x:300,y:220}]);
  f.follow.moveSilently(()=>f.movePet(900,400));f.follow.moved();assert.equal(f.moves.length,1);
});
test('hidden, minimized, destroyed or closing chat is not moved and hidden movement does not accumulate',()=>{
  for(const flag of ['hide','minimize','destroy','disable']){const f=fixture();f[flag]();f.movePet(1000,500);assert.equal(f.moves.length,0);}
  const f=fixture();f.hide();f.movePet(1000,500);f.show();f.movePet(1010,505);
  assert.deepEqual(f.moves,[{x:290,y:205}]);
});
test('same-position events do not drift and negative multi-monitor coordinates remain valid',()=>{
  const f=fixture();f.movePet(900,400);assert.equal(f.moves.length,0);
  f.movePet(-100,300);assert.equal(f.chat().x,-720);assert.equal(f.chat().y,100);
});
