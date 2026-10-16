import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EXCLUDED_MIRROR_ROLES, sourceIsVisible } from '../monitorIndicatorPolicy.js';

const source = readFileSync(new URL('../mmpanel.js', import.meta.url), 'utf8');

// Methods live at 8-space indentation inside the registerClass body, so the
// first "\n        }" after the signature closes the method.
function method(name, signature) {
    const start = source.indexOf(`        ${signature}`);
    assert.ok(start > 0, `could not locate ${name}`);
    return source.slice(start, source.indexOf('\n        }', start) + 10);
}

const cloneSrc = method('_cloneAllMainPanelIndicators', '_cloneAllMainPanelIndicators() {');
const updateBoxSrc = method('_updateBox', '_updateBox(elements, box) {');
// The center-box bug lived inside _addToPanelBox, so run the real one.
const addToBoxSrc = method('_addToPanelBox', '_addToPanelBox(role, indicator, position, box) {');
const centerRankSrc = method('_getMainCenterRank', '_getMainCenterRank(role) {');
const centerIndexSrc = method('_getCenterInsertIndex', '_getCenterInsertIndex(role, position) {');
// Prototype helper, declared at top level rather than inside the class body.
const ensureQsStart = source.indexOf('MultiMonitorsPanel.prototype._ensureQuickSettingsRightmost');
assert.ok(ensureQsStart > 0, 'could not locate _ensureQuickSettingsRightmost');
const ensureQsSrc = source.slice(source.indexOf('function ()', ensureQsStart),
    source.indexOf('\n};', ensureQsStart) + 2);   // keep the brace, drop the ';'

// Faithful stand-in for a Clutter box: an out-of-range index appends.
class Box {
    constructor(name) { this.name = name; this.children = []; }
    get_children() { return this.children.slice(); }
    get_n_children() { return this.children.length; }
    remove_child(c) {
        const i = this.children.indexOf(c);
        assert.ok(i >= 0, 'remove_child on a non-child');
        this.children.splice(i, 1);
        c.parent = null;
    }
    remove_all_children() { for (const c of this.children) c.parent = null; this.children = []; }
    add_child(c) { this.children.push(c); c.parent = this; }
    insert_child_at_index(c, i) {
        if (i < 0 || i > this.children.length) i = this.children.length;
        this.children.splice(i, 0, c);
        c.parent = this;
    }
    roles() { return this.children.map(c => c.role); }
}

function makeIndicator(role, visible = true) {
    // MirroredIndicatorButton exposes _adoptSourceStyle(); counting calls proves
    // the panel re-matches padding rather than trusting a one-time copy.
    let adopted = 0;
    // PanelMenu.Button binds its own visibility onto its container, so the
    // container reports the same state the box scan reads.
    const container = {
        role, parent: null, visible,
        show() { }, get_parent() { return this.parent; },
        contains: () => false,
    };
    return {
        role, container, visible, _isEmpty: !visible, menu: null,
        connect: () => 1, disconnect() { },
        contains: () => false,
        _adoptSourceStyle() { adopted++; },
        get adoptCount() { return adopted; },
    };
}

function buildPanel(spec) {
    const boxes = { _leftBox: new Box('left'), _centerBox: new Box('center'), _rightBox: new Box('right') };
    const statusArea = {};
    for (const [boxName, roles] of Object.entries(spec)) {
        for (const [role, visible] of roles) {
            const ind = makeIndicator(role, visible);
            statusArea[role] = ind;
            boxes[boxName].insert_child_at_index(ind.container, boxes[boxName].get_n_children());
        }
    }
    return { ...boxes, statusArea };
}

