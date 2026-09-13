import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mirroredIndicatorButton.js', import.meta.url), 'utf8');

function method(signature) {
    const start = source.indexOf(`        ${signature}`);
    assert.ok(start > 0, `could not locate ${signature}`);
    return source.slice(start, source.indexOf('\n        }', start) + 10);
}

class Actor {
    constructor(props = {}) { Object.assign(this, { visible: true, children: [] }, props); }
    get_children() { return this.children.slice(); }
}
class StIcon extends Actor { }
class StLabel extends Actor { }

const context = vm.createContext({ St: { Icon: StIcon, Label: StLabel }, console });
const sig = vm.runInContext(`({${method('_iconSourceSignature(source) {')}})._iconSourceSignature`, context);
const signatureOf = src => sig.call({}, src);

// A tray icon that has not changed must produce a stable signature, so the
// 5s poll does not destroy and recreate the copies (which reads as flicker).
{
    const icon = new StIcon({ icon_name: '1password', icon_size: 16 });
    const src = new Actor({ children: [new Actor({ children: [icon] })] });
    const first = signatureOf(src);
    for (let i = 0; i < 5; i++)
        assert.equal(signatureOf(src), first, 'an unchanged source must not churn');
}

// A genuine change must still be detected.
{
    const icon = new StIcon({ icon_name: '1password', icon_size: 16 });
    const src = new Actor({ children: [icon] });
    const before = signatureOf(src);

    icon.icon_name = '1password-locked';
    assert.notEqual(signatureOf(src), before, 'a changed icon must trigger a rebuild');
}

// Added and removed icons are detected.
{
    const src = new Actor({ children: [new StIcon({ icon_name: 'a', icon_size: 16 })] });
    const before = signatureOf(src);
    src.children.push(new StIcon({ icon_name: 'b', icon_size: 16 }));
    const added = signatureOf(src);
    assert.notEqual(added, before, 'an added icon must trigger a rebuild');
    src.children.pop();
    assert.equal(signatureOf(src), before, 'removing it must return to the original signature');
}

// Visibility changes count, and label text is tracked.
{
    const icon = new StIcon({ icon_name: 'a', icon_size: 16 });
    const label = new StLabel({ text: '5' });
    const src = new Actor({ children: [icon, label] });
    const before = signatureOf(src);

    icon.visible = false;
    assert.notEqual(signatureOf(src), before, 'a hidden icon must trigger a rebuild');
    icon.visible = true;

    label.text = '6';
    assert.notEqual(signatureOf(src), before, 'changed label text must trigger a rebuild');
}

console.log('icon-sync-stability: all assertions passed');
