'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');
const dgram = require('dgram');

const PORTAL_URL = 'https://cmi.ta.co.at/portal';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQUEST_TIMEOUT = 15000;
const MIN_POLL_INTERVAL = 60000;
const LOGIN_RETRY_BASE = 30000;
const LOGIN_RETRY_MAX = 300000;

// Setpoints on schematic page 4.cgi, identified by their CMI change address
const CONTROLS = [
    { id: 'traum_soll', name: 'Raum soll', changeAddr: '0200184414D101' },
    { id: 'traum_absenk_soll', name: 'Raum reduziert', changeAddr: '02001D4414D101' },
];

// Logging profiles: always cover at least this much more than the refresh interval
const LOG_OVERLAP = 5 * 60000;

// CoE V2 (CAN over Ethernet): UDP packets to the CMI in the local network
const COE_PORT = 5442;
const COE_MAX_PAYLOADS = 31;
const COE_DIGITAL_UNIT = 43; // Ein/Aus
// Unit ids of analog values; the value is sent as integer with this many implied decimal places
const COE_UNITS = {
    0: { unit: '', decimals: 0 },
    58: { unit: '', decimals: 1 },
    1: { unit: '°C', decimals: 1 },
    7: { unit: 'K', decimals: 1 },
    8: { unit: '%', decimals: 1 },
    2: { unit: 'W/m²', decimals: 0 },
    3: { unit: 'l/h', decimals: 0 },
    22: { unit: 'l/min', decimals: 0 },
    38: { unit: 'm³/h', decimals: 0 },
    19: { unit: 'l', decimals: 0 },
    69: { unit: 'W', decimals: 0 },
    10: { unit: 'kW', decimals: 2 },
    11: { unit: 'kWh', decimals: 1 },
    12: { unit: 'MWh', decimals: 0 },
    13: { unit: 'V', decimals: 2 },
    14: { unit: 'mA', decimals: 1 },
    63: { unit: 'A', decimals: 1 },
    23: { unit: 'bar', decimals: 2 },
    21: { unit: 'Hz', decimals: 2 },
    4: { unit: 's', decimals: 0 },
    5: { unit: 'min', decimals: 0 },
    15: { unit: 'h', decimals: 0 },
    16: { unit: 'd', decimals: 0 },
    17: { unit: 'Imp', decimals: 0 },
};

// Expired sessions show up as redirect to the login page or as 401/403
const SESSION_ERROR_STATUS = [301, 302, 303, 401, 403];

