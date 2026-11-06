'use strict';
// Offline tests only. No device access or server required: node test_native_manager.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const api = require('./native-manager.js');
const source = fs.readFileSync(__dirname + '/native-manager.js', 'utf8');
const ICCID = '89860012345678901234';
const CODE = 'LPA:1$smdp.example$private-matching-code';
let passed = 0;
async function test(name, work) {
    await work();
    passed++;
    console.log('PASS', name);
}
function fakeDOM() {
    const ids = new Map();
    let doc;
    class Element {
        constructor(tag) {
            this.tagName = tag;
            this.style = { display: '' };
            Object.defineProperty(this.style, 'cssText', {
                set(text) { const match = /(?:^|;)display:([^;]+)/.exec(text); if (match) this.display = match[1]; }
            });
            this.children = [];
            this.listeners = {};
            this.value = '';
            this.className = '';
            this.attributes = {};
        }
        set id(value) { this._id = value; ids.set(value, this); }
        get id() { return this._id; }
        append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        insertAdjacentElement(where, child) { assert.equal(where, 'afterend'); this.sibling = child; }
        setAttribute(key, value) { this.attributes[key] = value; }
        addEventListener(key, fn) { this.listeners[key] = fn; }
        focus() { doc.activeElement = this; }
        querySelectorAll(selector) {
            const tags = selector.split(',');
            const all = [];
            const walk = node => node.children.forEach(child => {
                if (tags.includes(child.tagName)) all.push(child);
                walk(child);
            });
            walk(this);
            return all;
        }
    }
    doc = { body: null, documentElement: new Element('html'), activeElement: null,
        createElement: tag => new Element(tag), getElementById: id => ids.get(id),
        addEventListener(name, callback) { this[name] = callback; } };
    const observers = [];
    const commands = [];
    let bridge = async command => {
        commands.push(command);
        const op = command.split(' ')[1];
        const data = { status: { capabilities: { engineReady: true }, writesVerified: false },
            info: { eidValue: '89049000000000000000000000000001' },
            list: [{ iccid: ICCID, profileState: 'disabled', profileNickname: '<img src=x onerror=alert(1)>' }],
            notifications: [] }[op] || {};
        return { success: true, content: JSON.stringify({ ok: true, data }) };
    };
    const ctx = { document: doc, window: {}, TextEncoder, btoa,
        runShellWithRoot: (...args) => bridge(...args),
        MutationObserver: class {
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe() { this.observing = true; }
            disconnect() { this.observing = false; }
        } };
    function anchor() {
        doc.body = new Element('body');
        const a = new Element('button'); a.id = 'PLUGIN_SETTING'; a.className = 'btn';
        return a;
    }
    return { ctx, doc, ids, observers, commands, anchor,
        setBridge(fn) { bridge = fn; },
        load() { vm.runInNewContext(source, ctx); },
        buttons() { return doc.body.querySelectorAll('button'); },
        button(text) { return this.buttons().find(b => b.textContent === text); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled() { await tick(); await tick(); }

(async () => {
    await test('fixed operation allowlist; UTF-8 base64; shell metacharacters never interpolated', () => {
        const nickname = '中国 😀 $(id); " /';
        const command = api.commandFor('nickname', { iccid: ICCID, nickname });
        assert.match(command, /^\/data\/adb\/f50-esim\/manager\.sh nickname [A-Za-z0-9+/=]+$/);
        assert.deepEqual(JSON.parse(Buffer.from(command.split(' ')[2], 'base64').toString('utf8')), { iccid: ICCID, nickname });
        assert.throws(() => api.commandFor('list;id', {}));
        assert.throws(() => api.commandFor('list', { command: 'whoami' }));
        assert.throws(() => api.commandFor('notification-send', { arbitrary: true }));
    });
    await test('validation rejects malformed ICCIDs, activation codes and controls', () => {
        for (const iccid of ['123', ICCID + ';id', 1234, null]) assert.throws(() => api.validate('delete', { iccid }));
        for (const activationCode of ['', 'https://example.com', 'LPA:1$host$', 'LPA:1$host$abc\nmalicious']) {
            assert.throws(() => api.validate('download', { activationCode }));
        }
        assert.throws(() => api.validate('download', { activationCode: CODE, confirmationCode: 'a\nb' }));
        assert.throws(() => api.validate('nickname', { iccid: ICCID, nickname: 'x'.repeat(65) }));
        assert.equal(api.validate('nickname', { iccid: ICCID, nickname: '  ' }).nickname, '');
        assert.deepEqual(api.validate('download', { activationCode: ' ' + CODE + ' ', confirmationCode: '123456' }),
            { activationCode: CODE, confirmationCode: '123456' });
    });
    await test('delete needs disabled state and exact typed six-digit suffix', () => {
        const p = { iccid: ICCID, profileState: 'disabled' };
        assert(api.canDelete(p, ICCID.slice(-6)));
        assert(!api.canDelete(p, '123'));
        assert(!api.canDelete(p, ' ' + ICCID.slice(-6)));
        assert(!api.canDelete({ ...p, profileState: 'enabled' }, ICCID.slice(-6)));
        assert(!api.canDelete({ ...p, profileState: 'unknown' }, ICCID.slice(-6)));
    });
    await test('strict JSON envelope; errors never echo backend secrets', () => {
        assert.deepEqual(api.parseResponse({ success: true, content: '{"ok":true,"data":[1]}' }), [1]);
        assert.equal(api.parseResponse('{"ok":true,"data":false}'), false);
        for (const raw of ['noise {"ok":true}', '{}', 'null', '{"ok":"true"}',
            { success: false, content: CODE }, '{"ok":false,"error":"' + CODE + '"}']) {
            assert.throws(() => api.parseResponse(raw), error => !error.message.includes(CODE));
        }
    });
    await test('explicit outcomeUnknown/doNotRetry envelope never becomes success or exposes backend text', () => {
        for (const data of [{ outcomeUnknown: true }, { doNotRetry: true }]) {
            assert.throws(() => api.parseResponse(JSON.stringify({ ok: false, error: CODE, data })),
                error => error.message === 'OUTCOME_UNKNOWN' && !error.message.includes(CODE));
        }
    });
    await test('redaction hides nested codes and exact known secrets', () => {
        const result = api.redact({ activationCode: CODE, nested: [{ confirmationCode: '123456',
            message: 'server echoed ' + CODE + ' and 123456' }], text: 'confirmationCode=123456' }, ['123456']);
        const text = JSON.stringify(result);
        assert(!text.includes(CODE));
        assert(!text.includes('123456'));
        assert(!text.includes('private-matching-code'));
    });
    await test('readback checks enable/disable/delete/nickname and new download ICCID', () => {
        const p = { iccid: ICCID, profileState: 'enabled', profileNickname: '新昵称' };
        assert(api.readbackMatches('enable', { iccid: ICCID }, [], [p]));
        assert(!api.readbackMatches('disable', { iccid: ICCID }, [], [p]));
        assert(api.readbackMatches('delete', { iccid: ICCID }, [p], []));
        assert(api.readbackMatches('nickname', { iccid: ICCID, nickname: '新昵称' }, [], [p]));
        assert(api.readbackMatches('download', {}, [], [p]));
        assert(!api.readbackMatches('download', {}, [p], [p]));
    });
    await test('controller blocks overlapping operations and never retries on transport failure', async () => {
        let release, calls = 0;
        const controller = api.createController(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
        const first = controller.run(call => call('status', {}));
        assert(controller.busy);
        await assert.rejects(controller.run(call => call('list', {})), /BUSY/);
        assert.equal(calls, 1);
        release('{"ok":true,"data":{}}');
        await first;
        assert(!controller.busy);
        const broken = api.createController(async () => { calls++; throw new Error('offline'); });
        await assert.rejects(broken.run(call => call('enable', { iccid: ICCID })), /offline/);
        assert.equal(calls, 2);
        assert(!broken.busy);
    });
    await test('async writes enqueue once and poll only hex job ID every two seconds until final', async () => {
        const commands = [], pauses = [], pending = [];
        const replies = [
            { ok: true, data: { pending: true, jobId: 'a123ff00000000000000000000000000' } },
            { ok: true, data: { pending: true, jobId: 'a123ff00000000000000000000000000' } },
            { ok: true, data: { completed: true } }
        ];
        const controller = api.createController(async (command, timeout) => {
            commands.push(command); assert.equal(timeout, 90000);
            return JSON.stringify(replies.shift());
        }, { pause: async ms => { pauses.push(ms); assert(controller.busy); }, onPending: op => pending.push(op) });
        assert.deepEqual(await controller.run(call => call('enable', { iccid: ICCID })), { completed: true });
        assert.deepEqual(commands.map(c => c.split(' ')[1]), ['enable', 'job', 'job']);
        assert.deepEqual(pauses, [2000, 2000]);
        assert.deepEqual(pending, ['enable', 'enable']);
        for (const command of commands.slice(1)) {
            assert.deepEqual(JSON.parse(Buffer.from(command.split(' ')[2], 'base64').toString()), { jobId: 'a123ff00000000000000000000000000' });
        }
        assert(!controller.busy);
        for (const jobId of ['../path', 'abc;id', '', 'g123', 'a'.repeat(31), 'a'.repeat(33), null]) assert.throws(() => api.validate('job', { jobId }));
    });
    await test('poll failure and final backend rejection do not resubmit writes; invalid or changing jobs stop', async () => {
        for (const final of [{ success: false, content: 'offline' }, '{"ok":false,"error":"failed"}',
            '{"ok":true,"data":{"pending":true,"jobId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}']) {
            const commands = [];
            const controller = api.createController(async command => {
                commands.push(command);
                return commands.length === 1 ? '{"ok":true,"data":{"pending":true,"jobId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' : final;
            }, { pause: async () => {} });
            await assert.rejects(controller.run(call => call('delete', { iccid: ICCID })));
            assert.deepEqual(commands.map(c => c.split(' ')[1]), ['delete', 'job']);
            assert(!controller.busy);
        }
        let polls = 0;
        const invalid = api.createController(async () => {
            polls++; return '{"ok":true,"data":{"pending":true,"jobId":"../x"}}';
        }, { pause: async () => {} });
        await assert.rejects(invalid.run(call => call('enable', { iccid: ICCID })));
        assert.equal(polls, 1);
    });
    await test('notification seqNumber validates numeric zero and explicit all via empty input', () => {
        assert.deepEqual(api.validate('notification-send', { seqNumber: '0' }), { seqNumber: '0' });
        assert.deepEqual(api.validate('notification-send', { seqNumber: '123' }), { seqNumber: '123' });
        assert.deepEqual(api.validate('notification-send', { seqNumber: '' }), { seqNumber: 'all' });
        assert.deepEqual(api.validate('notification-send', {}), { seqNumber: 'all' });
        assert.deepEqual(api.validate('notification-send', { seqNumber: 'all' }), { seqNumber: 'all' });
        for (const seqNumber of ['-1', '1;id', '1.5', '4294967296', true]) {
            assert.throws(() => api.validate('notification-send', { seqNumber }));
        }
    });
    await test('mount waits for DOM anchor and installs one native button; no iframe or open-time mutation', async () => {
        const dom = fakeDOM(); dom.load();
        assert.equal(dom.observers.length, 1);
        const anchor = dom.anchor(); dom.observers[0].callback();
        assert.equal(anchor.sibling.textContent, 'eSIM管理');
        assert.equal(dom.observers[0].observing, false);
        dom.load(); assert.equal(dom.observers.length, 1);
        dom.ids.get('f50-native-esim-button').onclick(); await settled();
        assert.deepEqual(dom.commands.map(c => c.split(' ')[1]), ['status', 'info', 'list']);
        assert.equal(dom.doc.body.querySelectorAll('iframe').length, 0);
        assert.equal(dom.doc.body.querySelectorAll('section')[0].children[0].textContent, '<img src=x onerror=alert(1)>');
        assert(!dom.button('下载配置…').disabled);
        assert.equal(dom.doc.body.querySelectorAll('input').filter(i => i.type === 'password').length, 2);
    });
    await test('writes require risk checkbox; deletion requires suffix; disconnect locks writes without retry', async () => {
        const dom = fakeDOM(); dom.anchor(); dom.load();
        dom.ids.get('f50-native-esim-button').onclick(); await settled();
        const initialCalls = dom.commands.length;
        dom.button('删除').onclick();
        assert.equal(dom.commands.length, initialCalls);
        await dom.button('确认删除').onclick();
        assert.equal(dom.commands.length, initialCalls);
        const fields = dom.doc.body.querySelectorAll('input');
        const suffix = fields.find(i => i.maxLength === 6);
        const checkbox = fields.find(i => i.type === 'checkbox');
        checkbox.checked = true; suffix.value = '000000';
        await dom.button('确认删除').onclick(); assert.equal(dom.commands.length, initialCalls);
        suffix.value = ICCID.slice(-6);
        let finish;
        dom.setBridge(async command => { dom.commands.push(command); return new Promise(resolve => { finish = resolve; }); });
        const pending = dom.button('确认删除').onclick();
        await tick();
        assert(dom.button('刷新状态 / EID / 配置').disabled);
        dom.button('关闭').onclick();
        assert.equal(dom.ids.get('f50-native-esim-modal').style.display, 'block');
        finish({ success: false, content: 'disconnected ' + CODE });
        await pending;
        assert.equal(dom.commands.length, initialCalls + 1);
        assert(dom.button('下载配置…').disabled);
        const modal = dom.ids.get('f50-native-esim-modal').children[0];
        assert(modal.children[3].textContent.includes('结果未知'));
        assert(!modal.children[3].textContent.includes(CODE));
    });
    await test('enabled profile cannot be deleted; unsupported QR is local-only fallback; close clears secrets', async () => {
        const dom = fakeDOM(); dom.anchor(); dom.load();
        dom.setBridge(async command => {
            dom.commands.push(command);
            const op = command.split(' ')[1];
            return JSON.stringify({ ok: true, data: op === 'list' ? [{ iccid: ICCID, profileState: 'enabled' }] :
                op === 'status' ? { engineReady: true, writesVerified: false } : { eidValue: 'test' } });
        });
        dom.ids.get('f50-native-esim-button').onclick(); await settled();
        assert(dom.button('删除').disabled);
        dom.button('删除').onclick();
        assert(!dom.button('确认删除'));
        const inputs = dom.doc.body.querySelectorAll('input');
        const file = inputs.find(i => i.type === 'file');
        file.files = [{ size: 20, type: 'image/png' }];
        await file.onchange();
        assert.equal(dom.commands.length, 3);
        inputs.filter(i => i.type === 'password').forEach(i => { i.value = CODE; });
        dom.button('关闭').onclick();
        assert(inputs.filter(i => i.type === 'password').every(i => i.value === ''));
        assert.equal(dom.ids.get('f50-native-esim-modal').style.display, 'none');
    });
    await test('download encrypts codes once after confirmation, clears inputs, and only reads list afterward', async () => {
        const dom = fakeDOM(); dom.anchor(); dom.load();
        let encryptions = 0;
        dom.ctx.window.__f50EncryptPayload = async input => {
            encryptions++;
            assert.equal(input.activationCode, CODE);
            assert.equal(input.confirmationCode, '654321');
            return 'enc.v1.EncryptedCiphertext_123';
        };
        dom.ids.get('f50-native-esim-button').onclick(); await settled();
        const passwords = dom.doc.body.querySelectorAll('input').filter(i => i.type === 'password');
        passwords[0].value = CODE; passwords[1].value = '654321';
        dom.button('下载配置…').onclick();
        assert.equal(dom.commands.length, 3);
        dom.doc.body.querySelectorAll('input').find(i => i.type === 'checkbox').checked = true;
        dom.setBridge(async command => {
            dom.commands.push(command);
            const op = command.split(' ')[1];
            return JSON.stringify({ ok: true, data: op === 'list' ? [
                { iccid: ICCID, profileState: 'disabled' },
                { iccid: '89860012345678909999', profileState: 'disabled' }
            ] : {} });
        });
        await dom.button('确认下载配置').onclick();
        assert.deepEqual(dom.commands.slice(3).map(c => c.split(' ')[1]), ['download', 'list']);
        assert.equal(encryptions, 1);
        assert.equal(dom.commands[3], '/data/adb/f50-esim/manager.sh download enc.v1.EncryptedCiphertext_123');
        assert(!dom.commands.join(' ').includes(CODE));
        assert(!dom.commands.join(' ').includes('654321'));
        assert(!dom.commands.join(' ').includes(Buffer.from(JSON.stringify({ activationCode: CODE, confirmationCode: '654321' })).toString('base64')));
        assert(passwords.every(p => p.value === ''));
        assert(!dom.button('下载配置…').disabled);
        assert.equal(dom.commands.filter(c => c.split(' ')[1] === 'notification-send').length, 0);
    });
    await test('download has no plaintext/base64 fallback and rejects unsafe or failed encryption before bridge call', async () => {
        assert.throws(() => api.commandFor('download', { activationCode: CODE }), /ENCRYPTION_REQUIRED/);
        for (const helper of [undefined, async () => { throw new Error(CODE); }, async () => '',
            async () => 'encrypted;id', async () => 'enc $(id)', async () => 'enc\nvalue']) {
            let calls = 0;
            const controller = api.createController(async () => { calls++; }, { encryptPayload: helper });
            await assert.rejects(controller.run(call => call('download', { activationCode: CODE })),
                error => /^ENCRYPTION_/.test(error.message) && !error.message.includes(CODE));
            assert.equal(calls, 0);
            assert(!controller.busy);
        }
        const dom = fakeDOM(); dom.anchor(); dom.load();
        dom.ids.get('f50-native-esim-button').onclick(); await settled();
        dom.doc.body.querySelectorAll('input').find(i => i.type === 'password').value = CODE;
        dom.button('下载配置…').onclick();
        dom.doc.body.querySelectorAll('input').find(i => i.type === 'checkbox').checked = true;
        await dom.button('确认下载配置').onclick();
        assert.equal(dom.commands.length, 3);
        assert(dom.ids.get('f50-native-esim-modal').children[0].children[3].textContent.includes('缺少安全加密组件'));
    });
    await test('successful write with failed readback is unknown and does not retry or send notifications', async () => {
        const dom = fakeDOM(); dom.anchor(); dom.load();
        dom.ids.get('f50-native-esim-button').onclick(); await settled();
        dom.button('启用').onclick();
        dom.doc.body.querySelectorAll('input').find(i => i.type === 'checkbox').checked = true;
        dom.setBridge(async command => {
            dom.commands.push(command);
            return command.split(' ')[1] === 'enable' ? '{"ok":true,"data":{}}' : { success: false, content: 'offline' };
        });
        await dom.button('确认启用').onclick();
        assert.deepEqual(dom.commands.slice(3).map(c => c.split(' ')[1]), ['enable', 'list']);
        assert(dom.button('下载配置…').disabled);
        assert(dom.ids.get('f50-native-esim-modal').children[0].children[3].textContent.includes('结果未知'));
    });
    await test('notification query is manual; send requires separate risk confirmation', async () => {
        const dom = fakeDOM(); dom.anchor(); dom.load();
        dom.ids.get('f50-native-esim-button').onclick(); await settled();
        await dom.button('查询待处理通知').onclick();
        assert.equal(dom.commands[3].split(' ')[1], 'notifications');
        dom.button('发送待处理通知…').onclick();
        assert.equal(dom.commands.length, 4);
        await dom.button('确认发送待处理通知').onclick();
        assert.equal(dom.commands.length, 4);
        dom.doc.body.querySelectorAll('input').find(i => i.type === 'checkbox').checked = true;
        await dom.button('确认发送待处理通知').onclick();
        assert.deepEqual(dom.commands.slice(4).map(c => c.split(' ')[1]), ['notification-send']);
        assert.deepEqual(JSON.parse(Buffer.from(dom.commands[4].split(' ')[2], 'base64').toString()), { seqNumber: 'all' });
    });
    await test('supported QR decoding stays local and only fills activation field without download', async () => {
        const dom = fakeDOM(); dom.anchor(); dom.load();
        let closed = false;
        dom.ctx.window.createImageBitmap = async () => ({ close() { closed = true; } });
        dom.ctx.window.BarcodeDetector = class {
            constructor(options) { assert.equal(options.formats[0], 'qr_code'); }
            async detect() { return [{ rawValue: CODE }]; }
        };
        dom.ids.get('f50-native-esim-button').onclick(); await settled();
        const inputs = dom.doc.body.querySelectorAll('input');
        const file = inputs.find(i => i.type === 'file');
        file.files = [{ size: 20, type: 'image/png' }];
        await file.onchange();
        assert.equal(inputs.find(i => i.type === 'password').value, CODE);
        assert(closed);
        assert.equal(dom.commands.length, 3);
    });
    await test('source has no persistence, direct HTTP, iframe, raw HTML or console secret logging', () => {
        assert(!/\b(?:localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest)\s*[.(]/.test(source));
        assert(!/console\s*\./.test(source));
        assert(!/\.innerHTML\s*=|createElement\(['"]iframe/.test(source));
    });
    console.log('\n' + passed + ' tests passed (offline mocks; not hardware-verified).');
})().catch(error => { console.error(error); process.exitCode = 1; });
