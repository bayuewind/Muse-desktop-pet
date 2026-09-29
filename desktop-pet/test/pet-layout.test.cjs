'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { expand, collapse } = require('../pet-layout.cjs');
test('bubble orbit stays inside display and closing restores original pet position', () => {
  const area={x:0,y:25,width:1440,height:875};
  for (const original of [{x:1100,y:590,width:256,height:306},{x:0,y:25,width:256,height:306}]) {
    const opened=expand(original,area);
    assert.ok(opened.x>=area.x && opened.y>=area.y);
    assert.ok(opened.x+opened.width<=area.x+area.width);
    assert.ok(opened.y+opened.height<=area.y+area.height);
    assert.deepEqual(collapse(opened,original,opened,area),original);
  }
});
test('moving expanded pet is preserved across collapse, including negative monitor coordinates', () => {
  const area={x:-1920,y:0,width:1920,height:1080},original={x:-900,y:450,width:256,height:306};
  const opened=expand(original,area),moved={...opened,x:opened.x-100,y:opened.y-50};
  assert.deepEqual(collapse(moved,original,opened,area),{...original,x:-1000,y:400});
});
