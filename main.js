/**
 * Main script for SET (Standard Effective Temperature) calculations
 * Manages Web Worker communication and coordinates with the UI
 */

/**
 * SETCalculator class - manages Web Worker for SET calculations
 */
export class SETCalculator {
    constructor() {
        this.worker = null;
        this.isReady = false;
        this.pendingRequests = new Map();
        this.requestIdCounter = 0;
    }

    /**
     * Initialize the Web Worker
     * @returns {Promise<void>} Resolves when worker is ready
     */
    async init() {
        return new Promise((resolve, reject) => {
            try {
                // Create worker with module type for ES6 imports
                this.worker = new Worker(
                    new URL('./worker.js', import.meta.url),
                    { type: 'module' }
                );

                this.worker.onmessage = (event) => {
                    this.handleMessage(event);
                };

                this.worker.onerror = (error) => {
                    console.error('Worker error:', error);
                    reject(error);
                };

                // Wait for WORKER_READY message
                const readyHandler = (event) => {
                    if (event.data.type === 'WORKER_READY') {
                        this.isReady = true;
                        this.worker.removeEventListener('message', readyHandler);
                        console.log('SET Worker initialized successfully');
                        resolve();
                    }
                };
                this.worker.addEventListener('message', readyHandler);

                // Timeout if worker doesn't respond
                setTimeout(() => {
                    if (!this.isReady) {
                        reject(new Error('Worker initialization timeout'));
                    }
                }, 5000);

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Handle messages from worker
     */
    handleMessage(event) {
        const { type, requestId, payload } = event.data;

        // Handle responses to pending requests
        if (requestId !== undefined && this.pendingRequests.has(requestId)) {
            const { resolve, reject } = this.pendingRequests.get(requestId);
            this.pendingRequests.delete(requestId);

            if (type === 'SET_RESULT') {
                resolve(payload);
            } else if (type === 'SET_ERROR') {
                reject(new Error(payload.error));
            } else {
                resolve({ type, payload });
            }
        }
    }

    /**
     * Send a request to the worker and wait for response
     * @param {string} type - Message type
     * @param {Object} payload - Message payload
     * @returns {Promise<Object>} Worker response
     */
    async sendRequest(type, payload) {
        if (!this.isReady) {
            throw new Error('Worker not initialized. Call init() first.');
        }

        return new Promise((resolve, reject) => {
            const requestId = ++this.requestIdCounter;

            this.pendingRequests.set(requestId, { resolve, reject });

            this.worker.postMessage({
                type,
                requestId,
                payload
            });

            // Timeout for long calculations
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 30000); // 30 second timeout
        });
    }

    /**
     * Calculate SET for an array of velocity values
     * @param {number[]} velocities - Array of velocity values (m/s)
     * @param {number} tdb - Air temperature (°C)
     * @param {number} rh - Relative humidity (%)
     * @param {Object} options - Optional parameters
     * @param {number} options.met - Metabolic rate (default: 1.1)
     * @param {number} options.clo - Clothing insulation (default: 0.6)
     * @returns {Promise<Object>} SET calculation results
     */
    async calculateSET(velocities, tdb, rh, options = {}) {
        const { met = 1.1, clo = 0.6 } = options;

        const result = await this.sendRequest('CALCULATE_SET', {
            velocities,
            tdb,
            rh,
            met,
            clo
        });

        return result;
    }

    /**
     * Terminate the worker
     */
    terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.isReady = false;
            console.log('SET Worker terminated');
        }
    }
}

/**
 * Extract grid points from velocity data
 * @param {Float32Array} velocityData - Full velocity data array
 * @param {number} dataWidth - Width of the data
 * @param {number} dataHeight - Height of the data
 * @param {number} gridSize - Target grid size (e.g., 1000 points)
 * @returns {Object} Grid data with velocities and positions
 */
export function extractGridPoints(velocityData, dataWidth, dataHeight, gridSize = 1000) {
    // Calculate grid dimensions (approximately square)
    const aspectRatio = dataWidth / dataHeight;
    const gridY = Math.floor(Math.sqrt(gridSize / aspectRatio));
    const gridX = Math.floor(gridSize / gridY);
    const actualPoints = gridX * gridY;

    const stepX = dataWidth / gridX;
    const stepY = dataHeight / gridY;

    const velocities = new Float32Array(actualPoints);
    const positions = new Array(actualPoints);

    let idx = 0;
    for (let j = 0; j < gridY; j++) {
        for (let i = 0; i < gridX; i++) {
            const dataX = Math.floor(i * stepX + stepX / 2);
            const dataY = Math.floor(j * stepY + stepY / 2);
            const dataIdx = dataY * dataWidth + dataX;

            velocities[idx] = velocityData[dataIdx] || 0.1;
            positions[idx] = { x: dataX, y: dataY, gridX: i, gridY: j };
            idx++;
        }
    }

    return {
        velocities: Array.from(velocities),
        positions,
        gridX,
        gridY,
        actualPoints
    };
}

/**
 * Interpolate SET grid to full resolution
 * @param {number[]} setValues - SET values from grid calculation
 * @param {number} gridX - Grid width
 * @param {number} gridY - Grid height
 * @param {number} targetWidth - Target output width
 * @param {number} targetHeight - Target output height
 * @returns {Float32Array} Full resolution SET data
 */
export function interpolateSETGrid(setValues, gridX, gridY, targetWidth, targetHeight) {
    const result = new Float32Array(targetWidth * targetHeight);

    const scaleX = gridX / targetWidth;
    const scaleY = gridY / targetHeight;

    for (let j = 0; j < targetHeight; j++) {
        for (let i = 0; i < targetWidth; i++) {
            // Find the grid cell this pixel falls into
            const gx = i * scaleX;
            const gy = j * scaleY;

            // Bilinear interpolation
            const gx0 = Math.floor(gx);
            const gy0 = Math.floor(gy);
            const gx1 = Math.min(gx0 + 1, gridX - 1);
            const gy1 = Math.min(gy0 + 1, gridY - 1);

            const fx = gx - gx0;
            const fy = gy - gy0;

            const v00 = setValues[gy0 * gridX + gx0] || 0;
            const v10 = setValues[gy0 * gridX + gx1] || 0;
            const v01 = setValues[gy1 * gridX + gx0] || 0;
            const v11 = setValues[gy1 * gridX + gx1] || 0;

            // Bilinear interpolation
            const v0 = v00 * (1 - fx) + v10 * fx;
            const v1 = v01 * (1 - fx) + v11 * fx;
            result[j * targetWidth + i] = v0 * (1 - fy) + v1 * fy;
        }
    }

    return result;
}

/**
 * Demo/test function - logs results to console
 */
export async function runSETDemo() {
    console.log('Starting SET calculation demo...');

    const calculator = new SETCalculator();

    try {
        await calculator.init();

        // Generate 1000 sample velocity values (simulating jet flow)
        const velocities = [];
        for (let i = 0; i < 1000; i++) {
            // Simulate varying velocities from 0.1 to 3.0 m/s
            velocities.push(0.1 + Math.random() * 2.9);
        }

        console.log('Sending 1000 velocity points to worker...');
        console.log('Sample velocities:', velocities.slice(0, 5));

        // Calculate SET with office defaults
        const result = await calculator.calculateSET(
            velocities,
            26,     // tdb: 26°C (air temperature)
            50,     // rh: 50% relative humidity
            {
                met: 1.1,   // Seated activity
                clo: 0.6    // Summer office clothing
            }
        );

        console.log('SET Calculation Results:');
        console.log(`  Points calculated: ${result.pointCount}`);
        console.log(`  Calculation time: ${result.calculationTime.toFixed(2)} ms`);
        console.log(`  Sample SET values: ${result.setValues.slice(0, 5).map(v => v.toFixed(2)).join(', ')}°C`);

        // Calculate statistics
        const setValues = result.setValues;
        const minSET = Math.min(...setValues);
        const maxSET = Math.max(...setValues);
        const avgSET = setValues.reduce((a, b) => a + b, 0) / setValues.length;

        console.log(`  Min SET: ${minSET.toFixed(2)}°C`);
        console.log(`  Max SET: ${maxSET.toFixed(2)}°C`);
        console.log(`  Avg SET: ${avgSET.toFixed(2)}°C`);

        return result;

    } catch (error) {
        console.error('SET calculation error:', error);
        throw error;
    } finally {
        calculator.terminate();
    }
}

// Export for use in HTML/bundler
export default SETCalculator;
