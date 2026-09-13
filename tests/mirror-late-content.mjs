import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mirroredIndicatorButton.js', import.meta.url), 'utf8');

function method(signature, optional = false) {
    const start = source.indexOf(`        ${signature}`);
    if (start < 0 && optional) return '';   // absent in the pre-fix code
    assert.ok(start > 0, `could not locate ${signature}`);
    return source.slice(start, source.indexOf('\n        }', start) + 10);
}

const parts = [
    method('_initGenericIndicator(role) {'),
    method('_markEmpty() {'),
    method('_setupSourcePresenceWatchers() {'),
    method('_watchSourceActor(obj, signals) {', true),
    method('_watchSourceChild(sourceChild) {', true),
    method('_syncMirrorPresence() {'),
    method('_isBlankContainer(actor) {', true),
    method('_hasVisibleRenderableSourceContent(actor) {'),
].filter(Boolean).join(',\n');

// Minimal actor stubs. connectObject records handlers so the test can fire them
// the way the shell would when an indicator finally populates.
class Actor {
    constructor(props = {}) {
        Object.assign(this, { visible: true, children: [], handlers: [] }, props);
    }
    get_first_child() { return this.children[0] ?? null; }
    get_children() { return this.children.slice(); }
    connectObject(signal, cb) { this.handlers.push({ signal, cb }); }
    emit(signal) { for (const h of this.handlers) if (h.signal === signal) h.cb(); }
    connect() { return 1; }
}
class StIcon extends Actor { }
class StLabel extends Actor { }
class StBoxLayout extends Actor { }
class ClutterClone extends Actor { }

function makeButton(sourceIndicator) {
    const context = vm.createContext({
        Main: { panel: { statusArea: { widget: sourceIndicator } } },
        St: { Icon: StIcon, Label: StLabel, BoxLayout: StBoxLayout },
        Clutter: { Clone: ClutterClone },
        console,
    });
    const methods = vm.runInContext(`({${parts}})`, context);
    const button = Object.assign(Object.create(methods), {
        _destroyed: false, visible: true, clonesBuilt: 0,
        _createIndicatorClone() { this.clonesBuilt++; },
        destroy() { this._destroyed = true; },
    });
    button._initGenericIndicator('widget');
    return button;
}

// 1. A source that is still empty at construction must recover when it fills in.
{
    const child = new StBoxLayout({ children: [] });
    const src = new Actor({ children: [child] });
    const button = makeButton(src);

    assert.equal(button._isEmpty, true, 'starts empty while the source has no content');
    assert.equal(button.clonesBuilt, 0, 'no clone while there is nothing to clone');
    assert.ok(src.handlers.length > 0, 'the source must be watched even when empty');

    // The indicator populates and the shell notifies.
    child.children.push(new StIcon({ icon_name: 'weather-clear-symbolic' }));
    src.emit('notify::allocation');

    assert.equal(button._isEmpty, false, 'must revive once the source has content');
    assert.equal(button.visible, true, 'must become visible');
    assert.equal(button.clonesBuilt, 1, 'must build the clone exactly once');
}

// 2. A source with no child at all is still watched, and recovers.
{
    const src = new Actor({ children: [] });
    const button = makeButton(src);
    assert.equal(button._isEmpty, true);
    assert.ok(src.handlers.length > 0, 'a childless source must still be watched');

    src.children.push(new StLabel({ text: '21°C' }));
    src.emit('notify::allocation');
    assert.equal(button._isEmpty, false, 'must revive when a child appears');
    assert.equal(button.clonesBuilt, 1);
}

// 3. An invisible source is watched and revives when shown.
{
    const src = new Actor({ visible: false, children: [new StIcon({ icon_name: 'x' })] });
    const button = makeButton(src);
    assert.equal(button._isEmpty, true, 'hidden source starts empty');

    src.visible = true;
    src.emit('notify::visible');
    assert.equal(button._isEmpty, false, 'must revive when the source is shown');
    assert.equal(button.clonesBuilt, 1);
}

// 4. The clone is built once, not on every sync.
{
    const src = new Actor({ children: [new StIcon({ icon_name: 'x' })] });
    const button = makeButton(src);
    assert.equal(button.clonesBuilt, 1);
    for (let i = 0; i < 5; i++) src.emit('notify::allocation');
    assert.equal(button.clonesBuilt, 1, 'the clone must not be rebuilt on every sync');
}

// 5. Content going away hides the mirror again, without destroying it.
{
    const child = new StBoxLayout({ children: [new StIcon({ icon_name: 'x' })] });
    const src = new Actor({ children: [child] });
    const button = makeButton(src);
    assert.equal(button.visible, true);

    child.children = [];
    src.emit('notify::allocation');
    assert.equal(button._isEmpty, true, 'empties out when content goes away');
    assert.equal(button.visible, false);
    assert.equal(button._destroyed, false, 'but the mirror itself survives');
}

console.log('mirror-late-content: all assertions passed');
