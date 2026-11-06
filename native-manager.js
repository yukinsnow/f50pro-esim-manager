/* Native UFI-TOOLS eSIM manager. No device writes occur until an explicit confirmation.
 * Embed this file once as a script in the existing authenticated UFI-TOOLS page.
 * The root bridge and device-side manager must be supplied by the host application.
 */
(function () {
    'use strict';

    const COMMAND = '/data/adb/f50-esim/manager.sh';
    const OPS = new Set(['status', 'list', 'info', 'enable', 'disable', 'delete',
        'nickname', 'download', 'notifications', 'notification-send', 'job']);
    const WRITES = new Set(['enable', 'disable', 'delete', 'nickname', 'download', 'notification-send']);
    const LABELS = { enable: '启用', disable: '停用', delete: '删除', nickname: '修改昵称',
        download: '下载配置', 'notification-send': '发送待处理通知' };
    const UNKNOWN = '结果未知：连接中断或回读失败。不要重复提交；设备端可能仍在执行。请恢复连接并手动刷新核对。';

    function validate(op, input) {
        if (!OPS.has(op)) throw new Error('不支持的操作');
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数无效');
        const allowed = op === 'download' ? ['activationCode', 'confirmationCode'] :
            ['enable', 'disable', 'delete'].includes(op) ? ['iccid'] :
                op === 'nickname' ? ['iccid', 'nickname'] :
                    op === 'job' ? ['jobId'] : op === 'notification-send' ? ['seqNumber'] : [];
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('存在未知参数');
        const out = {};
        if (op === 'job') {
            if (typeof input.jobId !== 'string' || !/^[a-fA-F0-9]{32}$/.test(input.jobId)) throw new Error('任务标识无效');
            out.jobId = input.jobId;
        }
        if (op === 'notification-send') {
            const seq = input.seqNumber == null || input.seqNumber === '' ? 'all' : String(input.seqNumber);
            if (seq !== 'all' && (!/^\d{1,10}$/.test(seq) || !Number.isSafeInteger(Number(seq)) || Number(seq) > 4294967295)) {
                throw new Error('通知序号必须是 0–4294967295 的整数或 all');
            }
            out.seqNumber = seq;
        }
        if (allowed.includes('iccid')) {
            if (typeof input.iccid !== 'string' || !/^\d{18,22}$/.test(input.iccid)) {
                throw new Error('ICCID 必须是 18–22 位数字');
            }
            out.iccid = input.iccid;
        }
        if (op === 'nickname') {
            if (typeof input.nickname !== 'string' || /[\u0000-\u001f\u007f]/.test(input.nickname) ||
                Array.from(input.nickname.trim()).length > 64) throw new Error('昵称最多 64 字且不能包含控制字符');
            out.nickname = input.nickname.trim();
        }
        if (op === 'download') {
            const code = typeof input.activationCode === 'string' ? input.activationCode.trim() : '';
            if (code.length > 4096 || !/^LPA:1\$[^\s$]+\$[^\s$]+(?:\$[^\s$]*)*$/.test(code) ||
                /[\u0000-\u001f\u007f]/.test(code)) throw new Error('请输入完整的 LPA:1$… 激活码');
            const confirmation = input.confirmationCode == null ? '' : input.confirmationCode;
            if (typeof confirmation !== 'string' || confirmation.length > 256 ||
                /[\u0000-\u001f\u007f]/.test(confirmation)) throw new Error('确认码无效');
            out.activationCode = code;
            out.confirmationCode = confirmation;
        }
        return out;
    }

    function base64UTF8(value) {
        // TextEncoder + btoa works without deprecated escape/unescape and supports Chinese/emoji.
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }

    function commandFor(op, input) {
        if (op === 'download') throw new Error('ENCRYPTION_REQUIRED');
        return COMMAND + ' ' + op + ' ' + base64UTF8(validate(op, input));
    }

    async function encryptedDownloadCommand(input, encryptPayload) {
        const args = validate('download', input);
        if (typeof encryptPayload !== 'function') throw new Error('ENCRYPTION_REQUIRED');
        let encrypted;
        try { encrypted = await encryptPayload(args); }
        catch (_) { throw new Error('ENCRYPTION_FAILED'); }
        finally { delete args.activationCode; delete args.confirmationCode; }
        // The parent supplies authenticated public-key encryption. Never quote/interpolate arbitrary helper output.
        if (typeof encrypted !== 'string' || encrypted.length > 32768 ||
            !/^[A-Za-z0-9_+/=.:-]+$/.test(encrypted)) throw new Error('ENCRYPTION_FAILED');
        return COMMAND + ' download ' + encrypted;
    }

    function redact(value, secrets) {
        if (Array.isArray(value)) return value.map(item => redact(item, secrets));
        if (value && typeof value === 'object') {
            const out = {};
            for (const key of Object.keys(value)) {
                // Data is displayed as text, never used as object configuration or HTML.
                Object.defineProperty(out, key, { value: /activation|confirmation|matching.?id|token|password|secret/i.test(key) ?
                    '[已隐藏]' : redact(value[key], secrets), enumerable: true });
            }
            return out;
        }
        if (typeof value !== 'string') return value;
        let text = value;
        for (const secret of secrets || []) {
            if (secret) text = text.split(secret).join('[已隐藏]');
        }
        return text.replace(/LPA:1\$[^\s"'<>]*/gi, '[激活码已隐藏]')
            .replace(/((?:activationCode|confirmationCode|确认码|激活码)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]');
    }

    function parseResponse(raw) {
        // Existing authenticated root API returns {success, content}; direct JSON text is also supported.
        if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'success')) {
            if (raw.success !== true) throw new Error('TRANSPORT');
            raw = raw.content;
        }
        if (typeof raw !== 'string') throw new Error('RESPONSE');
        let result;
        try { result = JSON.parse(raw.trim()); } catch (_) { throw new Error('RESPONSE'); }
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error('RESPONSE');
        if (!result.ok) throw new Error(result.data &&
            (result.data.outcomeUnknown === true || result.data.doNotRetry === true) ? 'OUTCOME_UNKNOWN' : 'REJECTED');
        return result.data;
    }

    function canDelete(profile, suffix) {
        return !!profile && profile.profileState === 'disabled' && /^\d{18,22}$/.test(profile.iccid) &&
            typeof suffix === 'string' && suffix === profile.iccid.slice(-6);
    }

    function readbackMatches(op, input, before, after) {
        const found = after.find(profile => profile.iccid === input.iccid);
        if (op === 'enable' || op === 'disable') return !!found &&
            found.profileState === (op === 'enable' ? 'enabled' : 'disabled');
        if (op === 'delete') return !found;
        if (op === 'nickname') return !!found && (found.profileNickname || '') === input.nickname;
        if (op === 'download') return after.some(profile => !before.some(old => old.iccid === profile.iccid));
        return false;
    }

    function createController(bridge, options) {
        const settings = options || {};
        const pause = settings.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const onPending = settings.onPending || (() => {});
        let busy = false;
        return {
            get busy() { return busy; },
            async run(work) {
                if (busy) throw new Error('BUSY');
                busy = true;
                try { return await work(async (op, input) => {
                    const command = op === 'download' ?
                        await encryptedDownloadCommand(input || {}, settings.encryptPayload) : commandFor(op, input || {});
                    // Writes enqueue once. Only read-only job status is polled; never resubmit a mutation.
                    let data = parseResponse(await bridge(command, 90000));
                    if (!WRITES.has(op)) return data;
                    let jobId = null;
                    for (let polls = 0; data && data.pending === true; polls++) {
                        if (polls >= 450) throw new Error('JOB_TIMEOUT');
                        const nextId = data.jobId || jobId;
                        validate('job', { jobId: nextId });
                        if (jobId && nextId !== jobId) throw new Error('RESPONSE');
                        jobId = nextId;
                        onPending(op);
                        await pause(2000);
                        data = parseResponse(await bridge(commandFor('job', { jobId }), 90000));
                    }
                    return data;
                }); } finally { busy = false; }
            }
        };
    }

    const api = { validate, base64UTF8, commandFor, encryptedDownloadCommand, redact, parseResponse, canDelete,
        readbackMatches, createController };
    // A single CommonJS export enables offline tests; browser install stays entirely inside this IIFE.
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (window.__f50NativeEsimManagerInstalled) return;
    window.__f50NativeEsimManagerInstalled = true;

    const controller = createController(async (command, timeout) => {
        if (typeof runShellWithRoot !== 'function') throw new Error('TRANSPORT');
        return runShellWithRoot(command, timeout);
    }, {
        encryptPayload: async input => {
            if (typeof window.__f50EncryptPayload !== 'function') throw new Error('ENCRYPTION_REQUIRED');
            return window.__f50EncryptPayload(input);
        },
        onPending: op => message('正在' + LABELS[op] + '：设备任务处理中，每 2 秒仅查询任务结果，不会重新提交写入…')
    });
    const state = { profiles: [], status: null, info: null, uncertain: false, loaded: false };
    let ui = null;
    let returnFocus = null;
    let qrBusy = false;
    let observer = null;
    const controls = [];

    function element(tag, text, className) {
        const el = document.createElement(tag);
        if (text != null) el.textContent = text;
        if (className) el.className = className;
        return el;
    }
    function button(text, action, write) {
        const b = element('button', text, 'btn');
        b.type = 'button';
        b.onclick = action;
        b._esimWrite = !!write;
        controls.push(b);
        return b;
    }
    function row() {
        const el = element('div');
        el.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;align-items:center';
        return el;
    }
    function input(labelText, type) {
        const label = element('label', labelText);
        label.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin:10px 0';
        const field = element('input', null, 'input');
        field.type = type || 'text';
        field.autocomplete = 'off';
        field.spellcheck = false;
        field.style.cssText = 'width:100%;box-sizing:border-box;padding:8px';
        label.append(field);
        controls.push(field);
        return { label, field };
    }
    function ready() {
        return state.loaded && !!state.status &&
            (state.status.engineReady === true || !!(state.status.capabilities && state.status.capabilities.engineReady === true));
    }
    function sync() {
        if (!ui) return;
        const busy = controller.busy || qrBusy;
        // Drop controls replaced by a fresh list/confirmation instead of retaining detached DOM forever.
        for (let index = controls.length - 1; index >= 0; index--) {
            const control = controls[index];
            if (control.isConnected === false) { controls.splice(index, 1); continue; }
            control.disabled = busy || !!control._esimBlocked ||
                (!!control._esimWrite && (!ready() || state.uncertain));
        }
        ui.close.disabled = false; // Close always gives a warning while a request is active.
        ui.mask.setAttribute('aria-busy', String(busy));
    }
    function message(text) {
        if (ui) ui.message.textContent = text;
    }
    function log(text) {
        // Only application-owned messages are logged. Never append commands, arguments, or raw responses.
        if (!ui) return;
        ui.log.textContent = (new Date().toLocaleTimeString() + ' ' + text + '\n' + ui.log.textContent).slice(0, 6000);
    }
    function clearSecrets() {
        if (!ui) return;
        ui.activation.value = '';
        ui.confirmation.value = '';
        ui.qr.value = '';
    }
    function close() {
        if (controller.busy || qrBusy) {
            message('操作仍在执行。关闭窗口不能取消设备操作；为避免重复提交，请等待结果。');
            return;
        }
        clearSecrets();
        ui.mask.style.display = 'none';
        ui.confirm.replaceChildren();
        if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
    }
    function showInfo() {
        const caps = state.status && (state.status.capabilities || state.status);
        const verified = state.status && (state.status.writesVerified === true || caps.writesVerified === true);
        ui.summary.textContent = '引擎：' + (ready() ? '已就绪' : '未就绪 / 未登录') +
            ' · 写操作硬件验证：' + (verified ? '后端报告已验证' : '尚未验证') +
            '\nEID：' + (state.info && state.info.eidValue || '未知');
        ui.details.textContent = JSON.stringify(redact({ status: state.status, info: state.info }), null, 2);
    }
    function renderProfiles() {
        ui.profiles.replaceChildren();
        if (!state.profiles.length) ui.profiles.append(element('p', state.loaded ? '未发现配置。' : '尚未读取配置。'));
        state.profiles.forEach(profile => {
            const card = element('section');
            card.style.cssText = 'border:1px solid var(--dark-btn-color);border-radius:8px;padding:10px;margin:10px 0;overflow-wrap:anywhere';
            card.append(element('div', profile.profileNickname || profile.profileName || profile.serviceProviderName || '未命名配置', 'title'));
            card.append(element('p', 'ICCID：' + profile.iccid + '\n状态：' +
                (profile.profileState === 'enabled' ? '已启用' : profile.profileState === 'disabled' ? '已停用' : '未知')));
            if (profile.serviceProviderName) card.append(element('p', '运营商：' + profile.serviceProviderName));
            const actions = row();
            const enable = button('启用', () => confirmWrite('enable', profile), true);
            enable._esimBlocked = profile.profileState !== 'disabled';
            const disable = button('停用', () => confirmWrite('disable', profile), true);
            disable._esimBlocked = profile.profileState !== 'enabled';
            const rename = button('修改昵称', () => confirmWrite('nickname', profile), true);
            const del = button('删除', () => confirmWrite('delete', profile), true);
            del._esimBlocked = profile.profileState !== 'disabled';
            del.title = del._esimBlocked ? '已启用或状态未知的配置禁止删除；请先停用并刷新确认' : '必须输入 ICCID 后六位并确认';
            actions.append(enable, disable, rename, del);
            card.append(actions);
            ui.profiles.append(card);
        });
        sync();
    }
    function checkProfiles(data) {
        if (!Array.isArray(data) || data.some(p => !p || typeof p.iccid !== 'string' ||
            !/^\d{18,22}$/.test(p.iccid))) throw new Error('RESPONSE');
        return data;
    }
    async function execute(work, isWrite) {
        if (controller.busy || qrBusy) return;
        const running = controller.run(work);
        sync();
        try { await running; }
        catch (error) {
            // Deliberately do not display raw error text: the bridge/backend may echo codes or shell arguments.
            if (/^ENCRYPTION_(REQUIRED|FAILED)$/.test(error.message)) {
                message('下载已阻止：安全加密组件不可用或加密失败。未向设备发送激活码或确认码；不允许明文或普通 Base64 回退。');
                log('下载在提交前被安全阻止（加密组件不可用）。');
                return;
            }
            if (isWrite) {
                state.uncertain = true;
                message(error.message === 'REJECTED' ?
                    '管理器拒绝或未完成写入。不要重复提交；请手动刷新核对实际状态。' : UNKNOWN);
            } else {
                state.loaded = false;
                message('读取失败：请确认 UFI 登录、Root 权限及管理引擎。不会自动重试。');
            }
            log(isWrite ? '写操作未能确认；已阻止后续写入。' : '读取失败（错误详情未记录，避免泄露激活码）。');
        } finally { sync(); }
    }
    async function refresh() {
        if (controller.busy || qrBusy) return;
        ui.confirm.replaceChildren();
        message('正在读取引擎、EID 和配置；不执行写入或发送通知…');
        await execute(async call => {
            const status = await call('status', {});
            const info = await call('info', {});
            const profiles = checkProfiles(await call('list', {}));
            if (!status || typeof status !== 'object' || !info || typeof info !== 'object') throw new Error('RESPONSE');
            state.status = status;
            state.info = info;
            state.profiles = profiles;
            state.loaded = true;
            state.uncertain = false;
            showInfo();
            renderProfiles();
            message('读取完成。写操作可能中断当前网络；未做任何写入。' +
                (ready() ? '' : ' 引擎未就绪，已禁用写操作。'));
            log('手动/打开时读取完成。');
        }, false);
    }
    function confirmWrite(op, profile) {
        if (controller.busy || qrBusy || !ready() || state.uncertain) return;
        if (op === 'delete' && (!profile || profile.profileState !== 'disabled')) {
            message('禁止删除已启用或状态未知的配置。');
            return;
        }
        ui.confirm.replaceChildren();
        const title = element('div', '确认' + LABELS[op], 'title');
        const warning = element('p', op === 'notification-send' ?
            '这将连接运营商并发送指定序号的通知；序号留空即确认发送全部待处理通知。不会自动发送；确认后仅提交一次。' :
            op === 'download' ? '下载可能消耗一次性激活码并联系运营商服务器，不会自动启用配置。仅提交一次。' :
                '此操作将修改 eSIM，可能中断当前网络。断线不代表操作失败，不会自动重试。');
        ui.confirm.append(title, warning);
        if (profile) ui.confirm.append(element('p', '目标 ICCID：' + profile.iccid));
        let extra = null;
        if (op === 'notification-send') {
            extra = input('通知序号 seqNumber（留空表示明确发送全部待处理通知）');
            extra.field.inputMode = 'numeric';
            extra.field.maxLength = 10;
            ui.confirm.append(extra.label);
        } else if (op === 'delete') {
            extra = input('永久删除不可恢复。请输入 ICCID 后六位：' + profile.iccid.slice(-6));
            extra.field.inputMode = 'numeric';
            extra.field.maxLength = 6;
            ui.confirm.append(extra.label);
        } else if (op === 'nickname') {
            extra = input('新昵称（留空清除）');
            extra.field.maxLength = 128;
            extra.field.value = profile.profileNickname || '';
            ui.confirm.append(extra.label);
        }
        const agree = input('我已了解写操作风险，确认此目标及本次操作', 'checkbox');
        agree.field.style.width = 'auto';
        ui.confirm.append(agree.label);
        const actions = row();
        const submit = button('确认' + LABELS[op], async () => {
            if (!agree.field.checked) { message('请先勾选风险确认。'); return; }
            if (op === 'delete' && !canDelete(profile, extra.field.value)) {
                message('ICCID 后六位不匹配，未执行删除。'); return;
            }
            let args = {};
            if (profile) args.iccid = profile.iccid;
            if (op === 'nickname') args.nickname = extra.field.value;
            if (op === 'notification-send') args.seqNumber = extra.field.value;
            if (op === 'download') {
                if (typeof window.__f50EncryptPayload !== 'function') {
                    message('下载已阻止：缺少安全加密组件，激活码和确认码不会以明文或普通 Base64 提交。');
                    return;
                }
                args = { activationCode: ui.activation.value, confirmationCode: ui.confirmation.value };
            }
            try { args = validate(op, args); }
            catch (error) { message(error.message); return; }
            ui.confirm.replaceChildren();
            clearSecrets();
            await write(op, args);
        }, true);
        actions.append(submit, button('取消', () => { ui.confirm.replaceChildren(); sync(); }));
        ui.confirm.append(actions);
        sync();
        if (typeof ui.confirm.scrollIntoView === 'function') ui.confirm.scrollIntoView({ block: 'nearest' });
        if (extra) extra.field.focus();
        else agree.field.focus();
    }
    async function write(op, args) {
        const before = state.profiles.slice();
        const secrets = [args.activationCode, args.confirmationCode].filter(Boolean);
        message('正在' + LABELS[op] + '；请勿重复提交或断电…');
        await execute(async call => {
            try {
                const result = await call(op, args);
                if (result && (result.outcomeUnknown === true || result.doNotRetry === true)) throw new Error('OUTCOME_UNKNOWN');
                log(LABELS[op] + '：后端已响应；不自动重试、不自动发送通知。');
                if (op === 'notification-send') {
                    message('通知发送请求已由后端返回成功；未自动查询通知。可手动查询待处理通知核对。');
                    return;
                }
                const profiles = checkProfiles(await call('list', {}));
                const matched = readbackMatches(op, args, before, profiles);
                state.profiles = profiles;
                renderProfiles();
                if (matched) {
                    message(LABELS[op] + '：配置列表回读符合预期。此结果不是网络入网或硬件全流程验证。');
                } else {
                    state.uncertain = true;
                    message('后端已响应，但配置列表回读未能确认预期变化。请手动刷新核对，勿重复提交。');
                }
            } finally {
                // Clear transient secret references; no storage, console output, analytics or network upload in this plugin.
                delete args.activationCode;
                delete args.confirmationCode;
                secrets.fill('');
            }
        }, true);
    }
    async function notifications() {
        message('正在手动读取待处理通知（不发送）…');
        await execute(async call => {
            const data = await call('notifications', {});
            ui.notifications.textContent = JSON.stringify(redact(data), null, 2);
            message('通知读取完成。仅手动确认后才会发送。');
            log('手动读取通知完成；未发送。');
        }, false);
    }
    async function scanQR() {
        if (controller.busy || qrBusy || !ui.qr.files || !ui.qr.files[0]) return;
        if (typeof window.BarcodeDetector !== 'function' || typeof window.createImageBitmap !== 'function') {
            message('此浏览器不支持本地二维码识别。请从可信工具复制激活码后直接粘贴；本页不会上传图片。');
            ui.qr.value = '';
            return;
        }
        const file = ui.qr.files[0];
        if (file.size > 12 * 1024 * 1024 || !/^image\//.test(file.type)) {
            message('请选择不超过 12 MB 的二维码图片，或直接粘贴激活码。');
            ui.qr.value = '';
            return;
        }
        qrBusy = true;
        sync();
        let bitmap;
        try {
            bitmap = await window.createImageBitmap(file);
            const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
            const results = await detector.detect(bitmap);
            const codes = results.map(result => result.rawValue).filter(value => {
                try { validate('download', { activationCode: value }); return true; } catch (_) { return false; }
            });
            if (codes.length !== 1) throw new Error('QR');
            ui.activation.value = codes[0].trim();
            message('已在本地读取二维码。请检查激活码并点击下载，仍需单独确认。');
        } catch (_) {
            message('二维码无法识别或格式不支持。请直接粘贴完整激活码；没有上传图片或自动下载。');
        } finally {
            if (bitmap && typeof bitmap.close === 'function') bitmap.close();
            ui.qr.value = '';
            qrBusy = false;
            sync();
        }
    }
    function createUI() {
        const mask = element('div', null, 'mask');
        mask.id = 'f50-native-esim-modal';
        mask.style.cssText = 'display:none;inset:0;z-index:1001';
        const modal = element('div', null, 'modal');
        modal.style.cssText = 'width:92%;max-width:760px;max-height:90vh;display:flex;flex-direction:column;gap:8px';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'f50-native-esim-title');
        const heading = element('div', 'eSIM管理 · 实验功能', 'title');
        heading.id = 'f50-native-esim-title';
        const intro = element('p', '实验功能，缺乏充分验证。仅信息读取通过实机测试；启停、昵称、下载、删除及通知发送未经真实写卡验证，可能断网或丢失配置。使用当前 UFI 登录和 Root 权限，不自动切卡、不自动发送通知。');
        const status = element('div', '尚未读取');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
        const summary = element('p');
        summary.style.whiteSpace = 'pre-wrap';
        const toolbar = row();
        const closeButton = button('关闭', close);
        toolbar.append(button('刷新状态 / EID / 配置', refresh), closeButton);
        const content = element('div', null, 'content');
        content.style.cssText = 'max-height:none;overflow:auto;min-height:80px';
        const profiles = element('div');
        const activation = input('激活码（支持直接粘贴 LPA:1$…）', 'password');
        activation.field.maxLength = 4096;
        activation.field.setAttribute('autocapitalize', 'off');
        const confirmation = input('确认码（运营商要求时填写，支持直接粘贴）', 'password');
        confirmation.field.maxLength = 256;
        const qrInput = input('可选：本地识别二维码图片', 'file');
        qrInput.field.accept = 'image/*';
        qrInput.field.onchange = scanQR;
        const downloadTitle = element('div', '下载配置', 'title');
        const privacy = element('p', '激活码和确认码仅用于本次设备端下载，提交前必须加密，避免管理 API 命令日志记录明文；加密组件不可用时禁止提交。确认后设备会与运营商服务器通信。二维码仅在浏览器本地解析，不上传。');
        const download = button('下载配置…', () => {
            try { validate('download', { activationCode: ui.activation.value, confirmationCode: ui.confirmation.value }); }
            catch (error) { message(error.message); return; }
            confirmWrite('download');
        }, true);
        const noticeTitle = element('div', '运营商通知', 'title');
        const noticeActions = row();
        noticeActions.append(button('查询待处理通知', notifications),
            button('发送待处理通知…', () => confirmWrite('notification-send'), true));
        const noticeData = element('pre', '尚未查询（不会自动查询或发送）');
        noticeData.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
        const confirm = element('section');
        confirm.style.cssText = 'border-top:1px solid var(--dark-btn-color);margin:10px 0;padding-top:10px';
        confirm.setAttribute('aria-live', 'polite');
        const detailsBox = element('details');
        detailsBox.append(element('summary', '引擎与卡信息（敏感码已隐藏）'));
        const details = element('pre');
        details.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
        detailsBox.append(details);
        const logBox = element('details');
        logBox.append(element('summary', '本次会话日志（不含激活码 / 确认码）'));
        const logData = element('pre');
        logData.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
        logBox.append(logData);
        content.append(element('div', '配置列表', 'title'), profiles, downloadTitle, activation.label,
            confirmation.label, qrInput.label, privacy, download, noticeTitle, noticeActions, noticeData, confirm, detailsBox, logBox);
        modal.append(heading, intro, toolbar, status, summary, content);
        mask.append(modal);
        mask.addEventListener('click', event => { if (event.target === mask) close(); });
        mask.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); close(); }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(modal.querySelectorAll('button,input,summary')).filter(el => !el.disabled);
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });
        document.body.append(mask);
        ui = { mask, modal, close: closeButton, message: status, summary, profiles, activation: activation.field,
            confirmation: confirmation.field, qr: qrInput.field, confirm, notifications: noticeData, details, log: logData };
    }
    function open() {
        if (!ui) createUI();
        if (ui.mask.style.display !== 'none') { ui.close.focus(); return; }
        returnFocus = document.activeElement;
        ui.mask.style.display = 'block';
        ui.close.focus();
        // Read-only open is automatic. No writes or notifications are part of this path.
        refresh();
    }
    function mount() {
        if (!document.body) return false;
        const anchor = document.getElementById('PLUGIN_SETTING');
        if (!anchor) return false;
        if (!document.getElementById('f50-native-esim-button')) {
            const launch = element('button', 'eSIM管理', anchor.className || 'btn');
            launch.id = 'f50-native-esim-button';
            launch.type = 'button';
            launch.title = '原生 eSIM 配置管理；写操作需要逐次确认';
            launch.onclick = open;
            anchor.insertAdjacentElement('afterend', launch);
        }
        return true;
    }
    // Plugins can execute in <head>, before body/settings exist. Observe until the real anchor appears.
    if (!mount() && typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(() => { if (mount()) { observer.disconnect(); observer = null; } });
        if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
