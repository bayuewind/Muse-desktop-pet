'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cropBounds, fromPoints } = require('../crop-geometry.js');
const { captureScreen } = require('../capture-screen.cjs');
test('crop geometry supports reverse dragging and clamps keyboard edits to actual pixels', () => {
  assert.deepEqual(fromPoints({ x: 200, y: 120 }, { x: 10, y: 20 }, 640, 360), { x: 10, y: 20, width: 190, height: 100 });
  assert.deepEqual(cropBounds({ x: 630, y: -10, width: 400, height: 500 }, 640, 360), { x: 630, y: 0, width: 10, height: 360 });
  assert.deepEqual(cropBounds({ x: NaN, y: 0, width: '', height: -20 }, 640, 360), { x: 0, y: 0, width: 1, height: 1 });
});
function setup() {
  const events = [], image = { isEmpty: () => false, toPNG: () => Buffer.from('synthetic'), getSize: () => ({ width: 640, height: 360 }) };
  return { events, options: {
    desktopCapturer: { getSources: async options => { events.push('capture'); assert.deepEqual(options.types, ['screen']);
      return [{ display_id: 'one', thumbnail: { ...image, toPNG: () => Buffer.from('wrong') } }, { display_id: 'two', thumbnail: image }]; } },
    screen: { getDisplayMatching: () => ({ id: 'two' }), getAllDisplays: () => [{}, {}] },
    composer: { getBounds: () => ({}), hide: () => events.push('hide-composer') },
    pet: { isDestroyed: () => false, isVisible: () => true, hide: () => events.push('hide-pet') },
    current: () => true, restore: visible => { assert.equal(visible, true); events.push('restore'); },
    wait: async () => { events.push('frame'); },
  } };
}
test('screen capture hides owned windows, selects the matching monitor and restores after completion', async () => {
  const { events, options } = setup(), result = await captureScreen(options);
  assert.equal(result.bytes.toString(), 'synthetic');
  assert.deepEqual(events, ['hide-composer', 'hide-pet', 'frame', 'capture', 'restore']);
});
test('screen capture restores on errors and never substitutes a different monitor', async () => {
  const { events, options } = setup();
  options.screen.getDisplayMatching = () => ({ id: 'missing' });
  await assert.rejects(captureScreen(options), /unavailable/);
  assert.equal(events.at(-1), 'restore');
  options.desktopCapturer.getSources = async () => { throw new Error('permission'); };
  await assert.rejects(captureScreen(options), /permission/);
  assert.equal(events.at(-1), 'restore');
});
test('account changes before capture prevent reading pixels or restoring an old window', async () => {
  const { events, options } = setup(); options.current = () => false;
  await assert.rejects(captureScreen(options), /cancelled/);
  assert.equal(events.includes('capture'), false); assert.equal(events.includes('restore'), false);
});
