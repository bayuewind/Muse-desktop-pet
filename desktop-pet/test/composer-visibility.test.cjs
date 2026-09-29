'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ComposerVisibility } = require('../composer-visibility.cjs');
function fixture(t) {
  const events=[],window={isDestroyed:()=>false};
  const controller=new ComposerVisibility({ensure:async()=>window,
    show:()=>events.push('show'),hide:()=>events.push('hide'),focus:()=>events.push('focus'),
    closing:()=>events.push('cancel-media'),animate:(_window,value)=>events.push(value)});
  t.after(()=>controller.reset());return {controller,events,window};
}
test('closing cancels media immediately, then hides only after exit-animation completion',async t=>{
  const {controller,events}=fixture(t);await controller.set(true);controller.complete(controller.id);
  await controller.set(false);assert.equal(events.includes('cancel-media'),true);assert.equal(events.includes('hide'),false);
  controller.complete(controller.id);assert.equal(events.at(-1),'hide');assert.equal(controller.open,false);
});
test('rapid reopening ignores stale exit completion and cannot hide the reopened window',async t=>{
  const {controller,events}=fixture(t);await controller.set(true);await controller.set(false);const stale=controller.id;
  await controller.set(true);controller.complete(stale);assert.equal(events.includes('hide'),false);
  controller.complete(controller.id);assert.equal(events.at(-1),'focus');assert.equal(controller.open,true);
});
test('second click during initial load cancels the pending open',async t=>{
  const {controller,events,window}=fixture(t);let resolve;
  controller.ensure=open=>open?new Promise(done=>{resolve=done;}):Promise.resolve(null);
  const loading=controller.set(true);await controller.set(false);resolve(window);await loading;
  assert.equal(controller.open,false);assert.deepEqual(events,['cancel-media']);
});
test('account reset invalidates any animation completion',async t=>{
  const {controller,events}=fixture(t);await controller.set(false);const stale=controller.id;
  controller.reset();controller.complete(stale);assert.equal(events.includes('hide'),false);
});