function makeMirror(mainPanel, settings = {}) {
    const context = vm.createContext({
        Main: { panel: mainPanel, layoutManager: { primaryIndex: 0 } },
        SHOW_ACTIVITIES_ID: 'show-activities',
        SHOW_APP_INDICATORS_ID: 'show-app-indicators',
        SHOW_DATE_TIME_ID: 'show-date-time',
        MirroredIndicatorButton: class { },
        matchSourceHPadding() { },   // theme-node work, not exercised here
        EXCLUDED_MIRROR_ROLES,
        sourceIsVisible,
        Clutter: { ActorAlign: { CENTER: 'center', FILL: 'fill' } },
        console,
    });
    const clone = vm.runInContext(`({${cloneSrc}}).${'_cloneAllMainPanelIndicators'}`, context);
    const updateBox = vm.runInContext(`({${updateBoxSrc}}).${'_updateBox'}`, context);
    const addToPanelBox = vm.runInContext(`({${addToBoxSrc}}).${'_addToPanelBox'}`, context);
    const centerHelpers = vm.runInContext(`({${centerRankSrc},\n${centerIndexSrc}})`, context);

    return {
        monitorIndex: 1,
        _destroyed: false,
        // show-date-time and show-app-indicators default to true in the schema.
        _settings: { get_boolean: key => ({ 'show-date-time': true, 'show-app-indicators': true, ...settings })[key] ?? false },
        statusArea: {},
        _leftBox: new Box('m-left'), _centerBox: new Box('m-center'), _rightBox: new Box('m-right'),
        _centerBin: new Box('m-center-bin'),
        destroyed: [],
        _cloneAllMainPanelIndicators: clone,
        _updateBox: updateBox,
        _hasArcMenuRole: () => false,
        _removeRole(roles, r) { let i; while ((i = roles.indexOf(r)) !== -1) roles.splice(i, 1); },
        _removeStaleIndicators(desired) {
            for (const role in this.statusArea) {
                if (!desired.has(role)) { this._destroyIndicator(role); }
            }
        },
        _destroyIndicator(role) {
            const ind = this.statusArea[role];
            if (!ind) return;
            delete this.statusArea[role];
            if (ind.container.parent) ind.container.parent.remove_child(ind.container);
            this.destroyed.push(role);
        },
        _ensureIndicator(role) {
            if (!this.statusArea[role]) {
                if (!mainPanel.statusArea[role]) return null;
                this.statusArea[role] = makeIndicator(role, mainPanel.statusArea[role].visible);
            }
            return this.statusArea[role];
        },
        _addToPanelBox: addToPanelBox,
        _getMainCenterRank: centerHelpers._getMainCenterRank,
        _getCenterInsertIndex: centerHelpers._getCenterInsertIndex,
        _roleIsEnabled: () => true,
        _showDateTime() { },   // date placement has its own test
        menuManager: { addMenu() { }, removeMenu() { } },
        _ensureQuickSettingsRightmost: vm.runInContext(`(${ensureQsSrc})`, context),
        // Mirrors _updatePanel(): clone pass, then the quickSettings helper.
        sync() {
            this._cloneAllMainPanelIndicators();
            this._ensureQuickSettingsRightmost();
        },
    };
}

// 1. A hidden source indicator is still mirrored, and survives a resync.
{
    const main = buildPanel({ _rightBox: [['weather', true], ['tray', false], ['quickSettings', true]] });
    const mirror = makeMirror(main);
    mirror.sync();
    assert.deepEqual(mirror._rightBox.roles(), ['weather', 'tray', 'quickSettings'],
        'a hidden indicator must still hold its slot on the extended panel');
    mirror.sync();
    assert.deepEqual(mirror.destroyed, [], 'a hidden indicator must not be destroyed on resync');
}

// 2. Order matches the primary panel and stays stable across repeated resyncs.
{
    const main = buildPanel({
        _leftBox: [['appmenu', true]],
        _rightBox: [['weather', true], ['tray', false], ['bluetooth', true], ['quickSettings', true]],
    });
    const mirror = makeMirror(main);
    for (let i = 0; i < 5; i++) {
        mirror.sync();
        assert.deepEqual(mirror._rightBox.roles(), ['weather', 'tray', 'bluetooth', 'quickSettings'],
            `order drifted on resync ${i + 1}`);
    }
}

// 3. An indicator appearing mid-run lands in the right slot, not at the end.
{
    const main = buildPanel({ _rightBox: [['weather', true], ['quickSettings', true]] });
    const mirror = makeMirror(main);
    mirror.sync();
    const inserted = makeIndicator('bluetooth', true);
    main.statusArea['bluetooth'] = inserted;
    main._rightBox.insert_child_at_index(inserted.container, 1);
    mirror.sync();
    assert.deepEqual(mirror._rightBox.roles(), ['weather', 'bluetooth', 'quickSettings'],
        'a newly added indicator must land at its primary-panel position');
}

// 4. A genuinely removed indicator is still cleaned up.
{
    const main = buildPanel({ _rightBox: [['weather', true], ['tray', true]] });
    const mirror = makeMirror(main);
    mirror.sync();
    main._rightBox.remove_child(main.statusArea['tray'].container);
    delete main.statusArea['tray'];
    mirror.sync();
    assert.deepEqual(mirror._rightBox.roles(), ['weather'], 'a removed indicator must be dropped');
    assert.deepEqual(mirror.destroyed, ['tray']);
}

