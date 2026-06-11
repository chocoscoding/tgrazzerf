export function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, data?: any) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  info: (msg: string, data?: any) => log('INFO', msg, data),
  warn: (msg: string, data?: any) => log('WARN', msg, data),
  error: (msg: string, data?: any) => log('ERROR', msg, data),
  debug: (msg: string, data?: any) => log('DEBUG', msg, data),
};
