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
        this.loginRetries = 0;
        this.isPolling = false;
    }

    async onReady() {
        this.log.info('CMI adapter starting...');
        
        try {
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
            
            // Delay startup to prevent resource conflicts during installation
            this.log.info('Delaying startup by 10 seconds to prevent resource conflicts...');
            setTimeout(() => {
                this.login().catch(err => {
                    this.log.error(`Startup error: ${err.message}`);
                });
            }, 10000);
            
        } catch (error) {
            this.log.error(`Error in onReady: ${error.message}`);
        }
    }

    async login() {
        try {
            this.log.info('Attempting to login to CMI portal...');
            
            const response = await axios({
                method: 'POST',
                url: 'https://cmi.ta.co.at/portal/checkLogin.inc.php?mode=ta',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Origin': 'https://cmi.ta.co.at',
                    'Referer': 'https://cmi.ta.co.at/portal/ta/loginformular/'
                },
                data: `username=${encodeURIComponent(this.config.email)}&passwort=${encodeURIComponent(this.config.password)}&remember=on`,
                jar: this.cookieJar,
                withCredentials: true,
                maxRedirects: 5,
                timeout: 15000
            });

            // Extract PHPSESSID from cookies
            const cookies = this.cookieJar.getCookiesSync('https://cmi.ta.co.at');
            const sessionCookie = cookies.find(cookie => cookie.key === 'PHPSESSID');
            
            if (sessionCookie) {
                this.sessionId = sessionCookie.value;
                this.loginRetries = 0; // Reset retry counter on success
                this.log.info('Successfully logged in to CMI portal');
                await this.setStateAsync('info.connection', true, true);
                
                // Start polling with delay
                setTimeout(() => {
                    this.startPolling();
                }, 5000);
            } else {
                throw new Error('No session cookie received');
            }
            
        } catch (error) {
            this.log.error(`Login error: ${error.message}`);
            await this.setStateAsync('info.connection', false, true);
            
            // Exponential backoff for retries
            const maxRetries = 5;
            if (this.loginRetries < maxRetries) {
                const retryDelay = Math.min(300000, Math.pow(2, this.loginRetries) * 30000);
                this.loginRetries++;
                
                this.log.info(`Retrying login in ${retryDelay/1000} seconds (attempt ${this.loginRetries}/${maxRetries})`);
                this.pollTimeout = setTimeout(() => {
                    this.login().catch(err => {
                        this.log.error(`Retry login error: ${err.message}`);
                    });
                }, retryDelay);
            } else {
                this.log.error('Max login retries reached. Adapter will stop.');
            }
        }
    }

    startPolling() {
        if (this.isPolling) {
            this.log.debug('Polling already active');
            return;
        }
        
        this.log.debug('Starting data polling...');
        this.pollData();
    }

    async pollData() {
        if (this.isPolling) {
            this.log.debug('Polling already in progress, skipping...');
            return;
        }
        
        if (!this.sessionId) {
            this.log.warn('No session ID available, attempting to login again');
            this.login().catch(err => {
                this.log.error(`Login error in pollData: ${err.message}`);
            });
            return;
        }
        
        this.isPolling = true;

        try {
            const timestamp = Date.now();
            const url = `https://${this.cmiHost}/webi/schematic_files/1.cgi?_=${timestamp}`;
            
            this.log.debug(`Polling data from: ${url}`);
            
            const response = await axios({
                method: 'GET',
                url: url,
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html, */*; q=0.01',
                    'Referer': `https://${this.cmiHost}/webi/schema.html`,
                    'Cookie': `PHPSESSID=${this.sessionId}`
                },
                timeout: 15000
            });

            await this.parseAndUpdateStates(response.data);
            
        } catch (error) {
            this.log.error(`Polling error: ${error.message}`);
            
            // If unauthorized, try to login again
            if (error.response && (error.response.status === 401 || error.response.status === 403)) {
                this.log.warn('Session expired, attempting to login again');
                this.sessionId = null;
                await this.setStateAsync('info.connection', false, true);
                setTimeout(() => {
                    this.login().catch(err => {
                        this.log.error(`Re-login error: ${err.message}`);
                    });
                }, 2000);
                this.isPolling = false;
                return;
            }
        }

        // Schedule next poll with minimum interval
        this.isPolling = false;
        const pollInterval = Math.max(60000, this.config.pollInterval || 60000); // Minimum 1 minute
        this.pollTimeout = setTimeout(() => {
            this.pollData().catch(err => {
                this.log.error(`Scheduled polling error: ${err.message}`);
                this.isPolling = false;
            });
        }, pollInterval);
    }

    async parseAndUpdateStates(htmlData) {
        if (!htmlData || htmlData.length === 0) {
            this.log.warn('Received empty HTML data');
            return;
        }

        try {
            const $ = cheerio.load(htmlData);
            const operations = [];
            
            // Find all position elements but limit to reasonable amount
            const elements = $('div[id^="pos"]').get();
            const maxElements = Math.min(elements.length, 50); // Limit processing
            
            this.log.debug(`Processing ${maxElements} of ${elements.length} elements`);
            
            for (let i = 0; i < maxElements; i++) {
                try {
                    const element = elements[i];
                    const $element = $(element);
                    const id = $element.attr('id');
                    
                    if (!id) continue;
                    
                    // Process text content values
                    const textContent = $element.text().trim();
                    if (textContent && textContent.length > 0 && textContent.length < 100 && !textContent.includes('onClick')) {
                        const cleanText = textContent.replace(/[°C]/g, '').trim();
                        const numericValue = parseFloat(cleanText);
                        
                        if (!isNaN(numericValue) && numericValue !== 0) {
                            operations.push({
                                path: `values.${id}`,
                                config: {
                                    type: 'number',
                                    role: 'value',
                                    name: `Value ${id}`,
                                    read: true,
                                    write: false,
                                    unit: textContent.includes('°C') ? '°C' : ''
                                },
                                value: numericValue
                            });
                        } else if (textContent.length < 30 && textContent.length > 1) {
                            operations.push({
                                path: `values.${id}`,
                                config: {
                                    type: 'string',
                                    role: 'text',
                                    name: `Text ${id}`,
                                    read: true,
                                    write: false
                                },
                                value: textContent
                            });
                        }
                    }
                    
                    // Process controllable elements
                    if ($element.hasClass('pm_element')) {
                        const value = $element.attr('pme_value');
                        const min = $element.attr('pme_min');
                        const max = $element.attr('pme_max');
                        const changeAddr = $element.attr('pme_changeadr');
                        
                        if (value && changeAddr && !isNaN(parseFloat(value))) {
                            operations.push({
                                path: `controls.${id}`,
                                config: {
                                    type: 'number',
                                    role: 'level',
                                    name: `Control ${id}`,
                                    read: true,
                                    write: true,
                                    min: min ? parseFloat(min) : undefined,
                                    max: max ? parseFloat(max) : undefined,
                                    unit: '°C'
                                },
                                value: parseFloat(value)
                            });
                            
                            // Store change address separately
                            operations.push({
                                path: `controls.${id}_changeAddr`,
                                value: changeAddr,
                                simple: true
                            });
                        }
                    }
                    
                    // Process status elements
                    const visibleClass = $element.attr('class');
                    if (visibleClass && visibleClass.includes('visible')) {
                        const visibleMatch = visibleClass.match(/visible(\d+)/);
                        if (visibleMatch) {
                            operations.push({
                                path: `status.${id}`,
                                config: {
                                    type: 'number',
                                    role: 'indicator',
                                    name: `Status ${id}`,
                                    read: true,
                                    write: false
                                },
                                value: parseInt(visibleMatch[1])
                            });
                        }
                    }
                } catch (elementError) {
                    this.log.debug(`Error processing element ${i}: ${elementError.message}`);
                }
            }
            
            // Process operations in small batches
            const batchSize = 3;
            let processed = 0;
            
            for (let i = 0; i < operations.length; i += batchSize) {
                const batch = operations.slice(i, i + batchSize);
                
                const results = await Promise.allSettled(batch.map(async (op) => {
                    if (op.simple) {
                        await this.setStateAsync(op.path, op.value, true);
                    } else {
                        await this.createAndSetState(op.path, op.config, op.value);
                    }
                }));
                
                processed += results.filter(r => r.status === 'fulfilled').length;
                
                // Short delay between batches
                if (i + batchSize < operations.length) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
            
            this.log.debug(`Processed ${processed}/${operations.length} state operations`);
            
        } catch (error) {
            this.log.error(`Error parsing HTML: ${error.message}`);
        }
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
            this.log.warn(`Error with state ${statePath}: ${error.message}`);
        }
    }

    async onStateChange(id, state) {
        if (state && !state.ack && state.val !== null && state.val !== undefined) {
            this.log.debug(`State changed: ${id} = ${state.val}`);
            
            // Handle control state changes
            if (id.includes('controls.') && !id.includes('_changeAddr')) {
                const controlId = id.split('.').pop();
                
                try {
                    const changeAddrState = await this.getStateAsync(`controls.${controlId}_changeAddr`);
                    if (changeAddrState && changeAddrState.val) {
                        await this.sendControlValue(changeAddrState.val, state.val);
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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    'Referer': `https://${this.cmiHost}/webi/schema.html`,
                    'Cookie': `PHPSESSID=${this.sessionId}`
                },
                timeout: 10000
            });
            
            this.log.info(`Control value sent successfully`);
            
        } catch (error) {
            this.log.error(`Error sending control value: ${error.message}`);
            
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
            
            this.isPolling = false;
            this.log.info('CMI adapter stopped cleanly');
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new CmiAdapter(options);
} else {
    new CmiAdapter();
}