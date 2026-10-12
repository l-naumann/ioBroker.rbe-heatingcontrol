'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

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
    }

    async onReady() {
        const { cmiName, email, password } = this.config;
        if (!cmiName || !email || !password) {
            this.log.error('CMI name, email and password are required in adapter configuration');
            return;
        }

        this.baseUrl = `https://${cmiName}.cmi.ta.co.at/webi`;
        this.pollInterval = Math.max(MIN_POLL_INTERVAL, Number(this.config.pollInterval) || 0);
        const pollSetback = this.config.pollSetback !== false;

        // Schematic pages of the CMI web interface:
        // 'controls' = setpoints, 'setback' = night setback indicator, 'sensors' = label/value pairs
        this.pages = [
            { file: 4, type: 'controls' },
            ...(pollSetback ? [{ file: 1, type: 'setback' }] : []),
            { file: 12, type: 'sensors' },
            { file: 13, type: 'sensors' },
        ];

        await this.cleanupObjects(pollSetback);
        await this.setStateAsync('info.connection', false, true);
        this.subscribeStates('controls.*');
        await this.login();
    }

    // Remove controls of older versions (controls.posX, controls.posX_changeAddr) and the disabled setback state
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
            await this.poll();
        } catch (err) {
            const delay = Math.min(LOGIN_RETRY_MAX, LOGIN_RETRY_BASE * 2 ** this.loginAttempts++);
            this.log.error(`Login failed: ${err.message} - retrying in ${delay / 1000} s`);
            await this.setStateAsync('info.connection', false, true);
            this.schedule(() => this.login(), delay);
        }
    }

    async relogin() {
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

    async writeState(id, common, val) {
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
        await this.setStateAsync(id, val, true);
    }

    async onStateChange(id, state) {
        if (!state || state.ack || state.val === null || state.val === undefined) {
            return;
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
        callback();
    }
}

function isSessionError(err) {
    return SESSION_ERROR_STATUS.includes(err.response?.status);
}

function looksLikeValue(text) {
    return text === 'EIN' || text === 'AUS' || /^-?\d+(\.\d+)?\s*(°C|%|ppm|V)$/.test(text);
}

function parseValue(text) {
    if (text === 'EIN' || text === 'AUS') {
        return { type: 'boolean', role: 'indicator', val: text === 'EIN' };
    }
    // Number with optional unit, e.g. "21.5 °C", "12.0 %", "0.00 V"
    const match = /^(-?\d+(?:\.\d+)?)\s*([^\d\s:.]\S*)?$/.exec(text);
    if (match) {
        const unit = match[2] || '';
        const role = unit === '°C' ? 'value.temperature' : unit === 'V' ? 'value.voltage' : 'value';
        return { type: 'number', role, unit, val: parseFloat(match[1]) };
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
