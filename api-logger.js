/**
 * API Logger Module
 * Tracks all API calls for monitoring and debugging
 */

class ApiLogger {
    constructor() {
        this.logs = [];
        this.maxLogs = 100; // Keep last 100 logs in memory
    }

    /**
     * Log an API call
     * @param {Object} options Log options
     * @param {string} options.provider - API provider (openai, gemini, assemblyai)
     * @param {string} options.model - Model used (gpt-4o, gemini-2.0-flash, etc.)
     * @param {string} options.action - Action performed (transcribe, correct, refine)
     * @param {number} options.duration - Duration in milliseconds
     * @param {number} options.inputTokens - Estimated input tokens (optional)
     * @param {number} options.outputTokens - Estimated output tokens (optional)
     * @param {boolean} options.success - Whether the call succeeded
     * @param {string} options.error - Error message if failed (optional)
     */
    log(options) {
        const logEntry = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            timestamp: new Date().toISOString(),
            provider: options.provider || 'unknown',
            model: options.model || 'unknown',
            action: options.action || 'unknown',
            duration: options.duration || 0,
            inputTokens: options.inputTokens || null,
            outputTokens: options.outputTokens || null,
            success: options.success !== false,
            error: options.error || null
        };

        this.logs.unshift(logEntry);

        // Keep only the last maxLogs entries
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(0, this.maxLogs);
        }

        // Also log to console for debugging
        console.log(`[API Log] ${logEntry.provider}/${logEntry.model} - ${logEntry.action} (${logEntry.duration}ms) ${logEntry.success ? '✓' : '✗'}`);

        return logEntry;
    }

    /**
     * Get all logs
     * @returns {Array} Array of log entries
     */
    getLogs() {
        return this.logs;
    }

    /**
     * Get logs summary statistics
     * @returns {Object} Summary stats
     */
    getStats() {
        const stats = {
            totalCalls: this.logs.length,
            successCount: this.logs.filter(l => l.success).length,
            failureCount: this.logs.filter(l => !l.success).length,
            byProvider: {},
            byModel: {},
            byAction: {},
            avgDuration: 0
        };

        let totalDuration = 0;

        this.logs.forEach(log => {
            // By provider
            if (!stats.byProvider[log.provider]) {
                stats.byProvider[log.provider] = { count: 0, success: 0, failed: 0 };
            }
            stats.byProvider[log.provider].count++;
            if (log.success) stats.byProvider[log.provider].success++;
            else stats.byProvider[log.provider].failed++;

            // By model
            if (!stats.byModel[log.model]) {
                stats.byModel[log.model] = { count: 0, provider: log.provider };
            }
            stats.byModel[log.model].count++;

            // By action
            if (!stats.byAction[log.action]) {
                stats.byAction[log.action] = 0;
            }
            stats.byAction[log.action]++;

            totalDuration += log.duration;
        });

        stats.avgDuration = this.logs.length > 0 ? Math.round(totalDuration / this.logs.length) : 0;

        return stats;
    }

    /**
     * Clear all logs
     */
    clear() {
        this.logs = [];
    }
}

// Singleton instance
const apiLogger = new ApiLogger();

module.exports = apiLogger;