// 5. A disabled Activities button must not be resurrected by the clone path.
{
    const main = buildPanel({
        _leftBox: [['activities', false], ['KiwiMenuButton', true]],
        _rightBox: [['quickSettings', true]],
    });
    const mirror = makeMirror(main, { 'show-activities': false });
    for (let i = 0; i < 3; i++) {
        mirror.sync();
        assert.deepEqual(mirror._leftBox.roles(), ['KiwiMenuButton'],
            `show-activities=false must keep Activities off the extended panel (resync ${i + 1})`);
    }
}

// 6. With the setting on, it is mirrored as usual.
{
    const main = buildPanel({ _leftBox: [['activities', true], ['KiwiMenuButton', true]] });
    const mirror = makeMirror(main, { 'show-activities': true });
    mirror.sync();
    assert.deepEqual(mirror._leftBox.roles(), ['activities', 'KiwiMenuButton'],
        'show-activities=true must mirror Activities');
}

// 7. The center box keeps every center indicator, in order. A BinLayout that
// was cleared per insert used to leave only the last one. (dateMenu is placed
// by its own date-time-position setting, not by this pass.)
{
    const main = buildPanel({ _centerBox: [['Spacer', true], ['WeatherOrNot', true], ['dateMenu', true]] });
    const mirror = makeMirror(main, { 'show-activities': false });
    for (let i = 0; i < 3; i++) {
        mirror.sync();
        assert.deepEqual(mirror._centerBin.roles(), ['Spacer', 'WeatherOrNot'],
            `every center indicator must survive (resync ${i + 1})`);
    }
}

// 8. quickSettings keeps the primary panel's own index. Forcing it rightmost
// pushed it past whatever the primary keeps after it.
{
    const main = buildPanel({
        _rightBox: [['lock-indicator', true], ['quickSettings', true],
                    ['WeatherOrNot', true]],
    });
    const mirror = makeMirror(main, { 'show-activities': false });
    for (let i = 0; i < 3; i++) {
        mirror.sync();
        assert.deepEqual(mirror._rightBox.roles(),
            ['lock-indicator', 'quickSettings', 'WeatherOrNot'],
            `quickSettings must not jump to the end (resync ${i + 1})`);
    }
}

// 9. The keyboard/input-source indicator is mirrored onto extended panels.
{
    const main = buildPanel({
        _rightBox: [['keyboard', true], ['quickSettings', true], ['dateMenu', true]],
    });
    const mirror = makeMirror(main, { 'show-activities': false });
    mirror.sync();
    assert.deepEqual(mirror._rightBox.roles(), ['keyboard', 'quickSettings'],
        'the input-source indicator must appear on extended panels');
}

// 10. Indicators that are genuinely primary-only stay excluded.
{
    const main = buildPanel({
        _rightBox: [['a11y', true], ['power', true], ['quickSettings', true]],
    });
    const mirror = makeMirror(main, { 'show-activities': false });
    mirror.sync();
    assert.deepEqual(mirror._rightBox.roles(), ['quickSettings'],
        'a11y and power must stay off extended panels');
}

// 11. A mirror's padding is re-matched on every refresh. Copying it once at
// build time went stale whenever another extension toggled and moved the
// theme's panel-button padding, leaving the mirrors at the old spacing.
{
    const main = buildPanel({ _rightBox: [['WeatherOrNot', true], ['quickSettings', true]] });
    const mirror = makeMirror(main, { 'show-activities': false });
    for (let i = 1; i <= 3; i++) {
        mirror.sync();
        const counts = Object.values(mirror.statusArea).map(ind => ind.adoptCount);
        assert.ok(counts.every(c => c === i),
            `every mirror must re-adopt its source style on refresh ${i}, got ${counts}`);
    }
}

// A disabled date menu must not be recreated by the clone path either.
{
    const main = buildPanel({ _centerBox: [['Spacer', true], ['dateMenu', true]] });
    const mirror = makeMirror(main, { 'show-date-time': false });
    for (let i = 0; i < 3; i++) {
        mirror.sync();
        assert.deepEqual(mirror._centerBin.roles(), ['Spacer'],
            `show-date-time=false must keep dateMenu off the extended panel (resync ${i + 1})`);
    }
}

console.log('panel-indicator-sync: all assertions passed');
