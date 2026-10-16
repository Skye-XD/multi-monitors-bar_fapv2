import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mirroredIndicatorButton.js', import.meta.url), 'utf8');
const MAX_CLONE_BUILD_FAILURES = Number(source.match(/const MAX_CLONE_BUILD_FAILURES = (\d+);/)[1]);

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

// The clone is built from a BEFORE_REDRAW later; flush() runs pending ones.
let laters = new Map();
let nextLaterId = 0;
const flush = () => {
    const pending = [...laters.values()];
    laters = new Map();
    pending.forEach(cb => cb());
};

function makeButton(sourceIndicator) {
    const context = vm.createContext({
        Main: { panel: { statusArea: { widget: sourceIndicator } } },
        St: { Icon: StIcon, Label: StLabel, BoxLayout: StBoxLayout },
        Clutter: { Clone: ClutterClone },
        GObject: { signal_lookup: () => 1 },
        sourceIsVisible: actor => actor?.visible ?? false,
        Meta: { LaterType: { BEFORE_REDRAW: 0 } },
        GLib: { SOURCE_REMOVE: false },
        MAX_CLONE_BUILD_FAILURES,
        global: { compositor: { get_laters: () => ({
            add: (_type, cb) => { laters.set(++nextLaterId, cb); return nextLaterId; },
            remove: id => laters.delete(id),
        }) } },
        console,
    });
    const methods = vm.runInContext(`({${parts}})`, context);
    const button = Object.assign(Object.create(methods), {
        _destroyed: false, visible: true, clonesBuilt: 0, refreshes: 0,
        _panel: { _schedulePanelRefresh() { button.refreshes++; } },
        children: [],
        get_children() { return this.children.slice(); },
        add_child(actor) { this.children.push(actor); },
        _createIndicatorClone() { this.clonesBuilt++; },
        releases: 0,
        _releaseCloneResources() { this.releases++; },
        styleClass: 'panel-button', style: null,
        get_style_class_name() { return this.styleClass; },
        set_style_class_name(name) { this.styleClass = name; },
        get_style() { return this.style; },
        set_style(style) { this.style = style; },
        destroy() { this._destroyed = true; },
    });
    button._initGenericIndicator('widget');
    flush();
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
    flush();

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
    flush();
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
    flush();
    assert.equal(button._isEmpty, false, 'must revive when the source is shown');
    assert.equal(button.clonesBuilt, 1);
}

// 4. The clone is built once, not on every sync.
{
    const src = new Actor({ children: [new StIcon({ icon_name: 'x' })] });
    const button = makeButton(src);
    assert.equal(button.clonesBuilt, 1);
    for (let i = 0; i < 5; i++) src.emit('notify::allocation');
    flush();
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

// 6. A swapped first child after the clone is built asks the panel to
// rebuild the mirror, once; a swap while the build is pending does not.
{
    const src = new Actor({ children: [new StIcon({ icon_name: 'x' })] });
    const button = makeButton(src);
    assert.equal(button.clonesBuilt, 1);

    src.children = [new StIcon({ icon_name: 'y' })];
    src.emit('notify::allocation');
    src.emit('notify::allocation');
    assert.equal(button._sourceChildSwapped, true, 'a swapped child marks the mirror stale');
    assert.equal(button.refreshes, 1, 'and schedules one panel refresh');
}
{
    const src = new Actor({ children: [] });
    const button = makeButton(src);
    src.children.push(new StIcon({ icon_name: 'x' }));
    src.emit('notify::allocation');
    src.children = [new StIcon({ icon_name: 'y' })];
    src.emit('notify::allocation');
    flush();
    assert.equal(button.clonesBuilt, 1);
    assert.equal(button.refreshes, 0, 'a pending build picks up the new child itself');
}

// 7. A build that throws is undone and retried on the next sync.
{
    const src = new Actor({ children: [] });
    const button = makeButton(src);
    let failures = 1;
    const partial = new Actor();
    partial.destroy = () => { partial.destroyed = true; };
    button._createIndicatorClone = function () {
        if (failures-- > 0) {
            this.add_child(partial);
            throw new Error('source not ready');
        }
        this.clonesBuilt++;
    };
    const warn = console.warn;
    console.warn = () => {};
    src.children.push(new StIcon({ icon_name: 'x' }));
    src.emit('notify::allocation');
    flush();
    console.warn = warn;
    assert.equal(button.clonesBuilt, 0, 'the failed build built nothing');
    assert.equal(partial.destroyed, true, 'what the failed build added is dropped');
    assert.equal(button._cloneBuilt, false, 'a failed build stays retryable');
    assert.equal(button.releases, 1, 'bindings and handlers from the failed build are released');

    src.emit('notify::allocation');
    flush();
    assert.equal(button.clonesBuilt, 1, 'the next sync builds it');
}

// 8. A build that keeps throwing gives up after a few tries, logs once
// per outcome, and hides rather than leaving a blank button.
{
    const src = new Actor({ children: [] });
    const button = makeButton(src);
    let attempts = 0;
    button._createIndicatorClone = function () {
        attempts++;
        this.styleClass = 'mm-quick-settings';
        throw new Error('always broken');
    };
    const warn = console.warn;
    let warnings = 0;
    console.warn = () => warnings++;
    src.children.push(new StIcon({ icon_name: 'x' }));
    for (let i = 0; i < 10; i++) {
        src.emit('notify::allocation');
        flush();
    }
    console.warn = warn;
    assert.equal(attempts, MAX_CLONE_BUILD_FAILURES, 'retries stop after the failure limit');
    assert.equal(warnings, 2, 'first failure and giving up are logged, nothing in between');
    assert.equal(button.styleClass, 'panel-button', 'style classes from the failed build are rolled back');
    assert.equal(button.visible, false, 'a mirror that gave up is hidden');
}

// 9. A source hidden through its container (GNOME's convention) is not
// mirrored, and the mirror follows the container being shown again.
{
    const container = new Actor({ visible: false });
    const src = new Actor({ container, children: [new StIcon({ icon_name: 'x' })] });
    const button = makeButton(src);
    assert.equal(button.visible, false, 'hidden container hides the mirror');
    assert.ok(container.handlers.some(h => h.signal === 'notify::visible'), 'the container is watched');

    container.visible = true;
    container.emit('notify::visible');
    flush();
    assert.equal(button.visible, true, 'shown container shows the mirror');
    assert.equal(button.clonesBuilt, 1);

    container.visible = false;
    container.emit('notify::visible');
    assert.equal(button.visible, false, 'hiding the container again hides the mirror');
}

console.log('mirror-late-content: all assertions passed');
