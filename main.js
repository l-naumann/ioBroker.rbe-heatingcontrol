const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');
const tough = require('tough-cookie');

class CmiAdapter extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'cmi',
        });
        
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        
        this.cookieJar = new tough.CookieJar();
        this.pollTimeout = null;
        this.sessionId = null;
        this.cmiHost = null;
    }

    async onReady() {
        this.log.info('CMI adapter starting...');
        
        // Validate configuration
        if (!this.config.cmiName || !this.config.email || !this.config.password) {
            this.log.error('CMI name, email and password are required in adapter configuration');
            return;
        }
        
        this.cmiHost = `${this.config.cmiName}.cmi.ta.co.at`;
        
        // Set connection state to false initially
        await this.setStateAsync('info.connection', false, true);
        
        // Subscribe to state changes for writable states
        this.subscribeStates('*');
        
        // Start login and polling
        await this.login();
    }

    async login() {
        try {
            this.log.info('Attempting to login to CMI portal...');
            
            const response = await axios({
                method: 'POST',
                url: 'https://cmi.ta.co.at/portal/checkLogin.inc.php?mode=ta',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Origin': 'https://cmi.ta.co.at',
                    'Referer': 'https://cmi.ta.co.at/portal/ta/loginformular/'
                },
                data: `username=${encodeURIComponent(this.config.email)}&passwort=${encodeURIComponent(this.config.password)}&remember=on`,
                jar: this.cookieJar,
                withCredentials: true,
                maxRedirects: 5
            });

            // Extract PHPSESSID from cookies
            const cookies = this.cookieJar.getCookiesSync('https://cmi.ta.co.at');
            const sessionCookie = cookies.find(cookie => cookie.key === 'PHPSESSID');
            
            if (sessionCookie) {
                this.sessionId = sessionCookie.value;
                this.log.info('Successfully logged in to CMI portal');
                await this.setStateAsync('info.connection', true, true);
                
                // Start polling
                this.startPolling();
            } else {
                this.log.error('Login failed - no session cookie received');
                await this.setStateAsync('info.connection', false, true);
                // Retry login in 5 minutes
                this.pollTimeout = setTimeout(() => this.login(), 300000);
            }
            
        } catch (error) {
            this.log.error(`Login error: ${error.message}`);
            await this.setStateAsync('info.connection', false, true);
            // Retry login in 5 minutes
            this.pollTimeout = setTimeout(() => this.login(), 300000);
        }
    }

    startPolling() {
        this.log.debug('Starting polling...');
        this.pollData();
    }

    async pollData() {
        if (!this.sessionId) {
            this.log.warn('No session ID available, attempting to login again');
            await this.login();
            return;
        }

        try {
            const timestamp = Date.now();
            const url = `https://${this.cmiHost}/webi/schematic_files/1.cgi?_=${timestamp}`;
            
            this.log.debug(`Polling data from: ${url}`);
            
            const response = await axios({
                method: 'GET',
                url: url,
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                    'Accept': 'text/html, */*; q=0.01',
                    'Referer': `https://${this.cmiHost}/webi/schema.html`,
                    'Cookie': `PHPSESSID=${this.sessionId}`
                },
                timeout: 10000
            });

            await this.parseAndUpdateStates(response.data);
            
        } catch (error) {
            this.log.error(`Polling error: ${error.message}`);
            
            // If unauthorized, try to login again
            if (error.response && error.response.status === 401) {
                this.log.warn('Session expired, attempting to login again');
                this.sessionId = null;
                await this.setStateAsync('info.connection', false, true);
                await this.login();
                return;
            }
        }

        // Schedule next poll
        const pollInterval = this.config.pollInterval || 30000;
        this.pollTimeout = setTimeout(() => this.pollData(), pollInterval);
    }

    async parseAndUpdateStates(htmlData) {
        const $ = cheerio.load(htmlData);
        
        $('div[id^="pos"]').each(async (index, element) => {
            const $element = $(element);
            const id = $element.attr('id');
            
            // Extract readable values from elements with text content
            const textContent = $element.text().trim();
            if (textContent && !textContent.includes('onClick') && textContent.length > 0) {
                // Clean up text content (remove special characters, normalize)
                const cleanText = textContent.replace(/[°C]/g, '').trim();
                
                // Check if it's a numeric value
                const numericValue = parseFloat(cleanText);
                if (!isNaN(numericValue)) {
                    await this.createAndSetState(`values.${id}`, {
                        type: 'number',
                        role: 'value',
                        name: `Value ${id}`,
                        read: true,
                        write: false,
                        unit: textContent.includes('°C') ? '°C' : ''
                    }, numericValue);
                } else if (textContent.length < 50) { // Avoid very long texts
                    await this.createAndSetState(`values.${id}`, {
                        type: 'string',
                        role: 'text',
                        name: `Text ${id}`,
                        read: true,
                        write: false
                    }, textContent);
                }
            }
            
            // Extract controllable elements (pm_element)
            if ($element.hasClass('pm_element')) {
                const value = $element.attr('pme_value');
                const min = $element.attr('pme_min');
                const max = $element.attr('pme_max');
                const changeAddr = $element.attr('pme_changeadr');
                
                if (value && changeAddr) {
                    await this.createAndSetState(`controls.${id}`, {
                        type: 'number',
                        role: 'level',
                        name: `Control ${id}`,
                        read: true,
                        write: true,
                        min: min ? parseFloat(min) : undefined,
                        max: max ? parseFloat(max) : undefined,
                        unit: '°C'
                    }, parseFloat(value));
                    
                    // Store change address for later use
                    await this.setStateAsync(`controls.${id}_changeAddr`, changeAddr, true);
                }
            }
            
            // Extract visible state elements
            const visibleClass = $element.attr('class');
            if (visibleClass && visibleClass.includes('visible')) {
                const visibleMatch = visibleClass.match(/visible(\d+)/);
                if (visibleMatch) {
                    const visibleValue = parseInt(visibleMatch[1]);
                    await this.createAndSetState(`status.${id}`, {
                        type: 'number',
                        role: 'indicator',
                        name: `Status ${id}`,
                        read: true,
                        write: false
                    }, visibleValue);
                }
            }
        });
        
        this.log.debug('Data parsing and state updates completed');
    }

    async createAndSetState(statePath, common, value) {
        try {
            await this.setObjectNotExistsAsync(statePath, {
                type: 'state',
                common: common,
                native: {}
            });
            
            await this.setStateAsync(statePath, value, true);
        } catch (error) {
            this.log.error(`Error creating/setting state ${statePath}: ${error.message}`);
        }
    }

    async onStateChange(id, state) {
        if (state && !state.ack) {
            this.log.debug(`State changed: ${id} = ${state.val}`);
            
            // Handle control state changes
            if (id.includes('controls.') && !id.includes('_changeAddr')) {
                const controlId = id.split('.').pop();
                
                try {
                    // Get the change address for this control
                    const changeAddrState = await this.getStateAsync(`controls.${controlId}_changeAddr`);
                    if (changeAddrState && changeAddrState.val) {
                        await this.sendControlValue(changeAddrState.val, state.val);
                        
                        // Acknowledge the state change
                        await this.setStateAsync(id, state.val, true);
                    } else {
                        this.log.warn(`No change address found for control ${controlId}`);
                    }
                } catch (error) {
                    this.log.error(`Error handling control change for ${id}: ${error.message}`);
                }
            }
        }
    }

    async sendControlValue(changeAddr, value) {
        if (!this.sessionId) {
            this.log.error('No session available for sending control value');
            return;
        }

        try {
            const timestamp = Date.now();
            const url = `https://${this.cmiHost}/webi/INCLUDE/change.cgi?changeadrx2=${changeAddr}&changetox2=${value}&_=${timestamp}`;
            
            this.log.info(`Sending control value: ${value} to address: ${changeAddr}`);
            
            const response = await axios({
                method: 'GET',
                url: url,
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Referer': `https://${this.cmiHost}/webi/schema.html`,
                    'Cookie': `PHPSESSID=${this.sessionId}`
                },
                timeout: 10000
            });
            
            this.log.info(`Control value sent successfully: ${response.data}`);
            
        } catch (error) {
            this.log.error(`Error sending control value: ${error.message}`);
            
            // If unauthorized, mark session as invalid
            if (error.response && error.response.status === 401) {
                this.sessionId = null;
                await this.setStateAsync('info.connection', false, true);
            }
        }
    }

    onUnload(callback) {
        try {
            if (this.pollTimeout) {
                clearTimeout(this.pollTimeout);
                this.pollTimeout = null;
            }
            
            this.log.info('CMI adapter stopped');
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new CmiAdapter(options);
} else {
    // otherwise start the instance directly
    new CmiAdapter();
}