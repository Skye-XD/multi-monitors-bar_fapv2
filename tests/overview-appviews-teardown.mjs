import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The manager builds its own AppDisplay and app grid, and queues GNOME's
// deferred redisplay work against that AppDisplay. Nulling the fields on
// teardown left the actors alive, so the deferred work later ran over
// unparented icons and stranded their labels on the primary grid.
const source = readFileSync(new URL('../mmoverview.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('class MultiMonitorsControlsManager'));

function pick(name) {
    const i = body.indexOf(`        ${name}(`);
    assert.ok(i > 0, `could not locate ${name}`);
    return body.slice(i, body.indexOf('\n        }', i) + 10);
}

function makeManager() {
    const destroyed = [];
    const actor = tag => ({ tag, destroy() { destroyed.push(tag); } });
    const context = vm.createContext({ console });
    const methods = vm.runInContext(`({${pick('_destroyAppViews')}})`, context);
    return Object.assign(Object.create(methods), {
        destroyed,
        _appDisplay: actor('appDisplay'),
        _appGrid: actor('appGrid'),
        _appDisplayVisible: true,
        _lastAppDisplayLayout: { cols: 8 },
    });
}

// Both app views are destroyed, not merely dereferenced.
{
    const m = makeManager();
    m._destroyAppViews();
    assert.deepEqual(m.destroyed.sort(), ['appDisplay', 'appGrid'],
        'both app views must be destroyed');
    assert.equal(m._appDisplay, null);
    assert.equal(m._appGrid, null);
    assert.equal(m._appDisplayVisible, false);
    assert.equal(m._lastAppDisplayLayout, null);
}

// Idempotent: teardown can arrive from destroy() and from the `destroy` signal.
{
    const m = makeManager();
    m._destroyAppViews();
    m._destroyAppViews();
    assert.equal(m.destroyed.length, 2, 'a second teardown must not re-destroy');
}

// An actor already finalized from the C side must not abort teardown.
{
    const m = makeManager();
    m._appDisplay = { destroy() { throw new Error('already finalized'); } };
    m._destroyAppViews();
    assert.equal(m._appDisplay, null, 'the reference is dropped even if destroy throws');
    assert.ok(m.destroyed.includes('appGrid'), 'the other view is still destroyed');
}

console.log('overview-appviews-teardown: all assertions passed');
