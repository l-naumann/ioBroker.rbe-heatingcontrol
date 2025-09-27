const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');
const tough = require('tough-cookie');

class CmiAdapter extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'rbe-heatingcontrol',
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
            
            // First, let's intercept redirects to catch cookies from the 302 response
            let sessionCookie = null;
            
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
                maxRedirects: 0, // Don't follow redirects automatically
                timeout: 15000,
                validateStatus: function (status) {
                    return status >= 200 && status < 400; // Accept redirects as success
                }
            });

            this.log.debug(`Login response status: ${response.status}`);
            
            // Check for cookies in the response headers (from 302 redirect)
            if (response.headers['set-cookie']) {
                this.log.debug('Found set-cookie headers in response');
                
                for (const cookieHeader of response.headers['set-cookie']) {
                    this.log.debug(`Cookie header: ${cookieHeader}`);
                    if (cookieHeader.includes('PHPSESSID')) {
                        const match = cookieHeader.match(/PHPSESSID=([^;]+)/);
                        if (match) {
                            sessionCookie = match[1];
                            this.log.debug(`Extracted session cookie: ${sessionCookie}`);
                            break;
                        }
                    }
                }
            }
            
            // Also check the cookie jar as fallback
            if (!sessionCookie) {
                this.log.debug('No cookie in headers, checking cookie jar');
                const cookies = this.cookieJar.getCookiesSync('https://cmi.ta.co.at');
                this.log.debug(`Cookie jar contains ${cookies.length} cookies`);
                
                const jarCookie = cookies.find(cookie => cookie.key === 'PHPSESSID');
                if (jarCookie) {
                    sessionCookie = jarCookie.value;
                    this.log.debug(`Found session cookie in jar: ${sessionCookie}`);
                }
            }
            
            if (sessionCookie) {
                this.sessionId = sessionCookie;
                this.loginRetries = 0; // Reset retry counter on success
                this.log.info(`Successfully logged in to CMI portal (Session: ${sessionCookie.substring(0, 8)}...)`);
                await this.setStateAsync('info.connection', true, true);
                
                // If we got a redirect (302), follow it manually to complete the login
                if (response.status === 302 && response.headers.location) {
                    this.log.debug(`Following redirect to: ${response.headers.location}`);
                    try {
                        await axios({
                            method: 'GET',
                            url: response.headers.location,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                'Cookie': `PHPSESSID=${this.sessionId}`
                            },
                            timeout: 10000
                        });
                    } catch (redirectError) {
                        this.log.warn(`Error following redirect: ${redirectError.message}`);
                    }
                }
                
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
        this.pollControlData();
        this.pollReadOnlyData();
    }

    async pollControlData() {
        if (!this.sessionId) {
            this.log.warn('No session ID available for control data polling');
            return;
        }
        
        try {
            const timestamp = Date.now();
            const url = `https://${this.cmiHost}/webi/schematic_files/1.cgi?_=${timestamp}`;
            
            this.log.debug(`Polling control data from: ${url}`);
            
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

            await this.parseAndUpdateControlStates(response.data);
            
        } catch (error) {
            this.log.error(`Control data polling error: ${error.message}`);
            await this.handlePollingError(error);
        }

        // Schedule next control data poll
        const pollInterval = Math.max(60000, this.config.pollInterval || 60000);
        setTimeout(() => {
            this.pollControlData().catch(err => {
                this.log.error(`Scheduled control polling error: ${err.message}`);
            });
        }, pollInterval);
    }

    async pollReadOnlyData() {
        if (!this.sessionId) {
            this.log.warn('No session ID available for read-only data polling');
            return;
        }
        
        try {
            const timestamp = Date.now();
            const url = `https://${this.cmiHost}/webi/schematic_files/12.cgi?_=${timestamp}`;
            
            this.log.debug(`Polling read-only data from: ${url}`);
            
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

            await this.parseAndUpdateReadOnlyStates(response.data);
            
        } catch (error) {
            this.log.error(`Read-only data polling error: ${error.message}`);
            await this.handlePollingError(error);
        }

        // Schedule next read-only data poll (can be less frequent)
        const pollInterval = Math.max(90000, (this.config.pollInterval || 60000) * 1.5);
        setTimeout(() => {
            this.pollReadOnlyData().catch(err => {
                this.log.error(`Scheduled read-only polling error: ${err.message}`);
            });
        }, pollInterval);
    }

    async handlePollingError(error) {
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
        }
    }

    async parseAndUpdateControlStates(htmlData) {
        if (!htmlData || htmlData.length === 0) {
            this.log.warn('Received empty HTML data for controls');
            return;
        }

        try {
            const $ = cheerio.load(htmlData);
            const operations = [];
            const seenChangeAddrs = new Set(); // Track seen change addresses
            
            // Find all pm_element divs with pme_changeadr
            const elements = $('div.pm_element[pme_changeadr]').get();
            
            this.log.debug(`Found ${elements.length} controllable elements`);
            
            for (let i = 0; i < elements.length; i++) {
                try {
                    const element = elements[i];
                    const $element = $(element);
                    const id = $element.attr('id');
                    const changeAddr = $element.attr('pme_changeadr');
                    
                    if (!id || !changeAddr) continue;
                    
                    // Skip if we've already seen this change address
                    if (seenChangeAddrs.has(changeAddr)) {
                        this.log.debug(`Skipping duplicate changeAddr: ${changeAddr} for element ${id}`);
                        continue;
                    }
                    seenChangeAddrs.add(changeAddr);
                    
                    const value = $element.attr('pme_value');
                    const min = $element.attr('pme_min');
                    const max = $element.attr('pme_max');
                    
                    if (value && !isNaN(parseFloat(value))) {
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
                    
                } catch (elementError) {
                    this.log.debug(`Error processing control element ${i}: ${elementError.message}`);
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
            
            this.log.debug(`Processed ${processed}/${operations.length} control state operations`);
            
        } catch (error) {
            this.log.error(`Error parsing control HTML: ${error.message}`);
        }
    }

    async parseAndUpdateReadOnlyStates(htmlData) {
        if (!htmlData || htmlData.length === 0) {
            this.log.warn('Received empty HTML data for read-only values');
            return;
        }

        try {
            const $ = cheerio.load(htmlData);
            const operations = [];
            
            // Find all position elements
            const elements = $('div[id^="pos"]').get();
            
            this.log.debug(`Found ${elements.length} read-only elements`);
            
            // Process elements in pairs (label + value)
            for (let i = 0; i < elements.length - 1; i += 2) {
                try {
                    const labelElement = elements[i];
                    const valueElement = elements[i + 1];
                    
                    const $labelElement = $(labelElement);
                    const $valueElement = $(valueElement);
                    
                    const labelText = $labelElement.text().trim();
                    const valueText = $valueElement.text().trim();
                    
                    // Skip empty labels or elements with onClick (navigation elements)
                    if (!labelText || labelText.length === 0 || 
                        $labelElement.attr('onClick') || $valueElement.attr('onClick')) {
                        continue;
                    }
                    
                    // Skip if value is empty or too long
                    if (!valueText || valueText.length === 0 || valueText.length > 50) {
                        continue;
                    }
                    
                    // Create a clean state name from the label
                    const stateName = this.createCleanStateName(labelText);
                    if (!stateName) continue;
                    
                    // Determine if the value is numeric
                    const cleanValue = valueText.replace(/[°C%]/g, '').trim();
                    const numericValue = parseFloat(cleanValue);
                    
                    let unit = '';
                    if (valueText.includes('°C')) unit = '°C';
                    else if (valueText.includes('%')) unit = '%';
                    else if (valueText.includes('ppm')) unit = 'ppm';
                    
                    if (!isNaN(numericValue)) {
                        // Numeric value
                        operations.push({
                            path: `sensors.${stateName}`,
                            config: {
                                type: 'number',
                                role: 'value.temperature', // Default role, could be refined
                                name: labelText,
                                read: true,
                                write: false,
                                unit: unit
                            },
                            value: numericValue
                        });
                    } else {
                        // Text value (like AUS, EIN, etc.)
                        operations.push({
                            path: `sensors.${stateName}`,
                            config: {
                                type: 'string',
                                role: 'text',
                                name: labelText,
                                read: true,
                                write: false
                            },
                            value: valueText
                        });
                    }
                    
                } catch (elementError) {
                    this.log.debug(`Error processing read-only element ${i}: ${elementError.message}`);
                }
            }
            
            // Process operations in small batches
            const batchSize = 5;
            let processed = 0;
            
            for (let i = 0; i < operations.length; i += batchSize) {
                const batch = operations.slice(i, i + batchSize);
                
                const results = await Promise.allSettled(batch.map(async (op) => {
                    await this.createAndSetState(op.path, op.config, op.value);
                }));
                
                processed += results.filter(r => r.status === 'fulfilled').length;
                
                // Short delay between batches
                if (i + batchSize < operations.length) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
            
            this.log.debug(`Processed ${processed}/${operations.length} read-only state operations`);
            
        } catch (error) {
            this.log.error(`Error parsing read-only HTML: ${error.message}`);
        }
    }

    createCleanStateName(labelText) {
        if (!labelText || labelText.length === 0) return null;
        
        // Remove special characters and convert to camelCase
        return labelText
            .replace(/[äöüÄÖÜß]/g, (match) => {
                const replacements = {
                    'ä': 'ae', 'ö': 'oe', 'ü': 'ue',
                    'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss'
                };
                return replacements[match] || match;
            })
            .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters except spaces
            .replace(/\s+/g, '_') // Replace spaces with underscores
            .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
            .toLowerCase();
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