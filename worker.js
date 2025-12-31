/**
 * Web Worker for Standard Effective Temperature (SET) calculations
 * Uses jsthermalcomfort library for thermal comfort calculations
 * Runs calculations off the main thread for better UI responsiveness
 */

import { set } from 'jsthermalcomfort';

/**
 * Calculate SET for an array of velocity values
 * @param {Object} params - Calculation parameters
 * @param {number[]} params.velocities - Array of air velocity values (m/s)
 * @param {number} params.tdb - Dry bulb (air) temperature (°C)
 * @param {number} params.tr - Mean radiant temperature (°C)
 * @param {number} params.rh - Relative humidity (%)
 * @param {number} params.met - Metabolic rate (met)
 * @param {number} params.clo - Clothing insulation (clo)
 * @returns {number[]} Array of SET values (°C)
 */
function calculateSETArray(params) {
    const { velocities, tdb, tr, rh, met, clo } = params;
    const results = new Float32Array(velocities.length);

    for (let i = 0; i < velocities.length; i++) {
        const v = Math.max(velocities[i], 0.1); // Minimum velocity for SET calculation

        try {
            // Calculate SET using jsthermalcomfort library
            // set(tdb, tr, v, rh, met, clo, wme=0, body_surface_area, p_atm, ...)
            const setResult = set(tdb, tr, v, rh, met, clo);
            results[i] = setResult;
        } catch (error) {
            // If calculation fails, use air temperature as fallback
            results[i] = tdb;
        }
    }

    return results;
}

/**
 * Handle messages from main thread
 */
self.onmessage = function(event) {
    const { type, payload, requestId } = event.data;

    switch (type) {
        case 'CALCULATE_SET':
            try {
                const {
                    velocities,
                    tdb,
                    rh,
                    met = 1.1,      // Default: Seated activity
                    clo = 0.6       // Default: Summer office clothing
                } = payload;

                // Mean radiant temperature same as air temperature
                const tr = tdb;

                const startTime = performance.now();

                // Perform SET calculations
                const setValues = calculateSETArray({
                    velocities,
                    tdb,
                    tr,
                    rh,
                    met,
                    clo
                });

                const endTime = performance.now();
                const calculationTime = endTime - startTime;

                // Send results back to main thread
                self.postMessage({
                    type: 'SET_RESULT',
                    requestId,
                    payload: {
                        setValues: Array.from(setValues),
                        calculationTime,
                        pointCount: velocities.length
                    }
                });
            } catch (error) {
                self.postMessage({
                    type: 'SET_ERROR',
                    requestId,
                    payload: {
                        error: error.message
                    }
                });
            }
            break;

        case 'PING':
            // Health check
            self.postMessage({
                type: 'PONG',
                requestId
            });
            break;

        default:
            self.postMessage({
                type: 'UNKNOWN_MESSAGE',
                requestId,
                payload: { receivedType: type }
            });
    }
};

// Notify main thread that worker is ready
self.postMessage({ type: 'WORKER_READY' });