class RbeHeatingControl extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'rbe-heatingcontrol' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.sessionId = null;
        this.timer = null; // single timer for login and polling, so there is never more than one loop
        this.loginAttempts = 0;
        this.knownObjects = new Set();
        this.profileTimers = new Map(); // profile folder -> timeout
        this.lastLogTs = new Map(); // state id -> timestamp of last written log value
        this.canValues = new Map(); // CAN input state id -> last sent value
    }

    async onReady() {
        const pollSetback = this.config.pollSetback !== false;
        this.profiles = this.validProfiles(this.config.loggingProfiles || []);
        this.canInputs = this.validCanInputs(this.config.canInputs || []);

        await this.cleanupObjects(pollSetback);
        // CoE only needs the local network, so it also works without portal login
        await this.setupCan();

        const { cmiName, email, password } = this.config;
        if (!cmiName || !email || !password) {
            this.log.error('CMI name, email and password are required in adapter configuration');
            return;
        }

        this.baseUrl = `https://${cmiName}.cmi.ta.co.at/webi`;
        this.pollInterval = Math.max(MIN_POLL_INTERVAL, Number(this.config.pollInterval) || 0);

        // Schematic pages of the CMI web interface:
        // 'controls' = setpoints, 'setback' = night setback indicator, 'sensors' = label/value pairs
        this.pages = [
            { file: 4, type: 'controls' },
            ...(pollSetback ? [{ file: 1, type: 'setback' }] : []),
            { file: 12, type: 'sensors' },
            { file: 13, type: 'sensors' },
        ];

        await this.setStateAsync('info.connection', false, true);
        this.subscribeStates('controls.*');
        await this.login();
    }

    validProfiles(profiles) {
        const result = [];
        for (const profile of profiles) {
            const name = (profile.name || '').trim();
            const creator = (profile.creator || '').trim();
            const folder = name.replace(this.FORBIDDEN_CHARS, '_').replace(/[.\s]/g, '_');
            if (!name || !creator) {
                this.log.warn('Logging profile without name or creator ignored');
            } else if (result.some(p => p.folder === folder)) {
                this.log.warn(`Logging profile "${name}" configured twice, ignoring the second one`);
            } else {
                const interval = Math.max(1, Number(profile.interval) || 1) * 60000;
                result.push({ name, creator, folder, interval });
            }
        }
        return result;
    }

    validCanInputs(inputs) {
        const result = [];
        for (const input of inputs) {
            const name = (input.name || '').trim();
            const node = Number(input.node);
            const output = Number(input.output);
            const digital = input.type === 'digital';
            const unit = Number(input.unit) || 0;
            const id = `can.${name.replace(this.FORBIDDEN_CHARS, '_').replace(/[.\s]/g, '_')}`;
            if (!name) {
                this.log.warn('CAN input without name ignored');
            } else if (!Number.isInteger(node) || node < 1 || node > 62 || !Number.isInteger(output) || output < 1 || output > 64) {
                this.log.warn(`CAN input "${name}" ignored: node must be 1-62, output 1-64`);
            } else if (!digital && !COE_UNITS[unit]) {
                this.log.warn(`CAN input "${name}" ignored: unknown unit ${unit}`);
            } else if (result.some(i => i.id === id)) {
                this.log.warn(`CAN input "${name}" configured twice, ignoring the second one`);
            } else {
                result.push({ name, id, node, output, digital, unit });
            }
        }
        return result;
    }

    // Remove controls of older versions (controls.posX, controls.posX_changeAddr), the disabled setback state,
    // folders of deleted logging profiles and deleted CAN inputs
    async cleanupObjects(pollSetback) {
        const keep = new Set(CONTROLS.map(control => `${this.namespace}.controls.${control.id}`));
        const obsolete = id => id.startsWith(`${this.namespace}.controls.`) && !keep.has(id);

        const objects = await this.getAdapterObjectsAsync();
        for (const id of Object.keys(objects).filter(obsolete)) {
            this.log.info(`Deleting obsolete object ${id}`);
            await this.delForeignObjectAsync(id);
        }
        // _changeAddr values were written as states without object
        const states = await this.getStatesAsync('controls.*');
        for (const id of Object.keys(states).filter(obsolete)) {
            await this.delForeignStateAsync(id);
        }

        if (!pollSetback && objects[`${this.namespace}.sensors.nachtabsenkung`]) {
            await this.delObjectAsync('sensors.nachtabsenkung');
        }

        const profileFolders = new Set(this.profiles.map(profile => profile.folder));
        const deletedProfiles = new Set(Object.keys(objects)
            .map(id => id.slice(this.namespace.length + 1).split('.'))
            .filter(parts => parts[0] === 'logging' && parts.length > 1 && !profileFolders.has(parts[1]))
            .map(parts => parts[1]));
        for (const folder of deletedProfiles) {
            this.log.info(`Deleting states of removed logging profile ${folder}`);
            await this.delObjectAsync(`logging.${folder}`, { recursive: true });
        }

        const canIds = new Set(this.canInputs.map(input => `${this.namespace}.${input.id}`));
        for (const id of Object.keys(objects).filter(id => id.startsWith(`${this.namespace}.can.`) && !canIds.has(id))) {
            this.log.info(`Deleting removed CAN input ${id}`);
            await this.delForeignObjectAsync(id);
        }
    }

    async setupCan() {
        if (!this.canInputs.length) {
            return;
        }
        if (!this.config.cmiIp) {
            this.log.error('CAN inputs are configured, but the local IP of the CMI is missing');
            return;
        }

        this.coeSocket = dgram.createSocket('udp4');
        this.coeSocket.on('error', err => this.log.error(`CoE socket error: ${err.message}`));

        await this.setObjectNotExistsAsync('can', { type: 'folder', common: { name: 'CAN-Eingänge (CoE)' }, native: {} });
        for (const input of this.canInputs) {
            const common = input.digital
                ? { name: input.name, type: 'boolean', role: 'switch', read: true, write: true }
                : { name: input.name, type: 'number', role: 'level', unit: COE_UNITS[input.unit].unit, read: true, write: true };
            await this.ensureObject(input.id, common);

            const state = await this.getStateAsync(input.id);
            if (state && state.val !== null && state.val !== undefined) {
                this.canValues.set(input.id, state.val);
            }
        }
        this.subscribeStates('can.*');

        // The CMI treats CAN inputs as failed after their timeout, so the last values are sent
        // again after a restart and then regularly
        await this.resendCan();
        const resendInterval = Number(this.config.coeResendInterval);
        if (resendInterval > 0) {
            this.coeTimer = setInterval(() => this.resendCan(), resendInterval * 60000);
        }
    }

    async resendCan() {
        const entries = this.canInputs
            .filter(input => this.canValues.has(input.id))
            .map(input => [input, this.canValues.get(input.id)]);
        try {
            await this.sendCan(entries);
        } catch (err) {
            this.log.error(`Error sending CAN values: ${err.message}`);
        }
    }

    async sendCan(entries) {
        const payloads = entries.map(([input, value]) => coePayload(input, value));
        for (let i = 0; i < payloads.length; i += COE_MAX_PAYLOADS) {
            const packet = coePacket(payloads.slice(i, i + COE_MAX_PAYLOADS));
            await new Promise((resolve, reject) => {
                this.coeSocket.send(packet, COE_PORT, this.config.cmiIp, err => (err ? reject(err) : resolve()));
            });
        }
    }

    async onCanChange(id, val) {
        const input = this.canInputs.find(i => i.id === id);
        if (!input || !this.coeSocket) {
            return;
        }

        let value = input.digital ? val === true || val === 1 || val === 'true' : Number(val);
        if (!input.digital) {
            if (!Number.isFinite(value)) {
                this.log.warn(`Invalid value for ${id}: ${val}`);
                return;
            }
            // Only as many decimal places as the unit can transport, so the state shows what the CMI gets
            const factor = 10 ** COE_UNITS[input.unit].decimals;
            value = Math.round(value * factor) / factor;
        }

        try {
            await this.sendCan([[input, value]]);
            this.canValues.set(id, value);
            this.log.debug(`Sent ${id} = ${value} via CoE`);
            await this.setStateAsync(id, value, true);
        } catch (err) {
            this.log.error(`Error sending ${id} = ${value} via CoE: ${err.message}`);
        }
    }

    schedule(fn, delay) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            fn();
        }, delay);
    }

    async login() {
        try {
            this.log.info('Logging in to CMI portal...');

            const form = new URLSearchParams({
                username: this.config.email,
                passwort: this.config.password,
                remember: 'on',
            });
            const response = await axios.post(`${PORTAL_URL}/checkLogin.inc.php?mode=ta`, form.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': USER_AGENT,
                    Origin: 'https://cmi.ta.co.at',
                    Referer: `${PORTAL_URL}/ta/loginformular/`,
                },
                maxRedirects: 0,
                timeout: REQUEST_TIMEOUT,
                validateStatus: status => status >= 200 && status < 400,
            });

            const sessionId = (response.headers['set-cookie'] || [])
                .map(cookie => /PHPSESSID=([^;]+)/.exec(cookie))
                .find(Boolean)?.[1];
            if (!sessionId) {
                throw new Error('No session cookie received - check email and password');
            }
            this.sessionId = sessionId;

            // Follow the redirect like a browser to complete the login
            if (response.headers.location) {
                const target = new URL(response.headers.location, `${PORTAL_URL}/`).href;
                await axios.get(target, { headers: this.headers(), timeout: REQUEST_TIMEOUT })
                    .catch(err => this.log.warn(`Error following login redirect: ${err.message}`));
            }

            this.loginAttempts = 0;
            this.log.info('Logged in to CMI portal');
            await this.setStateAsync('info.connection', true, true);
            this.startLogging();
            await this.poll();
        } catch (err) {
            const delay = Math.min(LOGIN_RETRY_MAX, LOGIN_RETRY_BASE * 2 ** this.loginAttempts++);
            this.log.error(`Login failed: ${err.message} - retrying in ${delay / 1000} s`);
            await this.setStateAsync('info.connection', false, true);
            this.schedule(() => this.login(), delay);
        }
    }

    async relogin() {
        if (!this.sessionId) {
            return; // login already in progress
        }
        this.log.warn('Session expired, logging in again');
        this.sessionId = null;
        await this.setStateAsync('info.connection', false, true);
        this.schedule(() => this.login(), 2000);
    }

    async poll() {
        for (const page of this.pages) {
            try {
                const html = await this.fetchWebi(`schematic_files/${page.file}.cgi`);
                if (page.type === 'controls') {
                    await this.updateControls(html);
                } else if (page.type === 'setback') {
                    await this.updateSetback(html);
                } else {
                    await this.updateSensors(html);
                }
            } catch (err) {
                if (isSessionError(err)) {
                    return this.relogin();
                }
                this.log.error(`Error polling ${page.file}.cgi: ${err.message}`);
            }
        }
        this.schedule(() => this.poll(), this.pollInterval);
    }

    startLogging() {
        for (const profile of this.profiles) {
            if (!this.profileTimers.has(profile.folder)) {
                this.pollProfile(profile);
            }
        }
    }

    async pollProfile(profile) {
        if (this.sessionId) {
            try {
                await this.updateProfile(profile, await this.fetchLogData(profile));
            } catch (err) {
                if (isSessionError(err)) {
                    await this.relogin();
                } else {
                    this.log.error(`Error polling logging profile ${profile.name}: ${err.message}`);
                }
            }
        }
        this.profileTimers.set(profile.folder, setTimeout(() => this.pollProfile(profile), profile.interval));
    }

    async fetchLogData(profile) {
        // Cover the refresh interval plus some overlap, but at least the overlap. "to" is the end of the
        // current day so that clock differences to the CMI can't cut off the newest values.
        const now = new Date();
        const from = new Date(now.getTime() - Math.max(LOG_OVERLAP, profile.interval + LOG_OVERLAP));
        const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        const response = await axios.get(`${PORTAL_URL}/visual/getlogdata.php`, {
            params: {
                cmi: this.config.cmiName.toUpperCase(),
                profil: profile.name,
                from: formatDateTime(from),
                to: formatDateTime(to),
                mode: 'analog',
                creator: profile.creator,
                _: now.getTime(),
            },
            headers: this.headers({ 'X-Requested-With': 'XMLHttpRequest' }),
            maxRedirects: 0,
            timeout: REQUEST_TIMEOUT,
        });
        if (response.data?.status !== 'success' || !response.data.data) {
            throw new Error(`Unexpected response: ${JSON.stringify(response.data).slice(0, 200)}`);
        }
        return response.data.data;
    }

    async updateProfile(profile, data) {
        const { description = {}, units = {}, val: rows = [] } = data;
        if (!rows.length) {
            this.log.debug(`Logging profile ${profile.name}: no values in time range`);
            return;
        }

        await this.setObjectNotExistsAsync('logging', { type: 'folder', common: { name: 'Logging' }, native: {} });
        await this.setObjectNotExistsAsync(`logging.${profile.folder}`, { type: 'channel', common: { name: profile.name }, native: {} });

        const latest = rows.reduce((a, b) => (a.zeit > b.zeit ? a : b));
        const ts = new Date(latest.zeit.replace(' ', 'T')).getTime();
        const usedIds = new Set();

        for (const [key, label] of Object.entries(description)) {
            const value = latest[key];
            if (typeof value !== 'number') {
                continue;
            }
            // "1: T.Außen" -> "t_aussen", fall back to the short code (a1) if the name is not unique
            let id = toStateId(label.replace(/^\d+:\s*/, '').replace(/\./g, ' '));
            if (!id || usedIds.has(id)) {
                id = key;
            }
            usedIds.add(id);

            const stateId = `logging.${profile.folder}.${id}`;
            if (this.lastLogTs.get(stateId) >= ts) {
                continue;
            }
            this.lastLogTs.set(stateId, ts);

            const unit = units[key]?.unity || '';
            const common = { name: label, type: 'number', role: roleForUnit(unit), unit, read: true, write: false };
            await this.writeState(stateId, common, value, ts);
        }
    }

    headers(extra = {}) {
        return { 'User-Agent': USER_AGENT, Cookie: `PHPSESSID=${this.sessionId}`, ...extra };
    }

    async fetchWebi(path, params = {}) {
        const response = await axios.get(`${this.baseUrl}/${path}`, {
            params: { ...params, _: Date.now() },
            headers: this.headers({
                'X-Requested-With': 'XMLHttpRequest',
                Referer: `${this.baseUrl}/schema.html`,
            }),
            maxRedirects: 0,
            timeout: REQUEST_TIMEOUT,
        });
        return response.data;
    }

    async updateControls(html) {
        const $ = cheerio.load(html);

        for (const control of CONTROLS) {
            // Each setpoint appears several times (minus/plus buttons), all with the same value
            const el = $(`div.pm_element[pme_changeadr="${control.changeAddr}"]`).first();
            const value = parseFloat(el.attr('pme_value'));
            if (isNaN(value)) {
                this.log.debug(`Setpoint ${control.id} not found`);
                continue;
            }

            const common = {
                name: control.name,
                type: 'number',
                role: 'level.temperature',
                unit: '°C',
                read: true,
                write: true,
            };
            const min = parseFloat(el.attr('pme_min'));
            const max = parseFloat(el.attr('pme_max'));
            if (!isNaN(min)) common.min = min;
            if (!isNaN(max)) common.max = max;

            await this.writeState(`controls.${control.id}`, common, value);
        }
    }

    async updateSetback(html) {
        // pos17 has class visible0 in setback mode, visible1 in day mode
        // (the img "hide" classes are not updated by the CMI, only the div class is)
        const $ = cheerio.load(html);
        const setback = $('#pos17');
        if (setback.hasClass('visible0') || setback.hasClass('visible1')) {
            const common = { name: 'Nachtabsenkung', type: 'boolean', role: 'indicator', read: true, write: false };
            await this.writeState('sensors.nachtabsenkung', common, setback.hasClass('visible0'));
        }
    }

    async updateSensors(html) {
        const $ = cheerio.load(html);
        // Label and value alternate; elements with onclick are navigation links
        const texts = $('div[id^="pos"]').toArray()
            .filter(el => !$(el).attr('onclick'))
            .map(el => $(el).text().trim());

        for (let i = 0; i + 1 < texts.length; i += 2) {
            let [label, text] = [texts[i], texts[i + 1]];
            // Some pages list the value before the label
            if (looksLikeValue(label) && !looksLikeValue(text)) {
                [label, text] = [text, label];
            }
            const id = toStateId(label);
            if (!id || !text || text.length > 50) {
                continue;
            }

            const { val, ...common } = parseValue(text);
            await this.writeState(`sensors.${id}`, { name: label, ...common, read: true, write: false }, val);
        }
    }

    async writeState(id, common, val, ts) {
        await this.ensureObject(id, common);
        await this.setStateAsync(id, ts ? { val, ack: true, ts } : { val, ack: true });
    }

    async ensureObject(id, common) {
        // Create each object once per run; fix type/role/unit of objects created by older versions
        if (!this.knownObjects.has(id)) {
            const obj = await this.getObjectAsync(id);
            if (!obj) {
                await this.setObjectAsync(id, { type: 'state', common, native: {} });
            } else if (['type', 'role', 'unit'].some(key => (obj.common[key] || '') !== (common[key] || ''))) {
                await this.extendObjectAsync(id, { common: { type: common.type, role: common.role, unit: common.unit || '' } });
            }
            this.knownObjects.add(id);
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack || state.val === null || state.val === undefined) {
            return;
        }

        const relativeId = id.slice(this.namespace.length + 1);
        if (relativeId.startsWith('can.')) {
            return this.onCanChange(relativeId, state.val);
        }

        const controlId = id.split('.').pop();
        const changeAddr = CONTROLS.find(control => control.id === controlId)?.changeAddr;
        if (!changeAddr) {
            return;
        }

        try {
            await this.fetchWebi('INCLUDE/change.cgi', { changeadrx2: changeAddr, changetox2: state.val });
            this.log.info(`Set ${controlId} to ${state.val}`);
            await this.setStateAsync(id, state.val, true);
        } catch (err) {
            this.log.error(`Error setting ${controlId} to ${state.val}: ${err.message}`);
            if (isSessionError(err)) {
                await this.relogin();
            }
        }
    }

    onUnload(callback) {
        clearTimeout(this.timer);
        this.profileTimers.forEach(timer => clearTimeout(timer));
        clearInterval(this.coeTimer);
        this.coeSocket?.close();
        callback();
    }
}

