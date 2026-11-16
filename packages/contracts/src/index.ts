/** Public operational responses only. No database entities or secrets. */
export interface HealthResponse { status: 'ok'; service: 'modulyn-api' }
export interface ReadinessResponse { status: 'ready'; database: 'up' }
