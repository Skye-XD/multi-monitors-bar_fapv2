import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Dash to Dock already draws a dock on the primary monitor. The extension's own
// desktop hover dock must stand down there, or the user sees two -- while still
// appearing on a plain GNOME setup, which tests/dock-hover.mjs guards.
const source = readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
const DTD = 'dash-to-dock@micxgx.gmail.com';
const ENABLED = 1, DISABLED = 2;

function makeExt(dtdState) {
    const built = [];
    const context = vm.createContext({
        Main: {
            layoutManager: { monitors: [{ id: 'primary' }], primaryIndex: 0 },
            extensionManager: dtdState === undefined
                ? undefined                       // no manager at all
                : { lookup: uuid => (uuid === DTD ? { state: dtdState } : null) },
        },
        MMDock: { MultiMonitorsDock: class { constructor(m) { built.push(m); } updateMonitor() { } } },
        DASH_TO_DOCK_UUID: DTD,
        EXTENSION_STATE_ENABLED: ENABLED,
        log() { }, console,
    });
    const pick = sig => {
        const i = source.indexOf(`\t${sig}`);
        assert.ok(i > 0, `could not locate ${sig}`);
        return source.slice(i, source.indexOf('\n\t}', i) + 4).replace(/^\t/, '');
    };
    const methods = vm.runInContext(`({${pick('_relayout() {')},${pick('_dashToDockOwnsPrimary() {')}})`, context);
    return Object.assign(Object.create(methods), {
        built, destroyed: 0, _primaryDock: null, _mmMonitors: -1, _primaryIndex: -1,
        _destroyPrimaryDock() { if (this._primaryDock) this.destroyed++; this._primaryDock = null; },
        _hideThumbnailsSlider() { }, _showThumbnailsSlider() { },
    });
}

// Dash to Dock enabled: we must not add a second dock.
{
    const ext = makeExt(ENABLED);
    for (let i = 0; i < 3; i++) ext._relayout();
    assert.equal(ext._primaryDock, null, 'no dock while Dash to Dock owns the primary');
    assert.equal(ext.built.length, 0, 'MultiMonitorsDock must not be constructed');
}

// Dash to Dock installed but disabled: our dock is wanted again.
{
    const ext = makeExt(DISABLED);
    ext._relayout();
    assert.ok(ext._primaryDock, 'a disabled Dash to Dock must not suppress our dock');
}

// Plain GNOME, no extension manager to consult: fall back to creating it.
{
    const ext = makeExt(undefined);
    ext._relayout();
    assert.ok(ext._primaryDock, 'undeterminable state must not suppress the dock');
}

// Dash to Dock enabled later: an existing dock is torn down.
{
    let state = DISABLED;
    const ext = makeExt(DISABLED);
    ext._dashToDockOwnsPrimary = () => state === ENABLED;
    ext._relayout();
    assert.ok(ext._primaryDock);
    state = ENABLED;
    ext._relayout();
    assert.equal(ext._primaryDock, null, 'enabling Dash to Dock must remove our dock');
    assert.equal(ext.destroyed, 1);
}

console.log('primary-dock-optin: all assertions passed');