// CoE V2 payload: node, output index (0-based), format (0 = digital, 1 = analog), unit id, value as int32 LE
function coePayload(input, value) {
    const payload = Buffer.alloc(8);
    payload[0] = input.node;
    payload[1] = input.output - 1;
    if (input.digital) {
        payload[2] = 0;
        payload[3] = COE_DIGITAL_UNIT;
        payload[4] = value ? 1 : 0;
    } else {
        payload[2] = 1;
        payload[3] = input.unit;
        payload.writeInt32LE(Math.round(value * 10 ** COE_UNITS[input.unit].decimals), 4);
    }
    return payload;
}

// CoE V2 header: version 2.0, total length in bytes, number of payloads
function coePacket(payloads) {
    const header = Buffer.from([2, 0, 4 + 8 * payloads.length, payloads.length]);
    return Buffer.concat([header, ...payloads]);
}

function isSessionError(err) {
    return SESSION_ERROR_STATUS.includes(err.response?.status);
}

function looksLikeValue(text) {
    return text === 'EIN' || text === 'AUS' || /^-?\d+(\.\d+)?\s*(°C|%|ppm|V)$/.test(text);
}

function roleForUnit(unit) {
    return unit === '°C' ? 'value.temperature' : unit === 'V' ? 'value.voltage' : 'value';
}

// Local time as "2026-10-12 08:58:25", the format the CMI portal expects
function formatDateTime(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseValue(text) {
    if (text === 'EIN' || text === 'AUS') {
        return { type: 'boolean', role: 'indicator', val: text === 'EIN' };
    }
    // Number with optional unit, e.g. "21.5 °C", "12.0 %", "0.00 V"
    const match = /^(-?\d+(?:\.\d+)?)\s*([^\d\s:.]\S*)?$/.exec(text);
    if (match) {
        const unit = match[2] || '';
        return { type: 'number', role: roleForUnit(unit), unit, val: parseFloat(match[1]) };
    }
    return { type: 'string', role: 'text', val: text };
}

// "Anforderung Kühlen" -> "anforderung_kuehlen" (must stay stable, existing state ids depend on it)
function toStateId(label) {
    const umlauts = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
    return label
        .toLowerCase()
        .replace(/[äöüß]/g, ch => umlauts[ch])
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, '_');
}

if (require.main !== module) {
    module.exports = options => new RbeHeatingControl(options);
} else {
    new RbeHeatingControl();
}
